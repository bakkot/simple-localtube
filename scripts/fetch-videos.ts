import { fetchTo, getTemp, move, nameExt, ErrorWithStderr, spawnAsync, toVideoID, type ChannelDataJSON, type ChannelID, type ThumbnailJSON, type VideoID } from '../util.ts';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { channelFromDisk, videoFromDisk } from '../read-from-disk.ts';
import { init as initMediaDb, addChannel, addVideo, isChannelInDb, isVideoInDb, getChannelById } from '../media-db.ts';
import { init as initSubscriptionsDb, getOneSubscribing, getSubscribed, markSubscribed, getOneQueuedVideo, removeVideoFromQueue, isVideoInQueue, markVideoUnavailable, getVideoUnavailableReason, decrementRecentLimit } from '../subscriptions-db.ts';

const YT_DLP_PATH = process.env.YT_DLP_PATH ?? 'yt-dlp';
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
    skiplist: {
      type: 'string',
    },
  },
});

if (positionals.length !== 1) {
  console.log(`Usage: node fetch-videos.ts path-to-media-dir
  --tempdir dir        path for temporary files (default: path-to-media-dir)
                       the special value "OS_DEFAULT" will use your operating system's default
  --skiplist file.txt  newline-separated list of video IDs or URLs to skip

Requires yt-dlp to be either on the path or provided in the \`YT_DLP_PATH\` environment variable.
\`YT_DLP_PATH\` can include additional arguments such as \`--js-runtimes node\`.

It is recommended but not required that tempdir be on the same volume as the media, to avoid needing to copy files across volumes.
If the media lives on a network volume, "OS_DEFAULT" will probably be more performant.

This expects media-dir to be organized like:

some-channel-id/some-video-id/data.json
some-channel-id/some-video-id/video.mp4
`);
  process.exit(1);
}

let [mediaDir] = positionals;
let { tempdir } = values;
const verbose = values.verbose ?? false;

const skipSet = new Set<VideoID>();
if (values.skiplist) {
  const lines = fs.readFileSync(values.skiplist, 'utf-8').split('\n').map(l => l.trim()).filter(l => l.length > 0);
  for (const line of lines) {
    const id = toVideoID(line);
    if (id != null) {
      skipSet.add(id);
    }
  }
  console.log(`Loaded ${skipSet.size} video IDs to skip`);
}

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


function channelDisplay(channelId: ChannelID, title: string | null): string {
  return title != null ? `${title} (${channelId})` : channelId;
}

async function subscribe(channelId: ChannelID, recentLimit: number | null, title: string | null): Promise<number> {
  const channelDir = path.join(mediaDir, channelId);
  if (!fs.existsSync(channelDir)) {
    fs.mkdirSync(channelDir);
  }
  await addChannelIfNotExists(channelId);

  let newVids = 0;
  let remaining = recentLimit;
  const videoIds = await getLatestVideoUrls(channelId, true, title);
  for (const videoId of videoIds) {
    let added = await addVideoIfNotExists(channelId, videoId);
    if (added) {
      ++newVids;
      if (remaining != null) {
        if (remaining === 1) break;
        --remaining;
        decrementRecentLimit(channelId);
      }
    }
  }
  markSubscribed(channelId);
  return newVids;
}

