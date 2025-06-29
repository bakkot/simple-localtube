import type { Channel, Video } from './media-db.ts';
import { nameExt, type ChannelID, type VideoID } from './util.ts';

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

export async function videoFromDisk(mediaDir: string, channelId: ChannelID, videoId: VideoID, fetchMissingMetadata?: ((channelId: ChannelID, videoId: VideoID) => Promise<void>)): Promise<Video | null> {
  let dir = path.join(mediaDir, channelId, videoId);
  let contents = await fsp.readdir(dir);
  let vids = contents.filter(c => c === 'video.mp4' || c === 'video.webm');
  if (vids.length !== 1) {
    throw new Error(`${channelId}/${videoId} does not contain a video`);
  }
  if (!contents.includes('data.json')) {
    if (fetchMissingMetadata) {
      await fetchMissingMetadata(channelId, videoId);
      if (!fs.existsSync(path.join(dir, 'data.json'))) {
        throw new Error(`fetching metadata for ${channelId}/${videoId} did not result in a data.json in ${dir}`);
      }
    } else {
      console.error(`skipping ${channelId}/${videoId} because of missing data.json`);
      return null;
    }
  }
  let {
    fulltitle: title,
    description,
    duration,
    upload_date
  } = JSON.parse(await fsp.readFile(path.join(dir, 'data.json'), 'utf8'));
  if (typeof title !== 'string' || typeof description !== 'string' || typeof duration !== 'number' || typeof upload_date !== 'string' || upload_date.length !== 8) {
    throw new Error(`malformed data.json for ${channelId}/${videoId}`);
  }
  const upload_timestamp = Math.floor(new Date(upload_date.slice(0, 4) + '-' + upload_date.slice(4, 6) + '-' + upload_date.slice(6) + 'T00:00:00Z').getTime() / 1000);

  let subtitles: Record<string, string> = {
    // @ts-expect-error
    __proto__: null,
  };
  let thumb_filename = null;
  for (let file of contents) {
    if (file.startsWith('.')) continue;
    let { name, ext } = nameExt(file);
    if (name === 'thumb') {
      if (thumb_filename != null) {
        throw new Error(`multiple thumbs for ${videoId}`);
      }
      thumb_filename = file;
    } else if (ext === 'vtt' && name.startsWith('subs.')) {
      let split = name.split('.');
      subtitles[split.slice(1).join('.')] = path.join(dir, file);
    }
  }

  return {
    video_id: videoId,
    channel_id: channelId,
    title,
    description,
    video_filename: path.join(dir, vids[0]),
    thumb_filename: thumb_filename == null ? null :path.join(dir, thumb_filename),
    duration_seconds: duration,
    upload_timestamp,
    subtitles,
  };
}

export async function channelFromDisk(mediaDir: string, channelId: ChannelID): Promise<Channel> {
  let dir = path.join(mediaDir, channelId);
  let { channel, description, uploader_id } = JSON.parse(await fsp.readFile(path.join(dir, 'data.json'), 'utf8'));
  if (typeof channel !== 'string' || description != null && typeof description !== 'string' || typeof uploader_id !== 'string') {
    throw new Error(`missing data for ${channelId}`);
  }
  if (uploader_id[0] === '@') {
    uploader_id = uploader_id.slice(1);
  }
  let contents = await fsp.readdir(dir);
  let avatar = contents.find(f => f === 'avatar.png' || f === 'avatar.jpg') ?? null;
  let banner = contents.find(f => f === 'banner.png' || f === 'banner.jpg') ?? null;
  let bannerUncropped = contents.find(f => f === 'banner_uncropped.png' || 'banner_uncropped.jpg') ?? null;
  return {
    channel_id: channelId,
    short_id: uploader_id,
    channel,
    description: description ?? null,
    avatar_filename: avatar == null ? null : path.join(dir, avatar),
    banner_filename: banner == null ? null : path.join(dir, banner),
    banner_uncropped_filename: bannerUncropped == null ? null : path.join(dir, bannerUncropped),
  };
}

async function addVideoOnline(video: Video, channel: Channel, serverUrl: string): Promise<void> {
  const response = await fetch(`${serverUrl}/public-api/add-video`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      video,
      channel,
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to add video ${video.video_id}: ${error.message}`);
  }
}

let addChannel: ((channel: Channel) => void) | null = null;
let addVideo: ((video: Video) => void) | null = null;
async function addVideoOffline(video: Video, channel: Channel, addedChannels: Set<ChannelID>) {
  if (addChannel == null || addVideo == null) {
    // doing this here instead of at root because it opens the DB, which we don't want to do when not offline
    ({ addChannel, addVideo } = await import('./media-db.ts'));
  }
  if (!addedChannels.has(channel.channel_id)) {
    addChannel(channel);
    addedChannels.add(channel.channel_id);
  }
  addVideo(video);
}

async function rescanMain(mediaDir: string, online: boolean = false, serverUrl: string = 'http://localhost:3000') {
  const channels = await fsp.readdir(mediaDir, { withFileTypes: true });
  let addedChannels = new Set<ChannelID>();

  try {
    for (const channelEntry of channels) {
      if (!channelEntry.isDirectory()) continue;
      console.log(channelEntry.name);

      const channelPath = path.join(mediaDir, channelEntry.name);
      const channelJson = path.join(channelPath, 'data.json');
      try {
        await fsp.access(channelJson);
      } catch {
        // TODO ensure this is in the readme
        console.log(`skipping ${channelEntry.name} because of missing data.json; if it is a real channel you will need to fetch its metadata before it is usable: see the readme.`);
        continue;
      }

      const videoEntries = await fsp.readdir(channelPath, { withFileTypes: true });
      const channelData = await channelFromDisk(mediaDir, channelEntry.name as ChannelID);

      for (const videoEntry of videoEntries) {
        if (!videoEntry.isDirectory()) continue;
        let vid = await videoFromDisk(mediaDir, channelEntry.name as ChannelID, videoEntry.name as VideoID);
        if (vid != null) {
          try {
            if (online) {
              await addVideoOnline(vid, channelData, serverUrl);
            } else {
              await addVideoOffline(vid, channelData, addedChannels);
            }
          } catch (error) {
            console.error(`Error adding video ${vid.video_id}:`, error);
          }
        }
      }
    }
  } catch (e) {
    console.error('Error while rescanning; operation may be incomplete.');
    throw e;
  }
}

export async function rescan(mediaDir: string) {
  return rescanMain(mediaDir, false);
}

export async function rescanOnline(mediaDir: string, serverUrl: string = 'http://localhost:3000') {
  try {
    const up = await (await fetch(serverUrl + '/public-api/healthcheck')).json();
    if (up !== true) throw null;
  } catch {
    throw new Error(`${serverUrl} doesn't appear to be running`);
  }
  return rescanMain(mediaDir, true, serverUrl);
}
