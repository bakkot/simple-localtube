import { parseArgs } from 'util';
import path from 'path';
import { init as initMediaDb } from '../media-db.ts';
import { rescan } from '../scan.ts';

let { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'db-dir': {
      type: 'string',
    },
  },
});

if (positionals.length !== 1) {
  console.log(`Usage: node rescan.ts path-to-media-dir
  --db-dir dir    directory for database files (default: project root)

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

const dbDir = values['db-dir'] ?? path.join(import.meta.dirname, '..');
initMediaDb(dbDir);

let mediaDir = positionals[0];
console.log(`Scanning ${mediaDir}`);
rescan(mediaDir);
