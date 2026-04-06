import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'path';
import type { ChannelID, VideoID } from './util.ts';
import { throwIfNotInit } from './util.ts';

let db: DatabaseSync | null = null;

let addChannelStmt: StatementSync | null = null;
let addVideoStmt: StatementSync | null = null;
let isVideoInDbStmt: StatementSync | null = null;
let resetVideos: StatementSync | null = null;
let resetChannels: StatementSync | null = null;
let getRecentVideosStmt: StatementSync | null = null;
let getVideoByIdStmt: StatementSync | null = null;
let getChannelByIdStmt: StatementSync | null = null;
let getChannelByShortIdStmt: StatementSync | null = null;
let getVideosByChannelStmt: StatementSync | null = null;
let channelExistsStmt: StatementSync | null = null;
let getAllChannelsStmt: StatementSync | null = null;
let searchVideosStmt: StatementSync | null = null;
let searchChannelsStmt: StatementSync | null = null;

const channelSortOrders = {
  'recent': 'latest_upload_timestamp DESC',
  'oldest': 'latest_upload_timestamp ASC',
  'a-z': 'channel_title ASC',
  'z-a': 'channel_title DESC',
} as const;
export type ChannelSort = keyof typeof channelSortOrders;

let channelSortStmts: Record<ChannelSort, StatementSync> | null = null;

