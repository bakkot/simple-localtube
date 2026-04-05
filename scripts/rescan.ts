import { parseArgs } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { addChannel, addVideo, init as initMediaDb } from '../media-db.ts';
import type { ChannelID, VideoID } from '../util.ts';
import { channelFromDisk, videoFromDisk } from '../read-from-disk.ts';


let { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'db-dir': {
      type: 'string',
    },
  },
});

if (positionals.length !== 1) {
  console.log(`Usage: node [--db-dir path-to-db-dir] rescan.ts path-to-media-dir
  --db-dir dir    directory for database files (default: project_root/dbs)

This expects media-dir to be organized like:

some-channel-id/data.json
some-channel-id/avatar.png
some-channel-id/banner.png
some-channel-id/some-video-id/data.json
some-channel-id/some-video-id/thumb.jpg
some-channel-id/some-video-id/subs.en.vtt
some-channel-id/some-video-id/video.mp4

Only the data.json files and video.mp4 (or video.webm) are mandatory. data.json files should be in the format given by yt-dlp's --write-info-json.
`);
  process.exit(1);
}

const dbDir = values['db-dir'] ?? path.join(import.meta.dirname, '..', 'dbs');
initMediaDb(dbDir);

let mediaDir = positionals[0];
console.log(`Scanning ${mediaDir}`);
rescan(mediaDir);

function rescan(mediaDir: string) {
  const channels = fs.readdirSync(mediaDir, { withFileTypes: true });
  let addedChannels = new Set<ChannelID>();

  try {
    for (const channelEntry of channels) {
      if (!channelEntry.isDirectory()) continue;
      console.log(channelEntry.name);

      const channelPath = path.join(mediaDir, channelEntry.name);
      const channelJson = path.join(channelPath, 'data.json');
      if (!fs.existsSync(channelJson)) {
        // TODO ensure this is in the readme
        console.log(`skipping ${channelEntry.name} because of missing data.json; if it is a real channel you will need to fetch its metadata before it is usable: see the readme.`);
        continue;
      }

      const videoEntries = fs.readdirSync(channelPath, { withFileTypes: true });
      const channelData = channelFromDisk(mediaDir, channelEntry.name as ChannelID);

      if (!addedChannels.has(channelData.channel_id)) {
        addChannel(channelData);
        addedChannels.add(channelData.channel_id);
      }

      for (const videoEntry of videoEntries) {
        if (!videoEntry.isDirectory()) continue;
        let vid = videoFromDisk(mediaDir, channelEntry.name as ChannelID, videoEntry.name as VideoID);
        if (vid != null) {
          try {
            addVideo(vid);
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
