import { DatabaseSync } from 'node:sqlite';
import type { ChannelID, VideoID } from './util.ts';

const DB_PATH = './youtube_data.sqlite';

// TODO transactions!!
// https://github.com/nodejs/node/blob/a0139e06a0754058ffd891f779be55584665f8a8/test/parallel/test-sqlite-transactions.js

let db: DatabaseSync | undefined = new DatabaseSync(DB_PATH);

let existing = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all().map(({ name }) => name);
if (existing.length === 0) {
  db.exec(`
    CREATE TABLE channels (
        channel_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT
    ) STRICT;

    CREATE TABLE videos (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        extension TEXT NOT NULL,
        thumb_extension TEXT,
        duration_seconds INTEGER,
        upload_date TEXT NOT NULL,
        subtitle_languages TEXT NOT NULL, -- JSON of list of subtitle languages
        FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
    ) STRICT;

    CREATE INDEX idx_videos_channel_id ON videos(channel_id);
  `);
} else if (!(new Set(existing)).isSubsetOf(new Set(['channels', 'videos']))) {
  throw new Error(`${DB_PATH} exists but does not contain the data we expect`);
}

let addChannelStmt = db.prepare(`
    INSERT INTO channels (channel_id, title, description)
    VALUES (:channel_id, :title, :description)
`);

let addVideoStmt = db.prepare(`
    INSERT INTO videos (video_id, channel_id, title, description, extension, thumb_extension, duration_seconds, upload_date, subtitle_languages)
    VALUES (:video_id, :channel_id, :title, :description, :extension, :thumb_extension, :duration_seconds, :upload_date, :subtitle_languages)
`);

let isVideoInDbStmt = db.prepare(`
    SELECT 1 FROM videos WHERE video_id = ? LIMIT 1
`);

export interface Channel {
  channel_id: ChannelID;
  title: string;
  description: string | null;
}

export interface Video {
  video_id: VideoID;
  channel_id: ChannelID;
  title: string;
  description: string;
  extension: string;
  thumb_extension: string | null;
  duration_seconds: number;
  upload_date: string;
  subtitle_languages: string[];
}

export function addChannel(channel: Channel): void {
  addChannelStmt.run({
    ':channel_id': channel.channel_id,
    ':title': channel.title,
    ':description': channel.description,
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
    ':upload_date': video.upload_date,
    ':subtitle_languages': JSON.stringify(video.subtitle_languages),
  });
}

export function isVideoInDb(videoId: VideoID): boolean {
  return !!isVideoInDbStmt.get(videoId)
}

export function closeDb(): void {
  if (db) {
    console.log('Closing database connection.');
    db.close();
    db = undefined;
  }
}