export function init(dbDir: string): void {
  const DB_PATH = path.join(dbDir, 'youtube_data.sqlite');

  db = new DatabaseSync(DB_PATH, {
    timeout: 1000,
  });

  let existing = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all().map(({ name }) => name);
  if (existing.length === 0) {
    db.exec(`
      CREATE TABLE channels (
          channel_id TEXT PRIMARY KEY,
          channel_title TEXT NOT NULL,
          short_id TEXT NOT NULL UNIQUE,
          description TEXT,
          avatar_filename TEXT,
          banner_filename TEXT,
          banner_uncropped_filename TEXT,
          latest_upload_timestamp INTEGER,
          video_count INTEGER NOT NULL DEFAULT 0
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
          subtitles_files TEXT NOT NULL,
          subtitles_text TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
      ) STRICT;

      -- Video indexes
      CREATE INDEX idx_videos_channel_id ON videos(channel_id);
      CREATE INDEX idx_videos_upload_timestamp ON videos(upload_timestamp);
      CREATE INDEX idx_videos_channel_upload ON videos(channel_id, upload_timestamp DESC);
      CREATE INDEX idx_videos_duration_seconds ON videos(duration_seconds);
      CREATE INDEX idx_videos_channel_duration_seconds ON videos(channel_id, duration_seconds);

      -- Channel indexes
      CREATE INDEX idx_channels_latest ON channels(latest_upload_timestamp DESC);
      CREATE INDEX idx_channels_title ON channels(channel_title);
      CREATE INDEX idx_channels_video_count ON channels(video_count DESC);

      -- FTS5 indexes
      CREATE VIRTUAL TABLE videos_fts USING fts5(
        title, description, subtitles_text,
        content=videos, content_rowid=rowid
      );

      CREATE VIRTUAL TABLE channels_fts USING fts5(
        channel_title, description,
        content=channels, content_rowid=rowid
      );

      -- Triggers: video count / latest_upload_timestamp
      CREATE TRIGGER trg_videos_after_insert AFTER INSERT ON videos
      BEGIN
          UPDATE channels
          SET video_count = video_count + 1,
              latest_upload_timestamp = MAX(COALESCE(latest_upload_timestamp, 0), NEW.upload_timestamp)
          WHERE channel_id = NEW.channel_id;
          INSERT INTO videos_fts(rowid, title, description, subtitles_text)
          VALUES (NEW.rowid, NEW.title, NEW.description, NEW.subtitles_text);
      END;

      CREATE TRIGGER trg_videos_before_delete BEFORE DELETE ON videos
      BEGIN
          INSERT INTO videos_fts(videos_fts, rowid, title, description, subtitles_text)
          VALUES ('delete', OLD.rowid, OLD.title, OLD.description, OLD.subtitles_text);
      END;

      CREATE TRIGGER trg_videos_after_delete AFTER DELETE ON videos
      BEGIN
          UPDATE channels
          SET video_count = video_count - 1,
              latest_upload_timestamp = (
                  SELECT MAX(upload_timestamp) FROM videos WHERE channel_id = OLD.channel_id
              )
          WHERE channel_id = OLD.channel_id;
      END;

      CREATE TRIGGER trg_videos_before_update BEFORE UPDATE ON videos
      BEGIN
          INSERT INTO videos_fts(videos_fts, rowid, title, description, subtitles_text)
          VALUES ('delete', OLD.rowid, OLD.title, OLD.description, OLD.subtitles_text);
      END;

      CREATE TRIGGER trg_videos_after_update AFTER UPDATE OF upload_timestamp, channel_id ON videos
      BEGIN
          UPDATE channels
          SET video_count = video_count - 1,
              latest_upload_timestamp = (
                  SELECT MAX(upload_timestamp) FROM videos WHERE channel_id = OLD.channel_id
              )
          WHERE channel_id = OLD.channel_id;
          UPDATE channels
          SET video_count = video_count + 1,
              latest_upload_timestamp = (
                  SELECT MAX(upload_timestamp) FROM videos WHERE channel_id = NEW.channel_id
              )
          WHERE channel_id = NEW.channel_id;
          INSERT INTO videos_fts(rowid, title, description, subtitles_text)
          VALUES (NEW.rowid, NEW.title, NEW.description, NEW.subtitles_text);
      END;

      -- Triggers: channels FTS sync
      CREATE TRIGGER trg_channels_fts_insert AFTER INSERT ON channels
      BEGIN
          INSERT INTO channels_fts(rowid, channel_title, description)
          VALUES (NEW.rowid, NEW.channel_title, NEW.description);
      END;

      CREATE TRIGGER trg_channels_fts_before_delete BEFORE DELETE ON channels
      BEGIN
          INSERT INTO channels_fts(channels_fts, rowid, channel_title, description)
          VALUES ('delete', OLD.rowid, OLD.channel_title, OLD.description);
      END;

      CREATE TRIGGER trg_channels_fts_before_update BEFORE UPDATE ON channels
      BEGIN
          INSERT INTO channels_fts(channels_fts, rowid, channel_title, description)
          VALUES ('delete', OLD.rowid, OLD.channel_title, OLD.description);
      END;

      CREATE TRIGGER trg_channels_fts_after_update AFTER UPDATE ON channels
      BEGIN
          INSERT INTO channels_fts(rowid, channel_title, description)
          VALUES (NEW.rowid, NEW.channel_title, NEW.description);
      END;
    `);
  } else if (!existing.includes('channels') || !existing.includes('videos')) {
    throw new Error(`${DB_PATH} exists but does not contain the data we expect`);
  }

  addChannelStmt = db.prepare(`
    INSERT INTO channels (channel_id, channel_title, short_id, description, avatar_filename, banner_filename, banner_uncropped_filename)
    VALUES (:channel_id, :channel_title, :short_id, :description, :avatar_filename, :banner_filename, :banner_uncropped_filename)
    ON CONFLICT(channel_id) DO UPDATE SET
      channel_title = CASE
        WHEN :channel_title IS NOT NULL AND :channel_title != '' THEN :channel_title
        ELSE channels.channel_title
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

  addVideoStmt = db.prepare(`
    INSERT INTO videos (video_id, channel_id, title, description, video_filename, thumb_filename, duration_seconds, upload_timestamp, subtitles_files, subtitles_text)
    VALUES (:video_id, :channel_id, :title, :description, :video_filename, :thumb_filename, :duration_seconds, :upload_timestamp, :subtitles_files, :subtitles_text)
    ON CONFLICT(video_id) DO UPDATE SET
    channel_id = CASE
      WHEN :channel_id IS NOT NULL AND :channel_id != '' THEN :channel_id
      ELSE videos.channel_id
    END,
    title = CASE
      WHEN :title IS NOT NULL AND :title != '' THEN :title
      ELSE videos.title
    END,
    description = CASE
      WHEN :description IS NOT NULL AND :description != '' THEN :description
      ELSE videos.description
    END,
    video_filename = CASE
      WHEN :video_filename IS NOT NULL AND :video_filename != '' THEN :video_filename
      ELSE videos.video_filename
    END,
    thumb_filename = CASE
      WHEN :thumb_filename IS NOT NULL AND :thumb_filename != '' THEN :thumb_filename
      ELSE videos.thumb_filename
    END,
    duration_seconds = CASE
      WHEN :duration_seconds IS NOT NULL THEN :duration_seconds
      ELSE videos.duration_seconds
    END,
    upload_timestamp = CASE
      WHEN :upload_timestamp IS NOT NULL THEN :upload_timestamp
      ELSE videos.upload_timestamp
    END,
    subtitles_files = CASE
      WHEN :subtitles_files IS NOT NULL AND :subtitles_files != '' THEN :subtitles_files
      ELSE videos.subtitles_files
    END,
    subtitles_text = CASE
      WHEN :subtitles_text IS NOT NULL AND :subtitles_text != '' THEN :subtitles_text
      ELSE videos.subtitles_text
    END
  `);

  isVideoInDbStmt = db.prepare(`
    SELECT 1 FROM videos WHERE video_id = ? LIMIT 1
  `);

  resetVideos = db.prepare(`
    DELETE FROM videos;
  `);

  resetChannels = db.prepare(`
    DELETE FROM channels;
  `);

  getRecentVideosStmt = db.prepare(`
    SELECT v.*, c.channel_title, c.short_id as channel_short_id
    FROM videos v
    JOIN channels c ON v.channel_id = c.channel_id
    ORDER BY v.upload_timestamp DESC
    LIMIT ? OFFSET ?
  `);

  getVideoByIdStmt = db.prepare(`
    SELECT v.*, c.channel_title, c.short_id as channel_short_id, c.avatar_filename
    FROM videos v
    JOIN channels c ON v.channel_id = c.channel_id
    WHERE v.video_id = ?
  `);

  getChannelByIdStmt = db.prepare(`
    SELECT * FROM channels WHERE channel_id = ?
  `);

  getChannelByShortIdStmt = db.prepare(`
    SELECT * FROM channels WHERE short_id = ?
  `);

  getVideosByChannelStmt = db.prepare(`
    SELECT v.*, c.channel_title, c.short_id as channel_short_id
    FROM videos v
    JOIN channels c ON v.channel_id = c.channel_id
    WHERE v.channel_id = ?
    ORDER BY v.upload_timestamp DESC
    LIMIT ? OFFSET ?
  `);

  channelExistsStmt = db.prepare(`
    SELECT 1 FROM channels WHERE channel_id = ? LIMIT 1
  `);

  getAllChannelsStmt = db.prepare(`
    SELECT channel_id, channel_title FROM channels ORDER BY channel_title
  `);

  channelSortStmts = Object.fromEntries(
    Object.entries(channelSortOrders).map(([key, order]) => [
      key,
      db!.prepare(`SELECT * FROM channels ORDER BY ${order} LIMIT ? OFFSET ?`),
    ])
  ) as Record<ChannelSort, StatementSync>;

  searchVideosStmt = db.prepare(`
    SELECT v.*, c.channel_title, c.short_id as channel_short_id
    FROM videos_fts fts
    JOIN videos v ON v.rowid = fts.rowid
    JOIN channels c ON v.channel_id = c.channel_id
    WHERE videos_fts MATCH ?
    ORDER BY bm25(videos_fts)
    LIMIT ? OFFSET ?
  `);

  searchChannelsStmt = db.prepare(`
    SELECT ch.*
    FROM channels_fts fts
    JOIN channels ch ON ch.rowid = fts.rowid
    WHERE channels_fts MATCH ?
    ORDER BY bm25(channels_fts)
    LIMIT ? OFFSET ?
  `);
}

export interface Channel {
  channel_id: ChannelID;
  channel_title: string;
  short_id: string;
  description: string | null;
  avatar_filename: string | null;
  banner_filename: string | null;
  banner_uncropped_filename: string | null;
  latest_upload_timestamp: number | null;
  video_count: number;
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
  subtitles_files: Record<string, string>; // map langcode -> path to .vtt file on disk
  subtitles_text: string;
}

type VideoWithChannelRow = Omit<VideoWithChannel, 'subtitles_files'> & { subtitles_files: string };

export interface VideoWithChannel extends Video {
  channel_title: string;
  channel_short_id: string;
  avatar_filename?: string;
}

export function addChannel(channel: Channel): void {
  throwIfNotInit(addChannelStmt);
  addChannelStmt.run({
    ':channel_id': channel.channel_id,
    ':channel_title': channel.channel_title,
    ':short_id': channel.short_id,
    ':description': channel.description,
    ':avatar_filename': channel.avatar_filename,
    ':banner_filename': channel.banner_filename,
    ':banner_uncropped_filename': channel.banner_uncropped_filename,
  });
}

export function addVideo(video: Video): void {
  throwIfNotInit(addVideoStmt);
  addVideoStmt.run({
    ':video_id': video.video_id,
    ':channel_id': video.channel_id,
    ':title': video.title,
    ':description': video.description,
    ':video_filename': video.video_filename,
    ':thumb_filename': video.thumb_filename,
    ':duration_seconds': video.duration_seconds,
    ':upload_timestamp': video.upload_timestamp,
    ':subtitles_files': JSON.stringify(video.subtitles_files),
    ':subtitles_text': video.subtitles_text,
  });
}

export function isVideoInDb(videoId: VideoID): boolean {
  throwIfNotInit(isVideoInDbStmt);
  return !!isVideoInDbStmt.get(videoId)
}

export function isChannelInDb(channelId: ChannelID): boolean {
  throwIfNotInit(channelExistsStmt);
  return !!channelExistsStmt.get(channelId);
}

export function resetMediaInDb() {
  throwIfNotInit(resetVideos);
  throwIfNotInit(resetChannels);
  resetVideos.run();
  resetChannels.run();
}

function parseSubtitles<T extends { subtitles_files: string }>(row: T): T & { subtitles_files: Record<string, string> } {
  return {
    ...row,
    subtitles_files: JSON.parse(row.subtitles_files) as Record<string, string>,
  };
}

export function getRecentVideosForChannels(channelIds: Set<ChannelID> | 'all', limit: number = 30, offset: number = 0): VideoWithChannel[] {
  if (channelIds === 'all') {
    throwIfNotInit(getRecentVideosStmt);
    const rows = getRecentVideosStmt.all(limit, offset) as VideoWithChannelRow[];
    return rows.map(parseSubtitles);
  }
  if (channelIds.size === 0) return [];

  throwIfNotInit(db);
  const placeholders = [...channelIds].map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT v.*, c.channel_title, c.short_id as channel_short_id
    FROM videos v
    JOIN channels c ON v.channel_id = c.channel_id
    WHERE v.channel_id IN (${placeholders})
    ORDER BY v.upload_timestamp DESC
    LIMIT ? OFFSET ?
  `);

  const rows = stmt.all(...channelIds, limit, offset) as VideoWithChannelRow[];
  return rows.map(parseSubtitles);
}

