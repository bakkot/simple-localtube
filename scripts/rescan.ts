import { parseArgs } from 'util';
import { rescan, rescanOnline } from '../scan.ts';

const defaultUrl = 'http://localhost:3000';

let { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    online: {
      type: 'boolean',
      default: false,
    },
    server: {
      type: 'string',
      default: defaultUrl,
    },
  },
});

if (positionals.length !== 1) {
  console.log(`Usage: node scan.ts [--online] [--server=url] path-to-media-dir
  --online: Use API endpoints instead of direct database access
  --server: Server URL for use with --online (default: ${defaultUrl})

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

if (values.online) {
  console.log(`Scanning ${mediaDir} using online API at ${values.server}`);
  await rescanOnline(mediaDir, values.server);
} else {
  console.log(`Scanning ${mediaDir} using direct database access`);
  await rescan(mediaDir);
}
