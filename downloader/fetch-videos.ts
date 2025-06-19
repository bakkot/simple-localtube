import type { ChannelID, VideoID } from '../util.ts';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { getLatestVideoUrls, hasChannel, hasVideo } from './get-channel-video-ids.ts';
import type { Channel } from '../media-db.ts';
import { videoFromDisk } from '../scan.ts';

const defaultUrl = 'http://localhost:3000';

let { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    server: {
      type: 'string',
      default: defaultUrl,
    },
  },
});

if (positionals.length !== 2) {
  console.log(`Usage: node fetch-videos.ts [--server=url] path-to-subscriptions.json path-to-media-dir
  --server: Server URL (default: ${defaultUrl})

This expects media-dir to be organized like:

some-channel-id/some-video-id/video.mp4
`);
  process.exit(1);
}

let [subscriptionsFile, mediaDir] = positionals;
let { server } = values;

type SubscriptionStatus = {
  subscribing: ChannelID[];
  subscribed: ChannelID[];
}

let status: SubscriptionStatus;

if (!fs.existsSync(subscriptionsFile)) {
  status = { subscribing: [], subscribed: [] };
  writeStatus();
}
status = JSON.parse(fs.readFileSync(subscriptionsFile, 'utf8'));

function writeStatus() {
  fs.writeFileSync(subscriptionsFile, JSON.stringify(status, null, 2));
}

try {
  const up = await (await fetch(server + '/public-api/healthcheck')).json();
  if (up !== true) throw null;
} catch {
  console.error(`${server} doesn't appear to be running`);
  process.exit(1);
}

try {
  if (!fs.lstatSync(mediaDir).isDirectory()) {
    throw null;
  }
} catch {
  console.error(`${mediaDir} doesn't appear to be a directory`);
  process.exit(1);
}

async function subscribe(channelId: ChannelID) {
  const channelDir = path.join(mediaDir, channelId);
  if (!fs.existsSync(channelDir)) {
    fs.mkdirSync(channelDir);
  }
  const metaFile = path.join(channelDir, 'data.json');
  if (!(await hasChannel(server, channelId))) {
    if (!fs.existsSync(metaFile)) {
      // TODO get metafile
    }
    // TODO addChannelToServer from metafile
  }

  const videoIds = await getLatestVideoUrls(server, channelId, true);
  for (const videoId of videoIds) {
    addIfNotExists(channelId, videoId);
  }
}

async function updateExisting(channelId: ChannelID) {
  if (!(await hasChannel(server, channelId))) {
    throw new Error(`${channelId} is marked as subscribed but is not present in the server`);
  }
  const videoIds = await getLatestVideoUrls(server, channelId);
  for (const videoId of videoIds) {
    addIfNotExists(channelId, videoId);
  }
}

async function addIfNotExists(channelId: ChannelID, videoId: VideoID) {
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
    // TODO run yt-dlp and move files
  }
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
    const success = await res.json();
    if (success !== true) throw null;
  } catch {
    throw new Error(`failed to add video ${channelId}/${videoId}`);
  }
}

const toSub = new Set(status.subscribing);
for (const channel of toSub) {
  await subscribe(channel);
  toSub.delete(channel);
  status.subscribing = [...toSub];
  status.subscribed.push(channel);
  writeStatus();
}

for (const channel of status.subscribed) {
  await updateExisting(channel);
}
