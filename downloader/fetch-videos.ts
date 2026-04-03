import { getTemp, move, nameExt, type ChannelID, type VideoID } from '../util.ts';
import { parseArgs, promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, exec as execCb } from 'node:child_process';
import { getLatestVideoUrls } from './get-channel-video-ids.ts';
import { channelFromDisk, videoFromDisk } from '../scan.ts';
import { fetchMetaForChannel } from '../get-channel-meta.ts';
import { addChannel, addVideo, isChannelInDb, isVideoInDb } from '../media-db.ts';
import { getSubscribing, getSubscribed, markSubscribed, isInSubscriptions } from '../subscriptions-db.ts';

const execAsync = promisify(execCb);

const YT_DLP_PATH = process.env.YT_DLP_PATH ?? path.join(import.meta.dirname, '..', 'yt-dlp');

let { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    tempdir: {
      type: 'string',
    },
  },
});

if (positionals.length !== 1) {
  console.log(`Usage: node fetch-videos.ts path-to-media-dir
  --tempdir dir   path for temporary files (default: path-to-media-dir)
                  the special value "OS_DEFAULT" will use your operating system's default

It is recommended but not required that tempdir be on the same volume as the media, to avoid needing to copy files across volumes.

This expects media-dir to be organized like:

some-channel-id/some-video-id/data.json
some-channel-id/some-video-id/video.mp4
`);
  process.exit(1);
}

let [mediaDir] = positionals;
let { tempdir } = values;
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


async function subscribe(channelId: ChannelID) {
  const channelDir = path.join(mediaDir, channelId);
  if (!fs.existsSync(channelDir)) {
    fs.mkdirSync(channelDir);
  }
  await addChannelIfNotExists(channelId);

  const videoIds = await getLatestVideoUrls(channelId, true);
  for (const videoId of videoIds) {
    await addVideoIfNotExists(channelId, videoId);
  }
}

async function updateExisting(channelId: ChannelID) {
  if (!isChannelInDb(channelId)) {
    throw new Error(`${channelId} is marked as subscribed but is not present in the database`);
  }
  const videoIds = await getLatestVideoUrls(channelId);
  for (const videoId of videoIds) {
    await addVideoIfNotExists(channelId, videoId);
  }
}

async function addChannelIfNotExists(channelId: ChannelID) {
  if (isChannelInDb(channelId)) return;
  const channelDir = path.join(mediaDir, channelId);
  const metaFile = path.join(channelDir, 'data.json');
  if (!fs.existsSync(metaFile)) {
    await fetchMetaForChannel(mediaDir, channelId);
  }
  const channel = channelFromDisk(mediaDir, channelId);
  addChannel(channel);
}

async function addVideoIfNotExists(channelId: ChannelID, videoId: VideoID) {
  if (isVideoInDb(videoId)) return;
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

  const video = videoFromDisk(mediaDir, channelId, videoId);
  if (video == null) {
    throw new Error(`metadata did not exist after fetching for ${channelId}/${videoId}`);
  }
  addVideo(video);
}

const subbed = new Set<ChannelID>();
let processedCount = 0;
let subscribing = getSubscribing();
while (subscribing.length > 0) {
  const channel = subscribing[0];
  await subscribe(channel);

  if (!isInSubscriptions(channel)) {
    subscribing = getSubscribing();
    continue;
  }

  markSubscribed(channel);
  subbed.add(channel);
  processedCount++;
  subscribing = getSubscribing();
}
console.log(`Performed initial fetch for ${processedCount} channels`);

const subscribed = getSubscribed();
for (const channel of subscribed) {
  if (subbed.has(channel)) continue;
  await updateExisting(channel);
}
console.log(`Updated ${subscribed.length - subbed.size} channels`);
