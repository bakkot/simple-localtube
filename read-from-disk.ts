import { addVideo, addChannel, type Channel, type Video } from './media-db.ts';
import { nameExt, vttToText, type ChannelDataJSON, type ChannelID, type VideoID } from './util.ts';

import fs from 'fs';
import path from 'path';

export type VideoDataJSON = {
  fulltitle: string;
  description: string;
  duration: number;
  upload_date: string;
}
export function videoFromDisk(mediaDir: string, channelId: ChannelID, videoId: VideoID): Video | null {
  let dir = path.join(mediaDir, channelId, videoId);
  let contents = fs.readdirSync(dir);
  let vids = contents.filter(c => c === 'video.mp4' || c === 'video.webm');
  if (vids.length === 0) {
    console.error(`skipping ${channelId}/${videoId} because of missing video`);
    return null;
  }
  if (vids.length !== 1) {
    throw new Error(`${channelId}/${videoId} contains both a .mp4 and a .webm?`);
  }
  if (!contents.includes('data.json')) {
    console.error(`skipping ${channelId}/${videoId} because of missing data.json`);
    return null;
  }
  let {
    fulltitle: title,
    description,
    duration,
    upload_date
  } = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')) as VideoDataJSON;
  if (typeof title !== 'string' || typeof description !== 'string' || typeof duration !== 'number' || typeof upload_date !== 'string' || upload_date.length !== 8) {
    throw new Error(`malformed data.json for ${channelId}/${videoId}`);
  }
  const upload_timestamp = Math.floor(new Date(upload_date.slice(0, 4) + '-' + upload_date.slice(4, 6) + '-' + upload_date.slice(6) + 'T00:00:00Z').getTime() / 1000);

  let subtitles_files: Record<string, string> = {
    // @ts-expect-error https://github.com/microsoft/TypeScript/issues/38385
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
      subtitles_files[split.slice(1).join('.')] = path.join(dir, file);
    }
  }

  let subtitleTexts: string[] = [];
  for (let vttPath of Object.values(subtitles_files)) {
    let vtt = fs.readFileSync(vttPath, 'utf8');
    let text = vttToText(vtt);
    if (text) subtitleTexts.push(text);
  }
  let subtitles_text = subtitleTexts.join('\n');

  return {
    video_id: videoId,
    channel_id: channelId,
    title,
    description,
    video_filename: path.join(dir, vids[0]),
    thumb_filename: thumb_filename == null ? null :path.join(dir, thumb_filename),
    duration_seconds: duration,
    upload_timestamp,
    subtitles_files,
    subtitles_text,
  };
}

export function channelFromDisk(mediaDir: string, channelId: ChannelID): Channel {
  let dir = path.join(mediaDir, channelId);
  let { channel, description, uploader_id } = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')) as ChannelDataJSON;
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
    channel_title: channel,
    description: description ?? null,
    avatar_filename: avatar == null ? null : path.join(dir, avatar),
    banner_filename: banner == null ? null : path.join(dir, banner),
    banner_uncropped_filename: bannerUncropped == null ? null : path.join(dir, bannerUncropped),
    latest_upload_timestamp: null,
    video_count: 0,
  };
}
