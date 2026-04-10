import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'path';
import type { ChannelID, VideoID } from './util.ts';
import { assertChannelId, throwIfNotInit } from './util.ts';

let db: DatabaseSync | null = null;

let getAllFullStmt: StatementSync | null = null;
let getByStatusStmt: StatementSync | null = null;
let getOneByStatusStmt: StatementSync | null = null;
let getByIdStmt: StatementSync | null = null;
let insertStmt: StatementSync | null = null;
let deleteStmt: StatementSync | null = null;
let updateStatusStmt: StatementSync | null = null;
let clearTitleStmt: StatementSync | null = null;
let clearRecentLimitStmt: StatementSync | null = null;
let decrementRecentLimitStmt: StatementSync | null = null;

let getAllVideosStmt: StatementSync | null = null;
let getOneVideoStmt: StatementSync | null = null;
let getVideoByIdStmt: StatementSync | null = null;
let insertVideoStmt: StatementSync | null = null;
let deleteVideoStmt: StatementSync | null = null;

let getUnavailableVideoStmt: StatementSync | null = null;
let insertUnavailableVideoStmt: StatementSync | null = null;

export function init(dbDir: string): void {
  const SUBSCRIPTIONS_DB_PATH = path.join(dbDir, 'subscriptions.sqlite');

  db = new DatabaseSync(SUBSCRIPTIONS_DB_PATH, {
    timeout: 1000,
  });

  let existing = new Set(db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all().map(({ name }) => name));
  if (!existing.has('channels')) {
    db.exec(`
      CREATE TABLE channels (
          channel_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK(status IN ('subscribing', 'subscribed')),
          title TEXT,
          recent_limit INTEGER CHECK(recent_limit IS NULL OR recent_limit >= 1),
          avatar BLOB,
          avatar_mime TEXT
      ) STRICT;
    `);
  }
  if (!existing.has('videos')) {
    db.exec(`
      CREATE TABLE videos (
          video_id TEXT PRIMARY KEY,
          title TEXT,
          channel_id TEXT,
          channel_name TEXT,
          thumbnail BLOB
      ) STRICT;
    `);
  }
  if (!existing.has('unavailable_videos')) {
    db.exec(`
      CREATE TABLE unavailable_videos (
          video_id TEXT PRIMARY KEY,
          reason TEXT NOT NULL CHECK(reason IN ('members-only', 'age-gated'))
      ) STRICT;
    `);
  }

  getAllFullStmt = db.prepare('SELECT channel_id, status, title, recent_limit, avatar, avatar_mime FROM channels');
  getByStatusStmt = db.prepare('SELECT channel_id FROM channels WHERE status = ?');
  getOneByStatusStmt = db.prepare('SELECT channel_id, recent_limit FROM channels WHERE status = ? LIMIT 1');
  getByIdStmt = db.prepare('SELECT channel_id, status, title FROM channels WHERE channel_id = ?');
  insertStmt = db.prepare('INSERT INTO channels (channel_id, status, title, recent_limit, avatar, avatar_mime) VALUES (?, ?, ?, ?, ?, ?)');
  deleteStmt = db.prepare('DELETE FROM channels WHERE channel_id = ?');
  updateStatusStmt = db.prepare('UPDATE channels SET status = ? WHERE channel_id = ?');
  clearTitleStmt = db.prepare('UPDATE channels SET title = NULL WHERE channel_id = ?');
  clearRecentLimitStmt = db.prepare('UPDATE channels SET recent_limit = NULL WHERE channel_id = ?');
  decrementRecentLimitStmt = db.prepare('UPDATE channels SET recent_limit = recent_limit - 1 WHERE channel_id = ? AND recent_limit IS NOT NULL');

  getAllVideosStmt = db.prepare('SELECT video_id, title, channel_id, channel_name, thumbnail FROM videos');
  getOneVideoStmt = db.prepare('SELECT video_id, title, channel_id, channel_name, thumbnail FROM videos LIMIT 1');
  getVideoByIdStmt = db.prepare('SELECT video_id FROM videos WHERE video_id = ?');
  insertVideoStmt = db.prepare('INSERT INTO videos (video_id, title, channel_id, channel_name, thumbnail) VALUES (?, ?, ?, ?, ?)');
  deleteVideoStmt = db.prepare('DELETE FROM videos WHERE video_id = ?');

  getUnavailableVideoStmt = db.prepare('SELECT reason FROM unavailable_videos WHERE video_id = ?');
  insertUnavailableVideoStmt = db.prepare('INSERT OR REPLACE INTO unavailable_videos (video_id, reason) VALUES (?, ?)');
}

export type UnavailableReason = 'members-only' | 'age-gated';

export function markVideoUnavailable(videoId: VideoID, reason: UnavailableReason): void {
  throwIfNotInit(insertUnavailableVideoStmt);
  insertUnavailableVideoStmt.run(videoId, reason);
}

export function getVideoUnavailableReason(videoId: VideoID): UnavailableReason | null {
  throwIfNotInit(getUnavailableVideoStmt);
  const row = getUnavailableVideoStmt.get(videoId) as { reason: string } | undefined;
  return row ? (row.reason as UnavailableReason) : null;
}

export type SubscriptionChannel = {
  channelId: ChannelID;
  status: 'subscribing' | 'subscribed';
  title: string | null;
  recentLimit: number | null;
  avatar: { data: Uint8Array; mime: string } | null;
};

