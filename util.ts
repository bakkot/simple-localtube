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
