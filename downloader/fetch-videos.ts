import { getTemp, lock, move, nameExt, readSubscriptionsFile, type ChannelID, type SubscriptionFile, type VideoID } from '../util.ts';
import { parseArgs, promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, exec as execCb } from 'node:child_process';
import { getLatestVideoUrls, hasChannel, hasVideo } from './get-channel-video-ids.ts';
import { channelFromDisk, videoFromDisk } from '../scan.ts';
import { fetchMetaForChannel } from '../get-channel-meta.ts';

const execAsync = promisify(execCb);

const YT_DLP_PATH = process.env.YT_DLP_PATH ?? path.join(import.meta.dirname, '..', 'yt-dlp');

const defaultUrl = 'http://localhost:3000';

let { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    server: {
      type: 'string',
      default: defaultUrl,
    },
    tempdir: {
      type: 'string',
    },
  },
});

if (positionals.length !== 2) {
  console.log(`Usage: node fetch-videos.ts [--server=url] path-to-subscriptions.json path-to-media-dir
  --server url    server URL (default: ${defaultUrl})
  --tempdir dir   path for temporary files (default: path-to-media-dir)
                  the special value "OS_DEFAULT" will use your operating system's default

It is recommended but not required that tempdir be on the same volume as the media, to avoid needing to copy files across volumes.

This expects media-dir to be organized like:

some-channel-id/some-video-id/data.json
some-channel-id/some-video-id/video.mp4
`);
  process.exit(1);
}

let [subscriptionsFile, mediaDir] = positionals;
let { server, tempdir } = values;
if (tempdir == null) {
  // download to the same device as the ultimate destination to avoid having to do cross-device moves after downloading
  tempdir = mediaDir;
} else if (tempdir === 'OS_DEFAULT') {
  tempdir = os.tmpdir();
}

try {
  if (!fs.lstatSync(mediaDir).isDirectory()) {
    throw new Error();
  }
} catch {
  console.error(`${mediaDir} doesn't appear to be a directory`);
  process.exit(1);
}

const temps = fs.readdirSync(tempdir).filter(f => f.startsWith('tmp-localtube-'));
if (temps.length > 0) {
  console.error(`Found "tmp-localtube-" directories in ${tempdir}, which suggests downloader is already running; exiting. If this is not the case, delete any such directories and retry.`);
  process.exit(1);
}


let status = readSubscriptionsFile(subscriptionsFile);

function writeStatus() {
  fs.writeFileSync(subscriptionsFile, JSON.stringify(status, null, 2));
}


try {
  const up = await (await fetch(server + '/public-api/healthcheck')).json();
  if (up !== true) throw new Error();
} catch {
  console.error(`${server} doesn't appear to be running`);
  process.exit(1);
}

async function subscribe(channelId: ChannelID) {
  const channelDir = path.join(mediaDir, channelId);
  if (!fs.existsSync(channelDir)) {
    fs.mkdirSync(channelDir);
  }
  await addChannelIfNotExists(channelId);

  const videoIds = await getLatestVideoUrls(server, channelId, true);
  for (const videoId of videoIds) {
    await addVideoIfNotExists(channelId, videoId);
  }
}

async function updateExisting(channelId: ChannelID) {
  if (!(await hasChannel(server, channelId))) {
    throw new Error(`${channelId} is marked as subscribed but is not present in the server`);
  }
  const videoIds = await getLatestVideoUrls(server, channelId);
  for (const videoId of videoIds) {
    await addVideoIfNotExists(channelId, videoId);
  }
}

async function addChannelIfNotExists(channelId: ChannelID) {
  if (await hasChannel(server, channelId)) return;
  const channelDir = path.join(mediaDir, channelId);
  const metaFile = path.join(channelDir, 'data.json');
  if (!fs.existsSync(metaFile)) {
    await fetchMetaForChannel(mediaDir, channelId);
  }
  const channel = await channelFromDisk(mediaDir, channelId);
  try {
    const res = await fetch(server + '/public-api/add-channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(channel),
    });
    const result = await res.json();
    if (result !== true) throw result;
  } catch (e) {
    throw new Error(`failed to add channel ${channelId}: ${e instanceof Error ? e.message : e}`);
  }
}

