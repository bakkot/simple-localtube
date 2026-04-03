import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import type { ChannelID } from './util.ts';
import { assertChannelId } from './util.ts';

const SUBSCRIPTIONS_DB_PATH = path.join(import.meta.dirname, './subscriptions.sqlite');

const db = new DatabaseSync(SUBSCRIPTIONS_DB_PATH, {
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

export type SubscriptionData = {
  subscribing: ChannelID[];
  subscribed: ChannelID[];
  titles: Record<ChannelID, string>;
};

const getAllStmt = db.prepare('SELECT channel_id, status, title FROM channels');
const getByStatusStmt = db.prepare('SELECT channel_id, title FROM channels WHERE status = ?');
const getByIdStmt = db.prepare('SELECT channel_id, status, title FROM channels WHERE channel_id = ?');
const insertStmt = db.prepare('INSERT INTO channels (channel_id, status, title) VALUES (?, ?, ?)');
const deleteStmt = db.prepare('DELETE FROM channels WHERE channel_id = ?');
const updateStatusStmt = db.prepare('UPDATE channels SET status = ? WHERE channel_id = ?');
const clearTitleStmt = db.prepare('UPDATE channels SET title = NULL WHERE channel_id = ?');

export function getSubscriptionData(): SubscriptionData {
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
  const existing = getByIdStmt.get(channelId) as { channel_id: string } | undefined;
  if (existing) {
    throw new Error('Channel is already in subscriptions');
  }
  insertStmt.run(channelId, 'subscribing', title);
}

export function removeSubscription(channelId: ChannelID): void {
  const existing = getByIdStmt.get(channelId) as { channel_id: string } | undefined;
  if (!existing) {
    throw new Error(`Channel ${channelId} is not in subscriptions`);
  }
  deleteStmt.run(channelId);
}

export function markSubscribed(channelId: ChannelID): void {
  updateStatusStmt.run('subscribed', channelId);
  clearTitleStmt.run(channelId);
}

export function getSubscribing(): ChannelID[] {
  const rows = getByStatusStmt.all('subscribing') as { channel_id: string }[];
  return rows.map(r => assertChannelId(r.channel_id));
}

export function getSubscribed(): ChannelID[] {
  const rows = getByStatusStmt.all('subscribed') as { channel_id: string }[];
  return rows.map(r => assertChannelId(r.channel_id));
}

export function isSubscribed(channelId: ChannelID): boolean {
  const row = getByIdStmt.get(channelId) as { status: string } | undefined;
  return row?.status === 'subscribed';
}

export function isInSubscriptions(channelId: ChannelID): boolean {
  return getByIdStmt.get(channelId) != null;
}

export function closeSubscriptionsDb(): void {
  db.close();
}
