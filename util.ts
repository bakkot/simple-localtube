import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import stream from 'stream';
import { pipeline } from 'stream/promises';

export type VideoID = string & { __brand: "video id" };
export type ChannelID = string & { __brand: "channel id" };

function isVideoId(string: string): string is VideoID {
  return /^[a-zA-Z0-9_-]{11}$/.test(string);
}

export function toVideoID(url: string): VideoID | null {
  if (isVideoId(url)) return url;
  try {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.hostname === 'www.youtube.com' ||
      parsedUrl.hostname === 'youtube.com' ||
      parsedUrl.hostname === 'm.youtube.com'
    ) {
      let res = parsedUrl.searchParams.get('v');
      if (res && isVideoId(res)) return res;
      const shortsMatch = parsedUrl.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
      if (shortsMatch && isVideoId(shortsMatch[1])) return shortsMatch[1];
    } else if (parsedUrl.hostname === 'youtu.be') {
      let res = parsedUrl.pathname.substring(1);
      if (res.length > 0 && isVideoId(res)) return res;
    }
  } catch {
    // pass
  }
  return null;
}

export function channelIDFromCanonicalURL(url: string): ChannelID | null {
  try {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.hostname === 'www.youtube.com' ||
      parsedUrl.hostname === 'youtube.com' ||
      parsedUrl.hostname === 'm.youtube.com'
    ) {
      const pathMatch = parsedUrl.pathname.match(/^\/channel\/(UC[a-zA-Z0-9_-]+)/);
      if (pathMatch) {
        return pathMatch[1] as ChannelID;
      }
    }
  } catch {
    // pass
  }
  return null;
}

export function throwIfNotInit(value: null): never;
export function throwIfNotInit<T>(value: T | null): asserts value is T;
export function throwIfNotInit<T>(value: T | null): void {
  if (value === null) throw new Error('Database not initialized; call init() first');
}

export function assertChannelId(thing: string): ChannelID {
  if (/^UC[a-zA-Z0-9_-]{22}$/.test(thing)) {
    return thing as ChannelID;
  }
  throw new Error(`input ${JSON.stringify(thing)} does not appear to be a valid channel ID`);
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
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
  await pipeline(stream.Readable.fromWeb(response.body! as unknown as import('stream/web').ReadableStream), fs.createWriteStream(filepath));

  return filename;
}

const imageMimeToExt: Record<string, string | undefined> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  // @ts-expect-error https://github.com/microsoft/TypeScript/issues/38385
  __proto__: null,
};


export function getTemp(base=os.tmpdir()): { [Symbol.dispose]: () => void; path: string; } {
  const tempDir = fs.mkdtempSync(path.join(base, 'tmp-localtube-'));
  // console.log({ tempDir });
  function cleanup() {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    [Symbol.dispose]() {
      cleanup();
      process.removeListener('exit', cleanup);
    },
    path: tempDir,
  };
}



export function vttToText(vtt: string): string {
  let lines = vtt.split('\n');
  let textLines: string[] = [];
  let inCuePayload = false;
  let skipBlock = false;
  for (let line of lines) {
    line = line.trim();
    if (line === '') {
      inCuePayload = false;
      skipBlock = false;
      continue;
    }
    if (skipBlock) continue;
    if (line.startsWith('WEBVTT') || line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) {
      skipBlock = true;
      continue;
    }
    if (line.includes('-->')) {
      inCuePayload = true;
      continue;
    }
    if (inCuePayload) {
      // yes yes we should do other entities too but whatever
      textLines.push(line.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '\u00A0'));
    }
  }
  return textLines.join('\n');
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      // File doesn't exist, continue to try creating lock
    }

    // Try to create the lock file (fail if it already exists)
    try {
      await fsp.writeFile(lockFilePath, '', { flag: 'wx' });
      // Successfully created lock file
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
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

export class ErrorWithStderr extends Error {
  stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

export function spawnAsync(command: string, options: { cwd?: string; print?: boolean; } = {}): Promise<{ stdout: string; stderr: string; }> {
  const { print, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, ...spawnOptions });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      const str = data.toString();
      stdout += str;
      if (print) process.stdout.write(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      const str = data.toString();
      stderr += str;
      if (print) process.stderr.write(data);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const err = new ErrorWithStderr(`Command failed with exit code ${code}`, stderr);
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}


export type ThumbnailJSON = { id: string; url: string; width: number; height: number };
export type ChannelDataJSON = {
  thumbnails: ThumbnailJSON[];
  channel: string;
  description: string | null;
  uploader_id: string;
};