async function updateExisting(channelId: ChannelID, title: string | null) {
  if (!isChannelInDb(channelId)) {
    throw new Error(`${channelDisplay(channelId, title)} is marked as subscribed but is not present in the database`);
  }
  let newVids = 0;
  if (verbose) console.log(`Checking for new videos from ${title == null ? channelId : title}`);
  const videoIds = await getLatestVideoUrls(channelId, false, title);
  for (const videoId of videoIds) {
    let added = await addVideoIfNotExists(channelId, videoId);
    if (added) ++newVids;
  }
  return newVids;
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

async function addVideoIfNotExists(channelId: ChannelID, videoId: VideoID): Promise<boolean> {
  if (skipSet.has(videoId)) return false;
  if (isVideoInDb(videoId)) return false;
  const unavailableReason = getVideoUnavailableReason(videoId);
  if (unavailableReason != null) {
    if (verbose) console.log(`skipping ${unavailableReason} ${videoId}`);
    return false;
  }
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
        // '--write-auto-subs',
        '--write-subs',
        '--sub-langs',
        'en.*',
        '--format',
        'b',
        '--merge-output-format',
        'mp4/webm',
        // '--retry-sleep',
        // 'fragment:exp=1:20',
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
        if (e.stderr.includes('members-only content') || e.stderr.includes("available to this channel's members")) {
          console.error(`skipping members-only ${videoId}`);
          markVideoUnavailable(videoId, 'members-only');
          return false;
        } else if (e.stderr.includes('confirm your age')) {
          console.error(`skipping age-gated ${videoId}`);
          markVideoUnavailable(videoId, 'age-gated');
          return false;
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
  return true;
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

async function fetchMetaForChannel(mediaDir: string, channelId: ChannelID) {
  const fullPath = path.join(mediaDir, channelId);
  let jsonPath = path.join(fullPath, 'data.json');
  if (fs.existsSync(jsonPath)) {
    return;
  }
  using tempDir = getTemp();
  await spawnAsync(
    [
      YT_DLP_PATH,
      '--write-info-json',
      '--skip-download',
      '--playlist-items',
      '0',
      `https://www.youtube.com/channel/${channelId}`,
    ].join(' '),
    {
      cwd: tempDir.path,
    },
  );
  let files = fs.readdirSync(tempDir.path);
  if (files.length !== 1 || !files[0].endsWith('.json')) {
    throw new Error(`fetching info resulted in unexpected files: ${JSON.stringify(files)}`);
  }
  let tempJsonPath = path.join(tempDir.path, files[0]);
  let contents = JSON.parse(fs.readFileSync(tempJsonPath, 'utf8')) as ChannelDataJSON;

  let avatar = contents.thumbnails.find((t: ThumbnailJSON) => t.id === 'avatar_uncropped');
  let bannerUncropped = contents.thumbnails.find((t: ThumbnailJSON) => t.id === 'banner_uncropped');
  let banner = contents.thumbnails.reduce((acc: ThumbnailJSON | null, t: ThumbnailJSON) => t.width == null || t.width / t.height <= 2 ? acc : acc == null ? t : t.width < acc.width ? acc : t, null);

  let avatarName = avatar == null ? null : await fetchTo(avatar.url, tempDir.path, 'avatar');
  let bannerUncroppedName = bannerUncropped == null ? null : await fetchTo(bannerUncropped.url, tempDir.path, 'banner_uncropped');
  let bannerName = banner == null ? null : await fetchTo(banner.url, tempDir.path, 'banner');

  await move(tempJsonPath, jsonPath);
  if (avatarName != null) {
    await move(path.join(tempDir.path, avatarName), path.join(fullPath, avatarName));
  }
  if (bannerUncroppedName != null) {
    await move(path.join(tempDir.path, bannerUncroppedName), path.join(fullPath, bannerUncroppedName));
  }
  if (bannerName != null) {
    await move(path.join(tempDir.path, bannerName), path.join(fullPath, bannerName));
  }

  // console.log({ avatarName, bannerName, bannerUncroppedName });
}

async function getLatestVideoUrls(channelId: ChannelID, all=false, title: string | null = null): Promise<VideoID[]> {
  const channelVideosUrl = `https://www.youtube.com/channel/${channelId}/videos`;
  // console.log(`Fetching latest videos for ${channelVideosUrl}`);

  const newVideoIds: VideoID[] = [];
  let startIndex = 1;

  outer: while (true) {
    const endIndex = startIndex + YT_DLP_BATCH_SIZE - 1;
    const command = all
      ? `${YT_DLP_PATH} --flat-playlist --print webpage_url "${channelVideosUrl}"`
      : `${YT_DLP_PATH} --playlist-items ${startIndex}:${endIndex} --flat-playlist --print webpage_url "${channelVideosUrl}"`;

    if (verbose) console.log(`Executing: ${command}`);

    try {
      const { stdout } = await spawnAsync(command, { print: false });

      const batchUrls = stdout
        .split('\n')
        .map(url => url.trim())
        .filter(url => url.length > 0);

      if (batchUrls.length === 0) {
        if (verbose) console.log(`No more videos found for ${channelDisplay(channelId, title)} starting from index ${startIndex}.`);
        break; // Reached the end of the channel's videos
      }

      // console.log(`Fetched batch (${startIndex}-${endIndex}), ${batchUrls.length} URLs found.`);
      for (const url of batchUrls) {
        const videoId = toVideoID(url);
        if (videoId == null) {
          throw new Error('failed to read video ID from url ' + url);
        }

        if (!isVideoInDb(videoId) && getVideoUnavailableReason(videoId) == null) {
          newVideoIds.push(videoId);
        } else if (!all) {
          if (verbose) console.log(`Found known video ${videoId}. Stopping search.`);
          break outer;
        }
      }

      startIndex = endIndex + 1;
      if (verbose) console.log(`Pausing for ${YT_DLP_PAUSE_MS / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, YT_DLP_PAUSE_MS));

      if (batchUrls.length !== YT_DLP_BATCH_SIZE) {
        // console.log('Reached end of playlist in this batch.');
        break;
      }
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      let stderr = (error as { stderr?: string }).stderr;
      console.error(`Error executing yt-dlp for ${channelDisplay(channelId, title)} (${startIndex}-${endIndex}):`, message);
      if (stderr) {
        console.error(`yt-dlp stderr: ${stderr}`);
      }
      throw error;
    }

    if (all) break;
  }

  console.log(`Found ${newVideoIds.length} new videos for channel ${channelDisplay(channelId, title)}`);
  return newVideoIds;
}

let addedFromQueue = 0;
let videoProcessedCount = 0;
let queued;
while ((queued = getOneQueuedVideo()) != null) {
  const videoId = queued.video_id;
  if (skipSet.has(videoId)) {
    console.log(`skipping queued video ${videoId} (in skiplist)`);
    continue;
  }
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
  let added = await addVideoIfNotExists(channelId, videoId);

  // note that this can technically race if you're running multiple copies of the script at once
  // so, you know, don't
  if (!isVideoInQueue(videoId)) continue;
  removeVideoFromQueue(videoId);
  if (added) {
    ++videoProcessedCount;
    ++addedFromQueue;
    console.log(`Downloaded queued video ${videoId}`);
  }
}
console.log(`Fetched ${videoProcessedCount} queued videos`);

const subbed = new Set<ChannelID>();
let processedSubscribingCount = 0;
let addedFromSubscribing = 0;
let channel: ReturnType<typeof getOneSubscribing>;
while ((channel = getOneSubscribing()) != null) {
  // calling subscribe will also remove the channel from the db
  addedFromSubscribing += await subscribe(channel.channelId, channel.recentLimit, channel.title);
  subbed.add(channel.channelId);
  processedSubscribingCount++;
}
console.log(`Performed initial fetch for ${processedSubscribingCount} channels`);

let addedFromSubscribed = 0;
const subscribed = getSubscribed();
for (const { channelId, title } of subscribed) {
  if (subbed.has(channelId)) continue;
  const resolvedTitle = title ?? getChannelById(channelId)?.channel_title ?? null;
  addedFromSubscribed += await updateExisting(channelId, resolvedTitle);
}
console.log(`Updated ${subscribed.length - subbed.size} channels`);
console.log(`Finished with ${addedFromQueue + addedFromSubscribing + addedFromSubscribed} new videos (${addedFromQueue} from individual queue, ${addedFromSubscribing} from newly subscribing channels, ${addedFromSubscribed} from subscribed channels)`)
