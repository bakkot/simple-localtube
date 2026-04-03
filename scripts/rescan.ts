import { parseArgs } from 'util';
import { rescan } from '../scan.ts';

let { positionals } = parseArgs({
  allowPositionals: true,
});

if (positionals.length !== 1) {
  console.log(`Usage: node rescan.ts path-to-media-dir

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

let mediaDir = positionals[0];
console.log(`Scanning ${mediaDir}`);
rescan(mediaDir);
