import type { Video } from './db-manager.ts';
import { nameExt, type ChannelID, type VideoID } from './util.ts';

import fs from 'fs';
import path from 'path';

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
  let data = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  let {
    fulltitle: title,
    description,
    duration,
    upload_date
  } = data;
  if (typeof title !== 'string' || typeof description !== 'string' || typeof duration !== 'number' || typeof upload_date !== 'string' || upload_date.length !== 8) {
    throw new Error(`malformed data.json for ${channelId}/${videoId}`);
  }
  upload_date = upload_date.slice(0, 4) + '-' + upload_date.slice(4, 6) + '-' + upload_date.slice(6);

  let subs = [];
  let thumbExt = null;
  for (let file of contents) {
    if (file.startsWith('.')) continue;
    let { name, ext } = nameExt(file);
    if (name === 'thumb') {
      if (thumbExt != null) {
        throw new Error('multiple thumbs');
      }
      thumbExt = ext;
    } else if (ext === 'vtt' && name.startsWith('subs.')) {
      let split = name.split('.');
      subs.push(split.slice(1).join('.'));
    }
  }

  return {
    video_id: videoId,
    channel_id: channelId,
    title,
    extension: nameExt(vids[0]).ext,
    description,
    thumb_extension: thumbExt,
    duration_seconds: duration,
    upload_date,
    subtitle_languages: subs,
  };
}

