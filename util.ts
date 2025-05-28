import fs from 'fs';

export type VideoID = string & { __brand: "video id" };
export type ChannelID = string & { __brand: "channel id" };

export function toVideoID(url: string): VideoID | null {
  try {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.hostname === 'www.youtube.com' ||
      parsedUrl.hostname === 'youtube.com' ||
      parsedUrl.hostname === 'm.youtube.com'
    ) {
      let res = parsedUrl.searchParams.get('v');
      if (res) return res as VideoID;
    } else if (parsedUrl.hostname === 'youtu.be') {
      let res = parsedUrl.pathname.substring(1);
      if (res.length > 0) return res as VideoID;
    }
  } catch {
    // pass
  }
  return null;
}

export function nameExt(file: string): { name: string, ext: string } {
  let split = file.split('.');
  if (split.length === 1) {
    throw new Error(`no extension: ${file}`);
  }
  return { name: split.slice(0, -1).join('.'), ext: split.at(-1)! };
}

// TODO this probably actually _should_ be async...
export function move(source: string, destination: string) {
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
