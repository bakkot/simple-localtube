import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import type { ChannelID, VideoID } from './util.ts';

// TODO configurable
const DB_PATH = path.join(import.meta.dirname, './youtube_data.sqlite');

// TODO transactions!!
// https://github.com/nodejs/node/blob/a0139e06a0754058ffd891f779be55584665f8a8/test/parallel/test-sqlite-transactions.js

let db: DatabaseSync | undefined = new DatabaseSync(DB_PATH);

let existing = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all().map(({ name }) => name);
if (existing.length === 0) {
  db.exec(`
    CREATE TABLE channels (
        channel_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        short_id TEXT NOT NULL,
        description TEXT,
        avatar_filename TEXT,
        banner_filename TEXT,
        banner_uncropped_filename TEXT
    ) STRICT;

    CREATE TABLE videos (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        video_filename TEXT NOT NULL,
        thumb_filename TEXT,
        duration_seconds INTEGER,
        upload_timestamp INTEGER NOT NULL,
        subtitles TEXT NOT NULL, -- JSON of { lang: file }; TODO use native json support?
        FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
    ) STRICT;

    CREATE INDEX idx_videos_channel_id ON videos(channel_id);
    CREATE INDEX idx_videos_upload_timestamp ON videos(upload_timestamp);
    CREATE INDEX idx_videos_channel_upload ON videos(channel_id, upload_timestamp DESC);
    CREATE INDEX idx_channels_short_id ON channels(short_id);
  `);
} else if (!(new Set(existing)).isSubsetOf(new Set(['channels', 'videos']))) {
  throw new Error(`${DB_PATH} exists but does not contain the data we expect`);
}

let addChannelStmt = db.prepare(`
  INSERT INTO channels (channel_id, channel, short_id, description, avatar_filename, banner_filename, banner_uncropped_filename)
  VALUES (:channel_id, :channel, :short_id, :description, :avatar_filename, :banner_filename, :banner_uncropped_filename)
  ON CONFLICT(channel_id) DO UPDATE SET
    channel = CASE
      WHEN :channel IS NOT NULL AND :channel != '' THEN :channel
      ELSE channels.channel
    END,
    short_id = CASE
      WHEN :short_id IS NOT NULL AND :short_id != '' THEN :short_id
      ELSE channels.short_id
    END,
    description = CASE
      WHEN :description IS NOT NULL AND :description != '' THEN :description
      ELSE channels.description
    END,
    avatar_filename = CASE
      WHEN :avatar_filename IS NOT NULL AND :avatar_filename != '' THEN :avatar_filename
      ELSE channels.avatar_filename
    END,
    banner_filename = CASE
      WHEN :banner_filename IS NOT NULL AND :banner_filename != '' THEN :banner_filename
      ELSE channels.banner_filename
    END,
    banner_uncropped_filename = CASE
      WHEN :banner_uncropped_filename IS NOT NULL AND :banner_uncropped_filename != '' THEN :banner_uncropped_filename
      ELSE channels.banner_uncropped_filename
    END
`);

let addVideoStmt = db.prepare(`
  INSERT INTO videos (video_id, channel_id, title, description, video_filename, thumb_filename, duration_seconds, upload_timestamp, subtitles)
  VALUES (:video_id, :channel_id, :title, :description, :video_filename, :thumb_filename, :duration_seconds, :upload_timestamp, :subtitles)
`);

let isVideoInDbStmt = db.prepare(`
  SELECT 1 FROM videos WHERE video_id = ? LIMIT 1
`);

let resetVideos = db.prepare(`
  DELETE FROM videos;
`);

let resetChannels = db.prepare(`
  DELETE FROM channels;
`);

let getRecentVideosStmt = db.prepare(`
  SELECT v.*, c.channel, c.short_id as channel_short_id
  FROM videos v
  JOIN channels c ON v.channel_id = c.channel_id
  ORDER BY v.upload_timestamp DESC
  LIMIT ? OFFSET ?
`);

let getVideoByIdStmt = db.prepare(`
  SELECT v.*, c.channel, c.short_id as channel_short_id, c.avatar_filename
  FROM videos v
  JOIN channels c ON v.channel_id = c.channel_id
  WHERE v.video_id = ?
`);

let getChannelByShortIdStmt = db.prepare(`
  SELECT * FROM channels WHERE short_id = ?
`);

let getVideosByChannelStmt = db.prepare(`
  SELECT v.*, c.channel, c.short_id as channel_short_id
  FROM videos v
  JOIN channels c ON v.channel_id = c.channel_id
  WHERE v.channel_id = ?
  ORDER BY v.upload_timestamp DESC
  LIMIT ? OFFSET ?
`);

