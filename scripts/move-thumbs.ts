import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';

let { positionals } = parseArgs({ allowPositionals: true });
if (positionals.length !== 2) {
  console.log('Usage: node move-thumbs.ts path-to-media-dir path-to-cache-dir');
  process.exit(1);
}

let MEDIA_DIR = positionals[0];
let CACHE_DIR = positionals[1];


const channels = fs.readdirSync(MEDIA_DIR, { withFileTypes: true });

for (const channelEntry of channels) {
  if (!channelEntry.isDirectory()) continue;

  const channelPath = path.join(MEDIA_DIR, channelEntry.name);

  const videoEntries = fs.readdirSync(channelPath, { withFileTypes: true });

  for (const videoEntry of videoEntries) {
    if (!videoEntry.isDirectory()) continue;

    const videoDir = path.join(channelPath, videoEntry.name);
    const videoId = videoEntry.name;

    const thumbnailPath = path.join(CACHE_DIR,  videoId[0].toLowerCase(), `${videoId}.jpg`);
    const targetPath = path.join(videoDir, 'thumb.jpg');

    if (!fs.existsSync(thumbnailPath)) {
      throw new Error(`Thumbnail not found: ${thumbnailPath}`);
    }

    fs.renameSync(thumbnailPath, targetPath);
    console.log(`${thumbnailPath} -> ${targetPath}`);
  }
}