export function getSubscriptionData(): SubscriptionChannel[] {
  throwIfNotInit(getAllFullStmt);
  const rows = getAllFullStmt.all() as { channel_id: string; status: string; title: string | null; recent_limit: number | null; avatar: Uint8Array | null; avatar_mime: string | null }[];
  return rows.map(row => ({
    channelId: assertChannelId(row.channel_id),
    status: row.status as 'subscribing' | 'subscribed',
    title: row.title,
    recentLimit: row.recent_limit,
    avatar: row.avatar != null ? { data: row.avatar, mime: row.avatar_mime ?? 'image/jpeg' } : null,
  }));
}

export function addSubscription(channelId: ChannelID, title: string, recentLimit: number | null, avatar: Uint8Array | null, avatarMime: string | null): void {
  throwIfNotInit(getByIdStmt);
  throwIfNotInit(insertStmt);
  const existing = getByIdStmt.get(channelId) as { channel_id: string } | undefined;
  if (existing) {
    throw new Error('Channel is already in subscriptions');
  }
  insertStmt.run(channelId, 'subscribing', title, recentLimit, avatar, avatarMime);
}

export function removeSubscription(channelId: ChannelID): void {
  throwIfNotInit(getByIdStmt);
  throwIfNotInit(deleteStmt);
  const existing = getByIdStmt.get(channelId) as { channel_id: string } | undefined;
  if (!existing) {
    throw new Error(`Channel ${channelId} is not in subscriptions`);
  }
  deleteStmt.run(channelId);
}

export function decrementRecentLimit(channelId: ChannelID): void {
  throwIfNotInit(decrementRecentLimitStmt);
  decrementRecentLimitStmt.run(channelId);
}

export function markSubscribed(channelId: ChannelID): void {
  throwIfNotInit(updateStatusStmt);
  throwIfNotInit(clearTitleStmt);
  throwIfNotInit(clearRecentLimitStmt);
  updateStatusStmt.run('subscribed', channelId);
  clearTitleStmt.run(channelId);
  clearRecentLimitStmt.run(channelId);
}

export function getSubscribing(): ChannelID[] {
  throwIfNotInit(getByStatusStmt);
  const rows = getByStatusStmt.all('subscribing') as { channel_id: string }[];
  return rows.map(r => assertChannelId(r.channel_id));
}

export function getOneSubscribing(): { channelId: ChannelID; recentLimit: number | null } | null {
  throwIfNotInit(getOneByStatusStmt);
  const row = getOneByStatusStmt.get('subscribing') as { channel_id: string; recent_limit: number | null } | undefined;
  return row ? { channelId: assertChannelId(row.channel_id), recentLimit: row.recent_limit } : null;
}

export function getSubscribed(): ChannelID[] {
  throwIfNotInit(getByStatusStmt);
  const rows = getByStatusStmt.all('subscribed') as { channel_id: string }[];
  return rows.map(r => assertChannelId(r.channel_id));
}

export function isSubscribed(channelId: ChannelID): boolean {
  throwIfNotInit(getByIdStmt);
  const row = getByIdStmt.get(channelId) as { status: string } | undefined;
  return row?.status === 'subscribed';
}

export function isInSubscriptions(channelId: ChannelID): boolean {
  throwIfNotInit(getByIdStmt);
  return getByIdStmt.get(channelId) != null;
}

export interface QueuedVideo {
  video_id: VideoID;
  title: string | null;
  channel_id: ChannelID | null;
  channel_name: string | null;
  thumbnail: Uint8Array | null;
}

export function getVideoQueue(): QueuedVideo[] {
  throwIfNotInit(getAllVideosStmt);
  const rows = getAllVideosStmt.all() as { video_id: string; title: string | null; channel_id: string | null; channel_name: string | null; thumbnail: Uint8Array | null }[];
  return rows.map(r => ({
    video_id: r.video_id as VideoID,
    title: r.title,
    channel_id: r.channel_id as ChannelID | null,
    channel_name: r.channel_name,
    thumbnail: r.thumbnail,
  }));
}

export function getOneQueuedVideo(): QueuedVideo | null {
  throwIfNotInit(getOneVideoStmt);
  const r = getOneVideoStmt.get() as { video_id: string; title: string | null; channel_id: string | null; channel_name: string | null; thumbnail: Uint8Array | null } | undefined;
  if (!r) return null;
  return {
    video_id: r.video_id as VideoID,
    title: r.title,
    channel_id: r.channel_id as ChannelID | null,
    channel_name: r.channel_name,
    thumbnail: r.thumbnail,
  };
}

export function addVideoToQueue(videoId: VideoID, title: string | null, channelId: ChannelID | null, channelName: string | null, thumbnail: Uint8Array | null): void {
  throwIfNotInit(getVideoByIdStmt);
  throwIfNotInit(insertVideoStmt);
  const existing = getVideoByIdStmt.get(videoId) as { video_id: string } | undefined;
  if (existing) {
    throw new Error('Video is already in the queue');
  }
  insertVideoStmt.run(videoId, title, channelId, channelName, thumbnail);
}

export function removeVideoFromQueue(videoId: VideoID): void {
  throwIfNotInit(getVideoByIdStmt);
  throwIfNotInit(deleteVideoStmt);
  const existing = getVideoByIdStmt.get(videoId) as { video_id: string } | undefined;
  if (!existing) {
    throw new Error(`Video ${videoId} is not in the queue`);
  }
  deleteVideoStmt.run(videoId);
}

export function isVideoInQueue(videoId: VideoID): boolean {
  throwIfNotInit(getVideoByIdStmt);
  return getVideoByIdStmt.get(videoId) != null;
}

export function closeSubscriptionsDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
