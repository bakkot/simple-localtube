// TODO just export the function

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

import { spawnSync } from 'child_process';
import { fetchTo, getTemp, move, type ChannelID } from './util.ts';

const YT_DLP_PATH = process.env.YT_DLP_PATH ?? path.join(import.meta.dirname, 'yt-dlp');

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
      cwd: tempDir.path,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}\nStderr: ${result.stderr}`);
  }
  let files = fs.readdirSync(tempDir.path);
  if (files.length !== 1 || !files[0].endsWith('.json')) {
    throw new Error(`fetching info resulted in unexpected files: ${JSON.stringify(files)}`);
  }
  let tempJsonPath = path.join(tempDir.path, files[0]);
  let contents = JSON.parse(fs.readFileSync(tempJsonPath, 'utf8'));

  let avatar = contents.thumbnails.find((t: any) => t.id === 'avatar_uncropped');
  let bannerUncropped = contents.thumbnails.find((t: any) => t.id === 'banner_uncropped');
  let banner = contents.thumbnails.reduce((acc: any, t: any) => t.width == null || t.width / t.height <= 2 ? acc : acc == null ? t : t.width < acc.width ? acc : t, null);

  let avatarName = avatar == null ? null : await fetchTo(avatar.url, tempDir.path, 'avatar');
  let bannerUncroppedName = bannerUncropped == null ? null : await fetchTo(bannerUncropped.url, tempDir.path, 'banner_uncropped');
  let bannerName = banner == null ? null : await fetchTo(banner.url, tempDir.path, 'banner');

  move(tempJsonPath, jsonPath);
  if (avatarName != null) {
    move(path.join(tempDir.path, avatarName), path.join(fullPath, avatarName));
  }
  if (bannerUncroppedName != null) {
    move(path.join(tempDir.path, bannerUncroppedName), path.join(fullPath, bannerUncroppedName));
  }
  if (bannerName != null) {
    move(path.join(tempDir.path, bannerName), path.join(fullPath, bannerName));
  }

  console.log({ avatarName, bannerName, bannerUncroppedName });
}