export function getVideoById(videoId: VideoID): VideoWithChannel | null {
  throwIfNotInit(getVideoByIdStmt);
  const row = getVideoByIdStmt.get(videoId) as VideoWithChannelRow | undefined;
  if (!row) return null;
  return parseSubtitles(row);
}

export function getChannelById(channelId: ChannelID): Channel | null {
  throwIfNotInit(getChannelByIdStmt);
  return getChannelByIdStmt.get(channelId) as unknown as Channel | null;
}

export function getChannelByShortId(shortId: string): Channel | null {
  throwIfNotInit(getChannelByShortIdStmt);
  return getChannelByShortIdStmt.get(shortId) as unknown as Channel | null;
}

export function getVideosByChannel(channelId: ChannelID, limit: number = 30, offset: number = 0): VideoWithChannel[] {
  throwIfNotInit(getVideosByChannelStmt);
  const rows = getVideosByChannelStmt.all(channelId, limit, offset) as VideoWithChannelRow[];
  return rows.map(parseSubtitles);
}

export function getAllChannels(): { channel_id: ChannelID; channel_title: string }[] {
  throwIfNotInit(getAllChannelsStmt);
  return getAllChannelsStmt.all() as { channel_id: ChannelID; channel_title: string }[];
}

export function getChannelsSorted(allowedChannels: Set<ChannelID> | 'all', sort: ChannelSort = 'recent', limit: number = 30, offset: number = 0): Channel[] {
  if (allowedChannels === 'all') {
    throwIfNotInit(channelSortStmts);
    return channelSortStmts[sort].all(limit, offset) as unknown as Channel[];
  }
  if (allowedChannels.size === 0) return [];

  throwIfNotInit(db);
  const placeholders = [...allowedChannels].map(() => '?').join(',');
  const order = channelSortOrders[sort];
  const stmt = db.prepare(`
    SELECT * FROM channels
    WHERE channel_id IN (${placeholders})
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `);
  return stmt.all(...allowedChannels, limit, offset) as unknown as Channel[];
}

