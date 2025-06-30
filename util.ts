import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import stream from 'stream';
import { pipeline } from 'stream/promises';

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

export function toChannelID(url: string): ChannelID | null {
  try {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.hostname === 'www.youtube.com' ||
      parsedUrl.hostname === 'youtube.com' ||
      parsedUrl.hostname === 'm.youtube.com'
    ) {
      const pathMatch = parsedUrl.pathname.match(/^\/channel\/([a-zA-Z0-9_-]+)/);
      if (pathMatch) {
        return pathMatch[1] as ChannelID;
      }
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

export async function move(source: string, destination: string) {
  try {
    await fsp.rename(source, destination);
  } catch (err: any) {
    if (err?.code !== 'EXDEV') {
      throw err;
    }
    await fsp.copyFile(source, destination);
    fs.unlinkSync(source);
  }
}

export class LRUCache<K, V> {
  private cache: Map<K, V>;
  private maxSize: number;

  constructor(maxSize: number) {
    if (maxSize <= 0) {
      throw new Error('Cache size must be positive');
    }
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);

    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }

    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      // Update existing key - delete and re-add to move to end
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Remove least recently used (first entry)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey!);
    }

    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  get capacity(): number {
    return this.maxSize;
  }

  [Symbol.iterator]() {
    return this.cache.entries();
  }
}

export async function fetchTo(url: string, targetDir: string, basename: string) {
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


// TODO consider whether we actually care about these
// https://github.com/nodejs/node/issues/58486
const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGUSR1', 'SIGUSR2'];
export function getTemp(base=os.tmpdir()): { [Symbol.dispose]: () => void; path: string; } {
  const tempDir = fs.mkdtempSync(path.join(base, 'tmp-localtube-'));
  console.log({ tempDir });
  function cleanup() {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  function cleanupAndExit() {
    cleanup();
    process.exit();
  }

  // TODO
  // process.on('exit', cleanup);
  // for (let signal of EXIT_SIGNALS) {
  //   process.on(signal, cleanupAndExit);
  // }

  return {
    [Symbol.dispose]() {
      cleanup();
      process.removeListener('exit', cleanup);
      for (let signal of EXIT_SIGNALS) {
        process.removeListener(signal, cleanupAndExit);
      }
    },
    path: tempDir,
  };
}

export async function lock(lockPath: string) {
  const absolutePath = path.resolve(lockPath);
  const lockFilePath = `${absolutePath}.localtube-lock`;

  const maxWaitTime = 60000; // 60 seconds
  const checkInterval = 1000; // 1 second
  const staleThreshold = 20000; // 20 seconds
  const startTime = Date.now();

  let elapsedTime = 0;

  while (elapsedTime < maxWaitTime) {
    try {
      const stats = await fsp.stat(lockFilePath);
      const fileAge = Date.now() - stats.mtime.getTime();

      if (fileAge > staleThreshold) {
        // File is stale, delete it and continue to try creating lock
        await fsp.unlink(lockFilePath);
      } else {
        // File exists and is fresh, wait and check again
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
        elapsedTime = Date.now() - startTime;
        continue;
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // File doesn't exist, continue to try creating lock
    }

    // Try to create the lock file (fail if it already exists)
    try {
      await fsp.writeFile(lockFilePath, '', { flag: 'wx' });
      // Successfully created lock file
      break;
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // Someone else got the lock, wait and try again
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
        elapsedTime = Date.now() - startTime;
        continue;
      } else {
        throw error;
      }
    }
  }

  if (elapsedTime >= maxWaitTime) {
    throw new Error(`Failed to acquire lock after ${maxWaitTime / 1000} seconds`);
  }

  function release() {
    try {
      fs.unlinkSync(lockFilePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // If file doesn't exist, that's fine - it's already "released"
    }
  }
  return {
    release,
    [Symbol.dispose]: release,
  };
}
