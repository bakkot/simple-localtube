// assuming you have video files without metadata organized as media/channel/VIDEOID.mp4,
// fetch the info-json for it and write to media/channel/VIDEOID.json

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

import { spawnSync } from 'child_process';
import { parseArgs } from 'util';

const YT_DLP_PATH = process.env.YT_DLP_PATH ?? path.join(import.meta.dirname, '..', 'yt-dlp');

let { positionals } = parseArgs({ allowPositionals: true });
if (positionals.length !== 1) {
  console.log('Usage: node get-json.ts path-to-media-dir');
  process.exit(1);
}

let dir = positionals[0];

let sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

const openedDir = await fsp.opendir(dir, { recursive: true });

// don't bother making the temp dir until we've successfully opened the passed path
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localtube-'));
console.log({ tempDir });
process.on('exit', () => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

['SIGINT', 'SIGTERM', 'SIGUSR1', 'SIGUSR2'].forEach(signal => {
  process.on(signal, () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit();
  });
});

// add video IDs to this set if you know they don't work, to save time
let skipset = new Set([
  'YJxKvQ4R1GQ',
  'KRzQVD6LfCE',
  'nNgzAQINDtw',
  'Oz4yMGbRa4Q',
  'iyoB5erM-W8',
  'QAIy155xeh4',
  'GRSlGt26uUA',
  'ZhCAbDeLgTw',
  '6JN4RI7nkes',
  'piEayQ0T-qA',
  'AnHF0R8qd3M',
  'm3_I2rfApYk',
  '3e5Jn2gG8Eg',
  'QSlJ98eLHUc',
  '5hPsX3zQeX4',
  'NWs9dpCH9no',
  'zihZiGUKUS8',
  'btDMr-13d3g',
  'xlrhIiu1IWw',
  'tk862BbjWx4',
  'aYYUZ9rj5dI',
  'QMNGEY8OZqo',
  'q3vetCmqXAw',
  'tlI022aUWQQ',
  'Pyv1A8StJSs',
  'KrvXLbjTgMQ',
  '7FeXPOFRxp0',
  'n2AF_u-l50k',
  'aHRTtA7yTZ0',
  'agZ0xISi40E',
  'hVqIc3S3-jY',
  'XQuo4-t0p_8',
  'zJRxCPLPlgs',
  'gMdevp_JtsA',
  'mCoV-bKzee4',
  'HE1a9v1DX9I',
  'kaztRLkn2jM',
  'pe6zXj6-wRE',
  'BycqWYE3Ais',
  'e8zG7CYcj5E',
  '2LdMZF8N440',
  'swcsh8gyyIQ',
  'f3h-crOAr9U',
  'P5bmCEuGGuo',
  'VDWOGvTpk40',
  'F13e0FC0lgY',
  '4fErEShd8xM',
  'toap7iPpTbs',
  'QV2oTxX2oZc',
  'mxNPpte_6m4',
  'LMCu9DVizTM',
  '3ONwD9a9DWs',
  'rPLAEUIeo9U',
  'AHrth9lOfzo',
  'KGSz8v33IT4',
  'pwgN2gfb9Lw',
  'Twik7wqdwZU',
  'rqW4fYE3ZtA',
  'Y4Lc5-6L1pE',
  'cmskjWp6Dpc',
  '5q-9ovfEZnw',
  'vydPOjRVcSg',
  'Svq2Kscmmwc',
  'LkLBVMgsSHQ',
  'xujIDia0oug',
  'DIyruYQ-N4Q',
  'Qc23mwBnbNQ',
  'deg1wmYjwtk',
  'pI62ANEGK6Q',
  'YPKUbfIrlL8',
  'Td5xFxiEuQQ',
  'imfqczglelI',
  'CruQylWSfoU',
  'l6UZUhRdD6U',
  'F7yLL5fJxT4',
  'TCwQweljegc',
  '4orZQ9Z0WL4',
  'Pu5HzpQtPhg',
  'S3xOB-Bigc8',
  '7rqKcqx5WKs',
  '04bCRrUNSgA',
  'HcRW3FMuttY',
  'PwFUwXxfZss',
  'JbKDxHWPFac',
  '6acbBrLoi14',
  'BEz-vGJvaik',
  'eaEeEbP16Wg',
  'Swm8tTLWirU',
  '-4Zt5HxSCbo',
  'AVo0Q8G8tS8',
  'lryZpWsktRg',
  '5lBBUPVuusM',
  'w7ThvCb0zUk',
  '2E9m6yDEIj8',
  '-p7C5FrgAzU',
  'J5RkgDYKh3M',
  '3mMeEKGyngM',
  '2a9YgCCQYVI',
  'yQec8AuTouk',
  'YQw8xwEwNP4',
  'dpFEegAIFrI',
  '-ZQGgTZx98M',
  '8NmHZEKkkpM',
  '3zQsYJi5pFE',
  'ME1BcEcBD9I',
  'MYye1FqC8Ms',
  'zE1UwqD9W6g',
  'J94JU_Im75M',
  'aqR4_UoBIzY',
]);

for await (const entry of openedDir) {
  // Build the full path for the current entry
  const fullPath = path.join(entry.parentPath, entry.name);

  // Check if it's a file with .mp4 extension
  let ext = path.extname(entry.name);
  if (entry.isFile() && ext === '.mp4') {
    let videoID = path.basename(fullPath, ext);
    if (videoID.startsWith('.')) {
      // macOS generated file, probably
      continue;
    }
    if (skipset.has(videoID)) {
      continue;
    }
    const jsonPath = path.join(entry.parentPath, videoID + '.json');
    if (fs.existsSync(jsonPath)) {
      continue;
    }
    console.log(`fetching ${videoID}`);

    // yt-dlp writes the json to cwd
    // and the file name is the video name, not guessable
    const result = spawnSync(
      YT_DLP_PATH,
      ['--write-info-json', '--skip-download', `https://www.youtube.com/watch?v=${videoID}`],
      {
        stdio: 'pipe',
        encoding: 'utf-8',
        cwd: tempDir,
      },
    );
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      if (result.stderr.includes('members-only')) {
        console.error(`${videoID} is members-only; skipping`);
        continue;
      } else if (result.stderr.includes('confirm your age')) {
        console.error(`${videoID} is age gated; skipping (consider adding cookies)`);
        continue;
      } else if (result.stderr.includes('Private video')) {
        console.error(`${videoID} is private; skipping`);
        continue;
      } else if (result.stderr.includes('Video unavailable')) {
        console.error(`${videoID} has been removed; skipping`);
        continue;
      }
      throw new Error(`Command failed with exit code ${result.status}\nStderr: ${result.stderr}`);
    }
    let json = fs.readdirSync(tempDir).filter(file => path.extname(file).toLowerCase() === '.json');
    if (json.length !== 1) {
      throw new Error(`did not find json; tempdir contents: ${JSON.stringify(json)}`);
    }
    move(path.join(tempDir, json[0]), jsonPath);
    console.log(jsonPath);
    await sleep(1000);
  }
}

function move(source: string, destination: string) {
  try {
    fs.renameSync(source, destination);
  } catch (err: any) {
    if (err?.code !== 'EXDEV') {
      throw err;
    }
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}