export function getChannelsForUser(allowedChannels: Set<ChannelID> | 'all'): { channel_id: ChannelID; channel_title: string }[] {
  if (allowedChannels === 'all') {
    throwIfNotInit(getAllChannelsStmt);
    return getAllChannelsStmt.all() as { channel_id: ChannelID; channel_title: string }[];
  }

  if (allowedChannels.size === 0) return [];

  throwIfNotInit(db);
  const placeholders = [...allowedChannels].map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT channel_id, channel_title FROM channels
    WHERE channel_id IN (${placeholders})
    ORDER BY channel_title
  `);

  return stmt.all(...allowedChannels) as { channel_id: ChannelID; channel_title: string }[];
}

let searchVideosFilteredStmt = (placeholders: string) => {
  throwIfNotInit(db);
  return db.prepare(`
    SELECT v.*, c.channel_title, c.short_id as channel_short_id
    FROM videos_fts fts
    JOIN videos v ON v.rowid = fts.rowid
    JOIN channels c ON v.channel_id = c.channel_id
    WHERE videos_fts MATCH ?
      AND v.channel_id IN (${placeholders})
    ORDER BY bm25(videos_fts)
    LIMIT ? OFFSET ?
  `);
};

let searchChannelsFilteredStmt = (placeholders: string) => {
  throwIfNotInit(db);
  return db.prepare(`
    SELECT ch.*
    FROM channels_fts fts
    JOIN channels ch ON ch.rowid = fts.rowid
    WHERE channels_fts MATCH ?
      AND ch.channel_id IN (${placeholders})
    ORDER BY bm25(channels_fts)
    LIMIT ? OFFSET ?
  `);
};

export type SearchTier = 'channels' | 'title' | 'description' | 'subtitles';

const videoTierColumns: Record<Exclude<SearchTier, 'channels'>, string> = {
  title: 'title',
  description: 'description',
  subtitles: 'subtitles_text',
};

function buildFtsStr(query: string, prefix: boolean): string {
  let tokens = query.split(/\s+/).filter(Boolean);
  return tokens.map((t, i) => {
    let escaped = '"' + t.replace(/"/g, '""') + '"';
    if (prefix && i === tokens.length - 1) escaped += ' *';
    return escaped;
  }).join(' ');
}

function searchChannelResults(ftsStr: string, allowedChannels: Set<ChannelID> | 'all', limit: number, offset: number): Channel[] {
  let matchStr = `channel_title : ${ftsStr}`;
  if (allowedChannels === 'all') {
    throwIfNotInit(searchChannelsStmt);
    return searchChannelsStmt.all(matchStr, limit, offset) as unknown as Channel[];
  }
  let placeholders = [...allowedChannels].map(() => '?').join(',');
  return searchChannelsFilteredStmt(placeholders).all(matchStr, ...allowedChannels, limit, offset) as unknown as Channel[];
}

function searchVideoResults(column: string, ftsStr: string, allowedChannels: Set<ChannelID> | 'all', limit: number, offset: number): VideoWithChannel[] {
  let matchStr = `${column} : ${ftsStr}`;
  let rows: VideoWithChannelRow[];
  if (allowedChannels === 'all') {
    throwIfNotInit(searchVideosStmt);
    rows = searchVideosStmt.all(matchStr, limit, offset) as VideoWithChannelRow[];
  } else {
    let placeholders = [...allowedChannels].map(() => '?').join(',');
    rows = searchVideosFilteredStmt(placeholders).all(matchStr, ...allowedChannels, limit, offset) as VideoWithChannelRow[];
  }
  return rows.map(parseSubtitles);
}

export function searchByTier(query: string, tier: SearchTier, allowedChannels: Set<ChannelID> | 'all', limit: number = 30, offset: number = 0, prefix: boolean = false): Channel[] | VideoWithChannel[] {
  let ftsStr = buildFtsStr(query.trim(), prefix);
  if (!ftsStr) return [];
  if (allowedChannels !== 'all' && allowedChannels.size === 0) return [];
  if (tier === 'channels') {
    return searchChannelResults(ftsStr, allowedChannels, limit, offset);
  }
  return searchVideoResults(videoTierColumns[tier], ftsStr, allowedChannels, limit, offset);
}

export interface SearchResults {
  channels: Channel[];
  videosByTitle: VideoWithChannel[];
  videosByDescription: VideoWithChannel[];
  videosBySubtitles: VideoWithChannel[];
  offsets: Record<SearchTier, number>;
  exhausted: Record<SearchTier, boolean>;
}

export function search(query: string, allowedChannels: Set<ChannelID> | 'all', limit: number = 30, prefix: boolean = false, skipChannels: boolean = false): SearchResults {
  let ftsQuery = query.trim();
  let empty: SearchResults = {
    channels: [], videosByTitle: [], videosByDescription: [], videosBySubtitles: [],
    offsets: { channels: 0, title: 0, description: 0, subtitles: 0 },
    exhausted: { channels: false, title: false, description: false, subtitles: false },
  };
  if (!ftsQuery) return empty;
  if (allowedChannels !== 'all' && allowedChannels.size === 0) return empty;

  let ftsStr = buildFtsStr(ftsQuery, prefix);
  let remaining = limit;

  let channels: Channel[] = [];
  let channelsExhausted = skipChannels;
  if (!skipChannels) {
    channels = searchChannelResults(ftsStr, allowedChannels, remaining, 0);
    channelsExhausted = channels.length < remaining;
    remaining -= channels.length;
  }

  let titleRequested = remaining;
  let videosByTitle = titleRequested > 0 ? searchVideoResults('title', ftsStr, allowedChannels, titleRequested, 0) : [];
  let titleExhausted = titleRequested > 0 && videosByTitle.length < titleRequested;
  remaining -= videosByTitle.length;

  let seenIds = new Set(videosByTitle.map(v => v.video_id));

  let descFetched = remaining > 0;
  let descRaw = descFetched ? searchVideoResults('description', ftsStr, allowedChannels, limit, 0) : [];
  let videosByDescription: VideoWithChannel[] = [];
  let descOffset = 0;
  let descExhausted = false;
  if (descFetched) {
    for (let i = 0; i < descRaw.length; i++) {
      if (!seenIds.has(descRaw[i].video_id)) {
        videosByDescription.push(descRaw[i]);
        seenIds.add(descRaw[i].video_id);
      }
      if (videosByDescription.length === remaining) {
        descOffset = i + 1;
        break;
      }
    }
    if (videosByDescription.length < remaining) {
      descOffset = descRaw.length;
      descExhausted = descRaw.length < limit;
    }
    remaining -= videosByDescription.length;
  }

  let subsFetched = remaining > 0;
  let subsRaw = subsFetched ? searchVideoResults('subtitles_text', ftsStr, allowedChannels, limit, 0) : [];
  let videosBySubtitles: VideoWithChannel[] = [];
  let subsOffset = 0;
  let subsExhausted = false;
  if (subsFetched) {
    for (let i = 0; i < subsRaw.length; i++) {
      if (!seenIds.has(subsRaw[i].video_id)) {
        videosBySubtitles.push(subsRaw[i]);
        seenIds.add(subsRaw[i].video_id);
      }
      if (videosBySubtitles.length === remaining) {
        subsOffset = i + 1;
        break;
      }
    }
    if (videosBySubtitles.length < remaining) {
      subsOffset = subsRaw.length;
      subsExhausted = subsRaw.length < limit;
    }
  }

  return {
    channels, videosByTitle, videosByDescription, videosBySubtitles,
    offsets: {
      channels: channels.length,
      title: videosByTitle.length,
      description: descOffset,
      subtitles: subsOffset,
    },
    exhausted: {
      channels: channelsExhausted,
      title: titleExhausted,
      description: descExhausted,
      subtitles: subsExhausted,
    },
  };
}

export function closeDb(): void {
  if (db) {
    console.log('Closing database connection.');
    db.close();
    db = null;
  }
}
