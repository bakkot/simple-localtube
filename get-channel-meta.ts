// TODO just export the function

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import stream from 'stream';
import { pipeline } from 'stream/promises';

import { spawnSync } from 'child_process';
import { move, type ChannelID } from './util.ts';

const YT_DLP_PATH = process.env.YT_DLP_PATH ?? path.join(import.meta.dirname, 'yt-dlp');

// TODO consider whether we actually care about these
// https://github.com/nodejs/node/issues/58486
const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGUSR1', 'SIGUSR2'];
function getTemp(): { [Symbol.dispose]: () => void, name: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localtube-'));
  console.log({ tempDir });
  function cleanup() {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  function cleanupAndExit() {
    cleanup();
    process.exit();
  }

  process.on('exit', cleanup);
  for (let signal of EXIT_SIGNALS) {
    process.on(signal, cleanupAndExit);
  }

  return {
    [Symbol.dispose]() {
      cleanup();
      process.removeListener('exit', cleanup);
      for (let signal of EXIT_SIGNALS) {
        process.removeListener(signal, cleanupAndExit);
      }
    },
    name: tempDir,
  };
}

export async function fetchMetaForChannel(mediaDir: string, channelId: ChannelID) {
  // Build the full path for the current entry
  const fullPath = path.join(mediaDir, channelId);
  let jsonPath = path.join(fullPath, 'data.json');
  if (fs.existsSync(jsonPath)) {
    return;
  }
  using tempDir = getTemp();
  const result = spawnSync(
    YT_DLP_PATH,
    ['--write-info-json', '--skip-download', '--playlist-items', '0', `https://www.youtube.com/channel/${channelId}`],
    {
      stdio: 'pipe',
      encoding: 'utf-8',
      cwd: tempDir.name,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}\nStderr: ${result.stderr}`);
  }
  let files = fs.readdirSync(tempDir.name);
  if (files.length !== 1 || !files[0].endsWith('.json')) {
    throw new Error(`fetching info resulted in unexpected files: ${JSON.stringify(files)}`);
  }
  let tempJsonPath = path.join(tempDir.name, files[0]);
  let contents = JSON.parse(fs.readFileSync(tempJsonPath, 'utf8'));

  let avatar = contents.thumbnails.find((t: any) => t.id === 'avatar_uncropped');
  let bannerUncropped = contents.thumbnails.find((t: any) => t.id === 'banner_uncropped');
  let banner = contents.thumbnails.reduce((acc: any, t: any) => t.width == null || t.width / t.height <= 2 ? acc : acc == null ? t : t.width < acc.width ? acc : t, null);

  let avatarName = avatar == null ? null : await fetchTo(avatar.url, tempDir.name, 'avatar');
  let bannerUncroppedName = bannerUncropped == null ? null : await fetchTo(bannerUncropped.url, tempDir.name, 'banner_uncropped');
  let bannerName = banner == null ? null : await fetchTo(banner.url, tempDir.name, 'banner');

  move(tempJsonPath, jsonPath);
  if (avatarName != null) {
    move(path.join(tempDir.name, avatarName), path.join(fullPath, avatarName));
  }
  if (bannerUncroppedName != null) {
    move(path.join(tempDir.name, bannerUncroppedName), path.join(fullPath, bannerUncroppedName));
  }
  if (bannerName != null) {
    move(path.join(tempDir.name, bannerName), path.join(fullPath, bannerName));
  }

  console.log({ avatarName, bannerName, bannerUncroppedName });
}

const imageMimeToExt: Record<string, string | undefined> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  // @ts-expect-error
  __proto__: null,
};

async function fetchTo(url: string, targetDir: string, basename: string) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const contentType = response.headers.get('content-type');
  const mimeType = contentType?.split(';')[0].trim();

  const extension = imageMimeToExt[mimeType!];
  if (extension == null) {
    throw new Error(`could not identify mime type; got content type of ${JSON.stringify(contentType)}`);
  }

  const filename = `${basename}${extension}`;
  const filepath = path.join(targetDir, filename);
  await pipeline(stream.Readable.fromWeb(response.body! as any), fs.createWriteStream(filepath));

  return filename;
}
