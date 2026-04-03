import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'path';
import type { ChannelID } from './util.ts';
import { assertChannelId, throwIfNotInit } from './util.ts';

let db: DatabaseSync | null = null;

let getAllStmt: StatementSync | null = null;
let getByStatusStmt: StatementSync | null = null;
let getByIdStmt: StatementSync | null = null;
let insertStmt: StatementSync | null = null;
let deleteStmt: StatementSync | null = null;
let updateStatusStmt: StatementSync | null = null;
let clearTitleStmt: StatementSync | null = null;

export function init(dbDir: string): void {
  const SUBSCRIPTIONS_DB_PATH = path.join(dbDir, 'subscriptions.sqlite');

  db = new DatabaseSync(SUBSCRIPTIONS_DB_PATH, {
    timeout: 1000,
  });

  let existing = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all().map(({ name }) => name);
  if (existing.length === 0) {
    db.exec(`
      CREATE TABLE channels (
          channel_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK(status IN ('subscribing', 'subscribed')),
          title TEXT
      ) STRICT;
    `);
  }

  getAllStmt = db.prepare('SELECT channel_id, status, title FROM channels');
  getByStatusStmt = db.prepare('SELECT channel_id, title FROM channels WHERE status = ?');
  getByIdStmt = db.prepare('SELECT channel_id, status, title FROM channels WHERE channel_id = ?');
  insertStmt = db.prepare('INSERT INTO channels (channel_id, status, title) VALUES (?, ?, ?)');
  deleteStmt = db.prepare('DELETE FROM channels WHERE channel_id = ?');
  updateStatusStmt = db.prepare('UPDATE channels SET status = ? WHERE channel_id = ?');
  clearTitleStmt = db.prepare('UPDATE channels SET title = NULL WHERE channel_id = ?');
}

export type SubscriptionData = {
  subscribing: ChannelID[];
  subscribed: ChannelID[];
  titles: Record<ChannelID, string>;
};

export function getSubscriptionData(): SubscriptionData {
  throwIfNotInit(getAllStmt);
  const rows = getAllStmt.all() as { channel_id: string; status: string; title: string | null }[];
  const subscribing: ChannelID[] = [];
  const subscribed: ChannelID[] = [];
  const titles: Record<ChannelID, string> = {
    // @ts-expect-error https://github.com/microsoft/TypeScript/issues/38385
    __proto__: null,
  };
  for (const row of rows) {
    const id = assertChannelId(row.channel_id);
    if (row.status === 'subscribing') {
      subscribing.push(id);
    } else {
      subscribed.push(id);
    }
    if (row.title != null) {
      titles[id] = row.title;
    }
  }
  return { subscribing, subscribed, titles };
}

export function addSubscription(channelId: ChannelID, title: string): void {
  throwIfNotInit(getByIdStmt);
  throwIfNotInit(insertStmt);
  const existing = getByIdStmt.get(channelId) as { channel_id: string } | undefined;
  if (existing) {
    throw new Error('Channel is already in subscriptions');
  }
  insertStmt.run(channelId, 'subscribing', title);
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

export function markSubscribed(channelId: ChannelID): void {
  throwIfNotInit(updateStatusStmt);
  throwIfNotInit(clearTitleStmt);
  updateStatusStmt.run('subscribed', channelId);
  clearTitleStmt.run(channelId);
}

export function getSubscribing(): ChannelID[] {
  throwIfNotInit(getByStatusStmt);
  const rows = getByStatusStmt.all('subscribing') as { channel_id: string }[];
  return rows.map(r => assertChannelId(r.channel_id));
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

export function closeSubscriptionsDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