async function addVideoIfNotExists(channelId: ChannelID, videoId: VideoID) {
  if (await hasVideo(server, videoId)) return;
  const videoDir = path.join(mediaDir, channelId, videoId);
  if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
  }
  const videoFileExists = fs.existsSync(path.join(videoDir, 'video.mp4')) || fs.existsSync(path.join(videoDir, 'video.webm'));
  const metadataFile = path.join(videoDir, 'data.json');
  const metadataExists = fs.existsSync(metadataFile);
  if (metadataExists && !videoFileExists) {
    throw new Error(`found metadata for ${channelId}/${videoId}, but no video`);
  } else if (!metadataExists && videoFileExists) {
    throw new Error(`found video for ${channelId}/${videoId}, but no data.json`);
  } else if (!metadataExists && !videoFileExists) {
    using tempDir = getTemp(tempdir);
    console.log(`fetching https://www.youtube.com/watch?v=${videoId} to ${tempDir.path}`);
    const command = [
        YT_DLP_PATH,
        '--write-info-json',
        '--write-thumbnail',
        '--write-auto-subs',
        '--write-subs',
        '--sub-langs',
        'en.*',
        '--format',
        'b',
        '--retry-sleep',
        'fragment:exp=1:20',
        '--sleep-requests',
        '10', // seconds
        '--min-sleep-interval',
        '2', // seconds
        '--max-sleep-interval',
        '5', // seconds
        '--sleep-subtitles',
        '20', // seconds
        `https://www.youtube.com/watch?v=${videoId}`,
      ].join(' ');
    console.log(`executing: ${command}`);
    // TODO option to print to stdout/s
    const result = await execAsync(
      command,
      {
        encoding: 'utf-8',
        cwd: tempDir.path,
      },
    );
    // probably we should check stderr
    // but, we're going to validate that we have the expected files anyway, so whatever

    // if (result.error) {
    //   throw result.error;
    // }
    // if (result.status !== 0) {
    //   throw new Error(`Command failed with exit code ${result.status}\nStderr: ${result.stderr}`);
    // }

    // filter out `._` files created by macOS and similar
    const files = fs.readdirSync(tempDir.path).filter(f => !f.startsWith('.'));

    // this is a little silly but I couldn't figure out how to get yt-dlp to print things in a usable way
    const json = files.filter(f => f.endsWith('.json'));
    if (json.length !== 1) {
      throw new Error(`got not exactly 1 json file after download ${JSON.stringify(json)}`);
    }
    const video = files.filter(f => f.endsWith('.webm') || f.endsWith('.mp4'));
    if (video.length !== 1) {
      throw new Error(`got not exactly 1 video file after download ${JSON.stringify(video)}`);
    }
    const thumb = files.filter(f => f.endsWith('.png') || f.endsWith('.webp') || f.endsWith('.jpg') || f.endsWith('.gif'));
    if (thumb.length !== 1) {
      throw new Error(`got not exactly 1 thumb file after download ${JSON.stringify(thumb)}`);
    }
    const subs = files.filter(f => f.endsWith('.vtt'));
    if (files.length !== subs.length + 3 /* i.e. json,video,thumb */) {
      throw new Error(`got unexpected files after download ${JSON.stringify(files)}`);
    }

    await move(path.join(tempDir.path, json[0]), path.join(videoDir, 'data.json'));
    await move(path.join(tempDir.path, video[0]), path.join(videoDir, 'video.' + nameExt(video[0]).ext));
    await move(path.join(tempDir.path, thumb[0]), path.join(videoDir, 'thumb.' + nameExt(thumb[0]).ext));
    for (const sub of subs) {
      await move(path.join(tempDir.path, sub), path.join(videoDir, 'subs.' + sub.split('.').slice(-2).join('.')));
    }
    console.log(`downloaded video ${nameExt(video[0]).name}`);
  }
  // at this point metadata + video exist, either because we just downloaded it
  // or because it already existed, possibly because we downloaded it previously but the server went down during the download

  const video = await videoFromDisk(mediaDir, channelId, videoId);
  if (video == null) {
    throw new Error(`metadata did not exist after fetching for ${channelId}/${videoId}`);
  }
  try {
    const res = await fetch(server + '/public-api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(video),
    });
    const result = await res.json();
    if (result !== true) throw result;
  } catch (e) {
    throw new Error(`failed to add video ${channelId}/${videoId}: ${e instanceof Error ? e.message : e}`);
  }
}

const subbed = new Set<ChannelID>();
let processedCount = 0;
while (status.subscribing.length > 0) {
  const channel = status.subscribing[0];
  await subscribe(channel);

  using _lockfile = await lock(subscriptionsFile);
  const freshStatus = readSubscriptionsFile(subscriptionsFile);
  const isInSubscribing = freshStatus.subscribing.includes(channel);
  const isInSubscribed = freshStatus.subscribed.includes(channel);

  if (isInSubscribing && isInSubscribed) {
    throw new Error(`Channel ${channel} found in both subscribing and subscribed lists`);
  }

  status = freshStatus;
  subbed.add(channel);
  processedCount++;

  if (!isInSubscribing || isInSubscribed) {
    continue;
  }

  status.subscribing = status.subscribing.filter(id => id !== channel);
  status.subscribed.push(channel);
  delete status.titles[channel];
  writeStatus();
}
console.log(`Performed initial fetch for ${processedCount} channels`);

for (const channel of status.subscribed) {
  if (subbed.has(channel)) continue;
  await updateExisting(channel);
}
console.log(`Updated ${status.subscribed.length - subbed.size} channels`);
