import { addChannel, addVideo, resetMediaInDb, type Channel, type Video } from './media-db.ts';
import { nameExt, type ChannelID, type VideoID } from './util.ts';

import fs from 'fs';
import path from 'path';

// TODO async
export function videoFromDisk(mediaDir: string, channelId: ChannelID, videoId: VideoID): Video | null {
  let dir = path.join(mediaDir, channelId, videoId);
  let contents = fs.readdirSync(dir);
  let vids = contents.filter(c => c === 'video.mp4' || c === 'video.webm');
  if (vids.length !== 1) {
    throw new Error(`${channelId}/${videoId} does not contain a video`);
  }
  if (!contents.includes('data.json')) {
    // throw new Error(`${channelId}/${videoId} does not contain a data.json file`);
    console.error(`skipping ${channelId}/${videoId} because of missing data.json`);
    return null;
  }
  let {
    fulltitle: title,
    description,
    duration,
    upload_date
  } = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  if (typeof title !== 'string' || typeof description !== 'string' || typeof duration !== 'number' || typeof upload_date !== 'string' || upload_date.length !== 8) {
    throw new Error(`malformed data.json for ${channelId}/${videoId}`);
  }
  const upload_timestamp = Math.floor(new Date(upload_date.slice(0, 4) + '-' + upload_date.slice(4, 6) + '-' + upload_date.slice(6) + 'T00:00:00Z').getTime() / 1000);

  let subs = [];
  let thumb_filename = null;
  for (let file of contents) {
    if (file.startsWith('.')) continue;
    let { name, ext } = nameExt(file);
    if (name === 'thumb') {
      if (thumb_filename != null) {
        throw new Error('multiple thumbs');
      }
      thumb_filename = file;
    } else if (ext === 'vtt' && name.startsWith('subs.')) {
      let split = name.split('.');
      subs.push(split.slice(1).join('.'));
    }
  }

  return {
    video_id: videoId,
    channel_id: channelId,
    title,
    description,
    video_filename: vids[0],
    thumb_filename,
    duration_seconds: duration,
    upload_timestamp,
    subtitle_languages: subs,
  };
}

export function channelFromDisk(mediaDir: string, channelId: ChannelID): Channel {
  let dir = path.join(mediaDir, channelId);
  let { channel, description, uploader_id } = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  if (typeof channel !== 'string' || description != null && typeof description !== 'string' || typeof uploader_id !== 'string') {
    throw new Error(`missing data for ${channelId}`);
  }
  if (uploader_id[0] === '@') {
    uploader_id = uploader_id.slice(1);
  }
  let contents = fs.readdirSync(dir);
  let avatar = contents.find(f => f === 'avatar.png' || f === 'avatar.jpg') ?? null;
  let banner = contents.find(f => f === 'banner.png' || f === 'banner.jpg') ?? null;
  let bannerUncropped = contents.find(f => f === 'banner_uncropped.png' || 'banner_uncropped.jpg') ?? null;
  return {
    channel_id: channelId,
    short_id: uploader_id,
    channel,
    description: description ?? null,
    avatar_filename: avatar,
    banner_filename: banner,
    banner_uncropped_filename: bannerUncropped,
  };
}

export function rescan(mediaDir: string) {
  const channels = fs.readdirSync(mediaDir, { withFileTypes: true });

  resetMediaInDb();

  try {
    for (const channelEntry of channels) {
      if (!channelEntry.isDirectory()) continue;
      console.log(channelEntry.name);
      let hasAddedThisChannel = false;

      const channelPath = path.join(mediaDir, channelEntry.name);
      const channelJson = path.join(channelPath, 'data.json');
      if (!fs.existsSync(channelJson)) {
        // TODO ensure this is in the readme
        console.log(`skipping ${channelEntry.name} because of missing data.json; if it is a real channel you will need to fetch its metadata before it is usable: see the readme.`);
        continue;
      }

      const videoEntries = fs.readdirSync(channelPath, { withFileTypes: true });

      for (const videoEntry of videoEntries) {
        if (!videoEntry.isDirectory()) continue;
        let vid = videoFromDisk(mediaDir, channelEntry.name as ChannelID, videoEntry.name as VideoID);
        if (vid != null) {
          if (!hasAddedThisChannel) {
            addChannel(channelFromDisk(mediaDir, channelEntry.name as ChannelID));
            hasAddedThisChannel = true;
          }
          addVideo(vid);
        }
      }
    }
  } catch (e) {
    console.error('Error while rescanning; DB is probably in a partial state. You should correct the error and rerun.');
    throw e;
  }
}

// todo this goes elsewhere
import { parseArgs } from 'util';

let { positionals } = parseArgs({ allowPositionals: true });
if (positionals.length !== 1) {
  console.log('Usage: node scan.ts path-to-media-dir');
  process.exit(1);
}
let mediaDir = positionals[0];
rescan(mediaDir);
