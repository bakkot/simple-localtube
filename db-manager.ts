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
        avatar TEXT,
        banner TEXT,
        banner_uncropped TEXT
    ) STRICT;

    CREATE TABLE videos (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        extension TEXT NOT NULL,
        thumb_extension TEXT,
        duration_seconds INTEGER,
        upload_timestamp INTEGER NOT NULL,
        subtitle_languages TEXT NOT NULL, -- JSON of list of subtitle languages
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
  INSERT INTO channels (channel_id, channel, short_id, description, avatar, banner, banner_uncropped)
  VALUES (:channel_id, :channel, :short_id, :description, :avatar, :banner, :banner_uncropped)
`);

let addVideoStmt = db.prepare(`
  INSERT INTO videos (video_id, channel_id, title, description, extension, thumb_extension, duration_seconds, upload_timestamp, subtitle_languages)
  VALUES (:video_id, :channel_id, :title, :description, :extension, :thumb_extension, :duration_seconds, :upload_timestamp, :subtitle_languages)
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
  LIMIT ?
`);

let getVideoByIdStmt = db.prepare(`
  SELECT v.*, c.channel, c.short_id as channel_short_id, c.avatar
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
  LIMIT ?
`);

export interface Channel {
  channel_id: ChannelID;
  channel: string;
  short_id: string;
  description: string | null;
  avatar: string | null;
  banner: string | null;
  banner_uncropped: string | null;
}

export interface Video {
  video_id: VideoID;
  channel_id: ChannelID;
  title: string;
  description: string;
  extension: string;
  thumb_extension: string | null;
  duration_seconds: number;
  upload_timestamp: number;
  subtitle_languages: string[];
}

export interface VideoWithChannel extends Video {
  channel: string;
  channel_short_id: string;
  avatar?: string;
}

export function addChannel(channel: Channel): void {
  addChannelStmt.run({
    ':channel_id': channel.channel_id,
    ':channel': channel.channel,
    ':short_id': channel.short_id,
    ':description': channel.description,
    ':avatar': channel.avatar,
    ':banner': channel.banner,
    ':banner_uncropped': channel.banner_uncropped,
  });
}

export function addVideo(video: Video): void {
  addVideoStmt.run({
    ':video_id': video.video_id,
    ':channel_id': video.channel_id,
    ':title': video.title,
    ':description': video.description,
    ':extension': video.extension,
    ':thumb_extension': video.thumb_extension,
    ':duration_seconds': video.duration_seconds,
    ':upload_timestamp': video.upload_timestamp,
    ':subtitle_languages': JSON.stringify(video.subtitle_languages),
  });
}

export function isVideoInDb(videoId: VideoID): boolean {
  return !!isVideoInDbStmt.get(videoId)
}

export function resetMediaInDb() {
  resetVideos.run();
  resetChannels.run();
}

export function getRecentVideos(limit: number = 30): VideoWithChannel[] {
  const rows = getRecentVideosStmt.all(limit) as any[];
  return rows.map(row => ({
    ...row,
    subtitle_languages: JSON.parse(row.subtitle_languages)
  }));
}

export function getVideoById(videoId: VideoID): VideoWithChannel | null {
  const row = getVideoByIdStmt.get(videoId) as any;
  if (!row) return null;
  return {
    ...row,
    subtitle_languages: JSON.parse(row.subtitle_languages)
  };
}

export function getChannelByShortId(shortId: string): Channel | null {
  return getChannelByShortIdStmt.get(shortId) as unknown as  Channel | null;
}

export function getVideosByChannel(channelId: ChannelID, limit: number = 30): VideoWithChannel[] {
  const rows = getVideosByChannelStmt.all(channelId, limit) as any[];
  return rows.map(row => ({
    ...row,
    subtitle_languages: JSON.parse(row.subtitle_languages)
  }));
}

export function closeDb(): void {
  if (db) {
    console.log('Closing database connection.');
    db.close();
    db = undefined;
  }
}
