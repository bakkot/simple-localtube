import { DatabaseSync } from 'node:sqlite';

const DB_PATH = './youtube_data.sqlite';

let db = new DatabaseSync(DB_PATH);

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
        description TEXT,
        publish_date TEXT NOT NULL, -- TODO better type here
        duration_seconds INTEGER,
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
    INSERT INTO videos (video_id, channel_id, title, description, publish_date, duration_seconds)
    VALUES (:video_id, :channel_id, :title, :description, :publish_date, :duration_seconds)
`);

let isVideoInDbStmt = db.prepare(`
    SELECT 1 FROM videos WHERE video_id = ? LIMIT 1
`);

export interface Channel {
  channel_id: string;
  title: string;
  description?: string | null;
}

export interface Video {
  video_id: string;
  channel_id: string;
  title: string;
  description?: string | null;
  publish_date: string; // Recommend ISO 8601 format (YYYY-MM-DDTHH:MM:SSZ)
  duration_seconds?: number | null;
}

export function addChannel(channel: Channel): void {
  addChannelStmt.run({
    ':channel_id': channel.channel_id,
    ':title': channel.title,
    ':description': channel.description ?? null,
  });
}

export function addVideo(video: Video): void {
  addVideoStmt.run({
    ':video_id': video.video_id,
    ':channel_id': video.channel_id,
    ':title': video.title,
    ':description': video.description ?? null,
    ':publish_date': video.publish_date,
    ':duration_seconds': video.duration_seconds ?? null,
  });
}

export function isVideoInDb(videoId: string): boolean {
  return !!isVideoInDbStmt.get(videoId)
}

export function closeDb(): void {
  if (db) {
    console.log('Closing database connection.');
    db.close();
    // @ts-ignore // Allow db to be reassigned if needed later
    db = undefined; // Reset db variable
  }
}