let channelExistsStmt = db.prepare(`
  SELECT 1 FROM channels WHERE channel_id = ? LIMIT 1
`);

let getAllChannelsStmt = db.prepare(`
  SELECT channel_id, channel FROM channels ORDER BY channel
`);

export interface Channel {
  channel_id: ChannelID;
  channel: string;
  short_id: string;
  description: string | null;
  avatar_filename: string | null;
  banner_filename: string | null;
  banner_uncropped_filename: string | null;
}

export interface Video {
  video_id: VideoID;
  channel_id: ChannelID;
  title: string;
  description: string;
  video_filename: string;
  thumb_filename: string | null;
  duration_seconds: number;
  upload_timestamp: number;
  subtitles: Record<string, string>;
}

export interface VideoWithChannel extends Video {
  channel: string;
  channel_short_id: string;
  avatar_filename?: string;
}

export function addChannel(channel: Channel): void {
  addChannelStmt.run({
    ':channel_id': channel.channel_id,
    ':channel': channel.channel,
    ':short_id': channel.short_id,
    ':description': channel.description,
    ':avatar_filename': channel.avatar_filename,
    ':banner_filename': channel.banner_filename,
    ':banner_uncropped_filename': channel.banner_uncropped_filename,
  });
}

export function addVideo(video: Video): void {
  addVideoStmt.run({
    ':video_id': video.video_id,
    ':channel_id': video.channel_id,
    ':title': video.title,
    ':description': video.description,
    ':video_filename': video.video_filename,
    ':thumb_filename': video.thumb_filename,
    ':duration_seconds': video.duration_seconds,
    ':upload_timestamp': video.upload_timestamp,
    ':subtitles': JSON.stringify(video.subtitles),
  });
}

export function isVideoInDb(videoId: VideoID): boolean {
  return !!isVideoInDbStmt.get(videoId)
}

export function resetMediaInDb() {
  resetVideos.run();
  resetChannels.run();
}

export function getRecentVideosForChannels(channelIds: Set<ChannelID> | 'all', limit: number = 30, offset: number = 0): VideoWithChannel[] {
  if (channelIds === 'all') {
    const rows = getRecentVideosStmt.all(limit, offset) as any[];
    return rows.map(row => ({
      ...row,
      subtitles: JSON.parse(row.subtitles)
    }));
  }
  if (channelIds.size === 0) return [];

  // TODO someday we should probably cache this
  const placeholders = [...channelIds].map(() => '?').join(',');
  const stmt = db!.prepare(`
    SELECT v.*, c.channel, c.short_id as channel_short_id
    FROM videos v
    JOIN channels c ON v.channel_id = c.channel_id
    WHERE v.channel_id IN (${placeholders})
    ORDER BY v.upload_timestamp DESC
    LIMIT ? OFFSET ?
  `);

  const rows = stmt.all(...channelIds, limit, offset) as any[];
  return rows.map(row => ({
    ...row,
    subtitles: JSON.parse(row.subtitles)
  }));
}

export function getVideoById(videoId: VideoID): VideoWithChannel | null {
  const row = getVideoByIdStmt.get(videoId) as any;
  if (!row) return null;
  return {
    ...row,
    subtitles: JSON.parse(row.subtitles)
  };
}

export function getChannelByShortId(shortId: string): Channel | null {
  return getChannelByShortIdStmt.get(shortId) as unknown as  Channel | null;
}

export function getVideosByChannel(channelId: ChannelID, limit: number = 30, offset: number = 0): VideoWithChannel[] {
  const rows = getVideosByChannelStmt.all(channelId, limit, offset) as any[];
  return rows.map(row => ({
    ...row,
    subtitles: JSON.parse(row.subtitles)
  }));
}

export function channelExists(channelId: ChannelID): boolean {
  return !!channelExistsStmt.get(channelId);
}

export function getAllChannels(): { channel_id: ChannelID; channel: string }[] {
  return getAllChannelsStmt.all() as { channel_id: ChannelID; channel: string }[];
}

export function getChannelsForUser(allowedChannels: Set<ChannelID> | 'all'): { channel_id: ChannelID; channel: string }[] {
  if (allowedChannels === 'all') {
    return getAllChannelsStmt.all() as { channel_id: ChannelID; channel: string }[];
  }

  if (allowedChannels.size === 0) return [];

  const placeholders = [...allowedChannels].map(() => '?').join(',');
  const stmt = db!.prepare(`
    SELECT channel_id, channel FROM channels
    WHERE channel_id IN (${placeholders})
    ORDER BY channel
  `);

  return stmt.all(...allowedChannels) as { channel_id: ChannelID; channel: string }[];
}

export function closeDb(): void {
  if (db) {
    console.log('Closing database connection.');
    db.close();
    db = undefined;
  }
}
