// assuming you have video files + metadata and subtitles as media/channel/VIDEOID.mp4, media/channel/VIDEOID.json, etc
// reorganize to media/channel/VIDEOID/video.mp4, media/channel/VIDEOID/video.json, etc

import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';

let { positionals } = parseArgs({ allowPositionals: true });
if (positionals.length !== 1) {
  console.log('Usage: node get-json.ts path-to-media-dir');
  process.exit(1);
}

let dir = positionals[0];

for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    reorganize(path.join(dir, entry.name));
  }
}

function reorganize(dirPath: string) {
  const files = fs.readdirSync(dirPath);

  // @ts-expect-error
  const fileGroups: Record<string, string[]> = { __proto__: null };

  for (let file of files) {
    const filePath = path.join(dirPath, file);
    if (fs.statSync(filePath).isDirectory()) {
      return;
    }

    const split = file.split('.');
    // Get base name without any extensions
    const baseName = split[0];
    if (baseName === '') continue; // hidden/macOS file

    if (!fileGroups[baseName]) {
      fileGroups[baseName] = [];
    }

    fileGroups[baseName].push(split.slice(1).join('.'));
  }

  for (let [baseName, exts] of Object.entries(fileGroups)) {
    let vids = exts.filter(ext => ext === 'mp4' || ext === 'webm');
    if (vids.length === 0) {
      console.log(`skipping ${dirPath + '/' + baseName}`);
      continue;
    } else if (vids.length > 1) {
      throw new Error(`multiple videos for ${dirPath + '/' + baseName}`);
    }

    const newDirPath = path.join(dirPath, baseName);
    if (!fs.existsSync(newDirPath)) {
      fs.mkdirSync(newDirPath);
    }

    for (let ext of exts) {
      const oldPath = path.join(dirPath, baseName + '.' + ext);
      let newFileName;

      if (ext === 'mp4' || ext === 'webm') {
        newFileName = 'video.' + ext;
      } else if (ext === 'json') {
        newFileName = 'data.json';
      } else if (ext.endsWith('vtt')) {
        newFileName = 'subs.' + ext;
      } else {
        throw new Error(`unrecognized file ${dirPath + '/' + baseName + '.' + ext}`)
      }

      const newPath = path.join(newDirPath, newFileName);
      fs.renameSync(oldPath, newPath);
      console.log(`${oldPath} -> ${newPath}`);
    }
  }
}
