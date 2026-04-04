import { getTemp, move, nameExt, toVideoID, type ChannelID, type VideoID } from '../util.ts';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { channelFromDisk, videoFromDisk, type VideoDataJSON } from '../scan.ts';
import { fetchMetaForChannel } from '../get-channel-meta.ts';
import { init as initMediaDb, addChannel, addVideo, isChannelInDb, isVideoInDb } from '../media-db.ts';
import { init as initSubscriptionsDb, getOneSubscribing, getSubscribed, markSubscribed, isInSubscriptions, getOneQueuedVideo, removeVideoFromQueue, isVideoInQueue } from '../subscriptions-db.ts';

class ErrorWithStderr extends Error {
  stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

function spawnAsync(command: string, options: { cwd?: string; print?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
  const { print, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, ...spawnOptions });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      const str = data.toString();
      stdout += str;
      if (print) process.stdout.write(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      const str = data.toString();
      stderr += str;
      if (print) process.stderr.write(data);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const err = new ErrorWithStderr(`Command failed with exit code ${code}`, stderr);
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

const YT_DLP_PATH = process.env.YT_DLP_PATH ?? path.join(import.meta.dirname, '..', 'yt-dlp');
const YT_DLP_BATCH_SIZE = 100; // How many videos to fetch per yt-dlp call
const YT_DLP_PAUSE_MS = 2000; // Pause between yt-dlp calls

let { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    tempdir: {
      type: 'string',
    },
    'db-dir': {
      type: 'string',
    },
    verbose: {
      type: 'boolean',
      default: false,
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
const verbose = values.verbose ?? false;
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

const dbDir = values['db-dir'] ?? path.join(import.meta.dirname, '..', 'dbs');
initMediaDb(dbDir);
initSubscriptionsDb(dbDir);

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
  } else if (!metadataExists) {
    using tempDir = getTemp(tempdir);
    console.log(`fetching https://www.youtube.com/watch?v=${videoId} to ${tempDir.path}`);
    const command = [
        YT_DLP_PATH,
        videoFileExists ? '--skip-download' : '',
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
    if (verbose) console.log(`executing: ${command}`);
    try {
      await spawnAsync(command, { cwd: tempDir.path, print: verbose });
    } catch (e: unknown) {
      if (e instanceof ErrorWithStderr) {
        // TODO store these somewhere so we don't keep fetching
        if (e.stderr.includes('members-only content')) {
          console.error(`skipping members-only ${videoId}`);
          return;
        } else if (e.stderr.includes('confirm your age')) {
          console.error(`skipping age-gated ${videoId}`);
          return;
        }
      }
      throw e;
    }

    // filter out `._` files created by macOS and similar
    const files = fs.readdirSync(tempDir.path).filter(f => !f.startsWith('.'));

    // this is a little silly but I couldn't figure out how to get yt-dlp to print things in a usable way
    const json = files.filter(f => f.endsWith('.json'));
    if (json.length !== 1) {
      throw new Error(`got not exactly 1 json file after download ${JSON.stringify(json)}`);
    }
    const video = files.filter(f => f.endsWith('.webm') || f.endsWith('.mp4'));
    if (videoFileExists) {
      if (files.length > 0) {
        throw new Error(`got video file despite --skip-download after downloading ${JSON.stringify(video)}`);
      }
    } else if (video.length !== 1) {
      throw new Error(`got ${video.length} video files after downloading ${JSON.stringify(video)}`);
    }
    const thumb = files.filter(f => f.endsWith('.png') || f.endsWith('.webp') || f.endsWith('.jpg') || f.endsWith('.gif'));
    if (thumb.length !== 1) {
      throw new Error(`got not exactly 1 thumb file after downloading ${JSON.stringify(thumb)}`);
    }
    const subs = files.filter(f => f.endsWith('.vtt'));
    if (files.length !== subs.length + (videoFileExists ? 2 : 3) /* i.e. json,video,thumb */) {
      throw new Error(`got unexpected files after download ${JSON.stringify(files)}`);
    }

    if (!videoFileExists) {
      await move(path.join(tempDir.path, video[0]), path.join(videoDir, 'video.' + nameExt(video[0]).ext));
    }
    await move(path.join(tempDir.path, json[0]), path.join(videoDir, 'data.json'));
    await move(path.join(tempDir.path, thumb[0]), path.join(videoDir, 'thumb.' + nameExt(thumb[0]).ext));
    for (const sub of subs) {
      await move(path.join(tempDir.path, sub), path.join(videoDir, 'subs.' + sub.split('.').slice(-2).join('.')));
    }
    console.log(`downloaded ${videoFileExists ? 'metadata' : 'video'} for ${nameExt(video[0]).name}`);
  }
  // at this point metadata + video exist, either because we just downloaded it
  // or because it already existed, possibly because we downloaded it previously but the server went down during the download

  const video = videoFromDisk(mediaDir, channelId, videoId);
  if (video == null) {
    throw new Error(`metadata did not exist after fetching for ${channelId}/${videoId}`);
  }
  addVideo(video);
}

async function resolveChannelForVideo(videoId: VideoID): Promise<ChannelID> {
  const result = await spawnAsync(
    [YT_DLP_PATH, '--dump-json', '--skip-download', `https://www.youtube.com/watch?v=${videoId}`].join(' '),
    { print: verbose },
  );
  const info = JSON.parse(result.stdout) as { channel_id?: string };
  const channelId = info.channel_id as ChannelID;
  if (!channelId) throw new Error(`no channel_id in yt-dlp info for video ${videoId}`);
  return channelId;
}

async function getLatestVideoUrls(channelId: ChannelID, all=false): Promise<VideoID[]> {
  const channelVideosUrl = `https://www.youtube.com/channel/${channelId}/videos`;
  // console.log(`Fetching latest videos for ${channelVideosUrl}`);

  const newVideoIds: VideoID[] = [];
  let startIndex = 1;

  while (true) {
    const endIndex = startIndex + YT_DLP_BATCH_SIZE - 1;
    const command = all
      ? `${YT_DLP_PATH} --flat-playlist --print webpage_url "${channelVideosUrl}"`
      : `${YT_DLP_PATH} --playlist-items ${startIndex}:${endIndex} --flat-playlist --print webpage_url "${channelVideosUrl}"`;

    if (verbose) console.log(`Executing: ${command}`);

    try {
      const { stdout } = await spawnAsync(command, { print: verbose });

      const batchUrls = stdout
        .split('\n')
        .map(url => url.trim())
        .filter(url => url.length > 0);

      if (batchUrls.length === 0) {
        if (verbose) console.log(`No more videos found for ${channelId} starting from index ${startIndex}.`);
        break; // Reached the end of the channel's videos
      }

      // console.log(`Fetched batch (${startIndex}-${endIndex}), ${batchUrls.length} URLs found.`);
      for (const url of batchUrls) {
        const videoId = toVideoID(url);
        if (videoId == null) {
          throw new Error('failed to read video ID from url ' + url);
        }

        if (!isVideoInDb(videoId)) {
          newVideoIds.push(videoId);
        } else if (!all) {
          if (verbose) console.log(`Found known video ${videoId}. Stopping search.`);
          break;
        }
      }

      startIndex = endIndex + 1;
      // Pause before the next call if we are continuing
      if (batchUrls.length === YT_DLP_BATCH_SIZE) {
        // Only pause if we likely have more videos
        // console.log(`Pausing for ${YT_DLP_PAUSE_MS / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, YT_DLP_PAUSE_MS));
      } else {
        // console.log('Reached end of playlist in this batch.');
        break;
      }
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      let stderr = (error as { stderr?: string }).stderr;
      console.error(`Error executing yt-dlp for ${channelId} (${startIndex}-${endIndex}):`, message);
      if (stderr) {
        console.error(`yt-dlp stderr: ${stderr}`);
      }
      throw error;
    }

    if (all) break;
  }

  console.log(`Found ${newVideoIds.length} new videos for channel ${channelId}`);
  return newVideoIds;
}


let videoProcessedCount = 0;
let queued;
while ((queued = getOneQueuedVideo()) != null) {
  const videoId = queued.video_id;
  if (isVideoInDb(videoId)) {
    removeVideoFromQueue(videoId);
    videoProcessedCount++;
    console.log(`queued video ${videoId} already in database, removing from queue`);
    continue;
  }

  const channelId = queued.channel_id ?? await resolveChannelForVideo(videoId);
  const channelDir = path.join(mediaDir, channelId);
  if (!fs.existsSync(channelDir)) fs.mkdirSync(channelDir);
  await addChannelIfNotExists(channelId);
  await addVideoIfNotExists(channelId, videoId);

  if (!isVideoInQueue(videoId)) continue;
  removeVideoFromQueue(videoId);
  videoProcessedCount++;
  console.log(`Downloaded queued video ${videoId}`);
}
console.log(`Fetched ${videoProcessedCount} queued videos`);

const subbed = new Set<ChannelID>();
let processedCount = 0;
let channel;
while ((channel = getOneSubscribing()) != null) {
  await subscribe(channel);

  if (!isInSubscriptions(channel)) continue;

  markSubscribed(channel);
  subbed.add(channel);
  processedCount++;
}
console.log(`Performed initial fetch for ${processedCount} channels`);

const subscribed = getSubscribed();
for (const channel of subscribed) {
  if (subbed.has(channel)) continue;
  await updateExisting(channel);
}
console.log(`Updated ${subscribed.length - subbed.size} channels`);
