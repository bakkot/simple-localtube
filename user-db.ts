import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { scrypt, randomBytes, createHmac, timingSafeEqual, type ScryptOptions, type BinaryLike } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'path';
import fs from 'fs';
import { getChannelVideoCountsForVideos, getVideoById, isChannelInDb, isVideoInDb, type Channel, type SearchScope } from './media-db.ts';
import type { ChannelID, VideoID } from './util.ts';
import { LRUCache, throwIfNotInit } from './util.ts';

type Scrypt = (password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions) => Promise<Buffer>;
const scryptAsync = promisify(scrypt) as Scrypt;

type Keys = {
  pepper: Buffer;
  hmacKey: Buffer;
}

type User = {
  username: string;
  hashed_password: Buffer;
  salt: Buffer;
  permissions: Permissions;
}

export type StoredPermissions = ({
  allowedChannels: 'all';
  allowedVideos: null;
} | {
  allowedChannels: Set<ChannelID>;
  allowedVideos: Set<VideoID>;
}) & {
  createUser: 'yes' | 'no' | 'limited';
  canSubscribe: boolean;
};

export type Permissions = StoredPermissions & {
  // derived; not serialized
  partialChannels: Set<ChannelID>;
  partialChannelCounts: Map<ChannelID, number>;
};

let db: DatabaseSync | null = null;
let keys: Keys | null = null;

const userPermissionsCache = new LRUCache<string, Permissions>(100);

let getUserByUsernameStmt: StatementSync | null = null;
let addUserStmt: StatementSync | null = null;
let getCreatedAccountsStmt: StatementSync | null = null;
let hasAnyUsersStmt: StatementSync | null = null;
let updatePasswordStmt: StatementSync | null = null;
let updatePermissionsStmt: StatementSync | null = null;

export function init(dbDir: string): void {
  const USER_DB_PATH = path.join(dbDir, 'users.sqlite');
  const KEYS_PATH = path.join(dbDir, 'keys.json');

  db = new DatabaseSync(USER_DB_PATH, {
    timeout: 1000,
  });

  let existing = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all().map(({ name }) => name);
  if (existing.length === 0) {
    db.exec(`
      CREATE TABLE users (
          username TEXT PRIMARY KEY,
          hashed_password BLOB NOT NULL,
          salt BLOB NOT NULL,
          permissions TEXT NOT NULL, -- stored as JSON for future compat; we cache on user load anyway
          created_by TEXT REFERENCES users(username)
      ) STRICT;
    `);
  } else if (!(new Set(existing)).isSubsetOf(new Set(['users']))) {
    throw new Error(`${USER_DB_PATH} exists but does not contain the data we expect`);
  }

  type KeysAsStrings = {
    pepper: string;
    hmacKey: string;
  }
  if (!fs.existsSync(KEYS_PATH)) {
    const pepper = randomBytes(32);
    const hmacKey = randomBytes(32);

    const keysData: KeysAsStrings = {
      pepper: pepper.toString('base64'),
      hmacKey: hmacKey.toString('base64')
    };

    fs.writeFileSync(KEYS_PATH, JSON.stringify(keysData, null, 2));
    console.log('Generated new keys.json file');
  }

  const keysData = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')) as KeysAsStrings;
  keys = {
    pepper: Buffer.from(keysData.pepper, 'base64'),
    hmacKey: Buffer.from(keysData.hmacKey, 'base64'),
  };

  getUserByUsernameStmt = db.prepare(`
    SELECT * FROM users WHERE username = ?
  `);

  addUserStmt = db.prepare(`
    INSERT INTO users (username, hashed_password, salt, permissions, created_by)
    VALUES (:username, :hashed_password, :salt, :permissions, :created_by)
  `);

  getCreatedAccountsStmt = db.prepare(`
    SELECT username FROM users WHERE created_by = ?
  `);

  hasAnyUsersStmt = db.prepare(`
    SELECT 1 FROM users LIMIT 1
  `);

  updatePasswordStmt = db.prepare(`
    UPDATE users SET hashed_password = :hashed_password, salt = :salt WHERE username = :username
  `);

  updatePermissionsStmt = db.prepare(`
    UPDATE users SET permissions = :permissions WHERE username = :username
  `);
}

export function generateSalt(): Buffer {
  return randomBytes(32);
}

async function hashPassword(password: string, salt: Buffer, pepper: Buffer): Promise<Buffer> {
  const normalizedPassword = password.normalize('NFC');

  const pepperedPassword = createHmac('sha256', pepper)
    .update(normalizedPassword)
    .digest();

  const hash = await scryptAsync(pepperedPassword, salt, 64, {
    cost: 32768,
    blockSize: 8,
    parallelization: 1,
    maxmem: 128 * 32768 * 8 * 2, // must exceed 128 N r
  });

  return hash;
}

async function verifyPassword(password: string, storedHash: Buffer, salt: Buffer, pepper: Buffer): Promise<boolean> {
  const computedHash = await hashPassword(password, salt, pepper);
  return timingSafeEqual(computedHash, storedHash);
}

type BearTokenPayload = {
  username: string;
  timestamp: number;
}
type BearerToken = {
  payloadStr: string;
  signature: string;
};
function generateBearerToken(username: string): string {
  throwIfNotInit(keys);

  const payload: BearTokenPayload = {
    username,
    timestamp: Date.now()
  };

  const payloadStr = JSON.stringify(payload);
  const signature = createHmac('sha256', keys.hmacKey)
    .update(payloadStr)
    .digest('base64');

  const token: BearerToken = {
    payloadStr,
    signature,
  };

  return Buffer.from(JSON.stringify(token)).toString('base64');
}

export function decodeBearerToken(tokenStr: string): { username: string; timestamp: number } {
  throwIfNotInit(keys);

  let tokenData: BearerToken;
  try {
    const tokenJson = Buffer.from(tokenStr, 'base64').toString('utf8');
    tokenData = JSON.parse(tokenJson) as BearerToken;
  } catch (error) {
    throw new Error('Invalid token format');
  }

  if (!tokenData.payloadStr || !tokenData.signature) {
    throw new Error('Missing token payload or signature');
  }

  const expectedSignature = createHmac('sha256', keys.hmacKey)
    .update(tokenData.payloadStr)
    .digest()
  const actualSignature = Uint8Array.fromBase64(tokenData.signature);

  if (!timingSafeEqual(expectedSignature, actualSignature)) {
    throw new Error('Invalid token signature');
  }

  let payload: BearTokenPayload;
  try {
    payload = JSON.parse(tokenData.payloadStr) as BearTokenPayload;
  } catch (error) {
    throw new Error('Invalid payload JSON');
  }

  if (!payload || typeof payload !== 'object' || typeof payload.username !== 'string' || typeof payload.timestamp !== 'number') {
    throw new Error('Invalid token payload structure');
  }

  return payload as { username: string; timestamp: number };
}

type SerializedPermissions = {
  allowedChannels: 'all' | ChannelID[];
  allowedVideos: null | VideoID[];
  createUser: 'yes' | 'no' | 'limited';
  canSubscribe: boolean;
}
function parsePermissions(permissionsString: string): Permissions {
  let { allowedChannels, allowedVideos, createUser, canSubscribe } = JSON.parse(permissionsString) as SerializedPermissions;
  if (allowedChannels !== 'all' && !Array.isArray(allowedChannels) || (createUser !== 'yes' && createUser !== 'no' && createUser !== 'limited')) {
    throw new Error('malformed permissions');
  }
  let parsedCanSubscribe = typeof canSubscribe === 'boolean' ? canSubscribe : false;
  if (allowedChannels === 'all') {
    return {
      allowedChannels: 'all',
      allowedVideos: null,
      createUser,
      canSubscribe: parsedCanSubscribe,
      partialChannels: new Set(),
      partialChannelCounts: new Map(),
    };
  }
  let parsedChannels = new Set(allowedChannels.filter((c: unknown) => typeof c === 'string' && isChannelInDb(c as ChannelID)));
  let parsedVideos: Set<VideoID> = Array.isArray(allowedVideos)
    ? new Set(allowedVideos.filter((v: unknown) => typeof v === 'string'))
    : new Set();
  let partialChannelCounts = parsedVideos.size === 0
    ? new Map<ChannelID, number>()
    : getChannelVideoCountsForVideos(parsedVideos);
  let partialChannels = new Set(partialChannelCounts.keys());
  return {
    allowedChannels: parsedChannels,
    allowedVideos: parsedVideos,
    createUser,
    canSubscribe: parsedCanSubscribe,
    partialChannels,
    partialChannelCounts,
  };
}

function serializePermissions(permissions: StoredPermissions): string {
  return JSON.stringify({
    allowedChannels: permissions.allowedChannels === 'all' ? 'all' : [...permissions.allowedChannels],
    allowedVideos: permissions.allowedVideos === null ? null : [...permissions.allowedVideos],
    createUser: permissions.createUser,
    canSubscribe: permissions.canSubscribe,
  } satisfies SerializedPermissions);
}

export async function addUser(
  username: string,
  password: string,
  permissions: StoredPermissions,
  createdBy: string | null,
): Promise<void> {
  throwIfNotInit(getUserByUsernameStmt);
  throwIfNotInit(addUserStmt);
  throwIfNotInit(keys);

  const existingUser = getUserByUsernameStmt.get(username);
  if (existingUser) {
    throw new Error('User already exists');
  }

  if (permissions.allowedChannels !== 'all') {
    for (const channelId of permissions.allowedChannels) {
      if (!isChannelInDb(channelId)) {
        throw new Error(`Channel '${channelId}' does not exist`);
      }
    }
    for (const videoId of permissions.allowedVideos) {
      if (!isVideoInDb(videoId)) {
        throw new Error(`Video '${videoId}' does not exist`);
      }
    }
  }

  const salt = generateSalt();
  const hashedPassword = await hashPassword(password, salt, keys.pepper);

  addUserStmt.run({
    ':username': username,
    ':hashed_password': hashedPassword,
    ':salt': salt,
    ':permissions': serializePermissions(permissions),
    ':created_by': createdBy,
  });
}

export function getUserPermissions(username: string): Permissions {
  throwIfNotInit(getUserByUsernameStmt);

  const cached = userPermissionsCache.get(username);
  if (cached) {
    return cached;
  }

  const user = getUserByUsernameStmt.get(username) as { permissions: string } | undefined;
  if (!user) {
    throw new Error(`unrecognized user ${username}`);
  }

  let permissions = parsePermissions(user.permissions);
  userPermissionsCache.set(username, permissions);
  return permissions;
}

export function getCreatedBy(username: string): string | null {
  throwIfNotInit(getUserByUsernameStmt);
  const user = getUserByUsernameStmt.get(username) as { created_by: string | null } | undefined;
  if (!user) {
    throw new Error(`unrecognized user ${username}`);
  }
  return user.created_by;
}

export function getCreatedAccounts(username: string): string[] {
  throwIfNotInit(getCreatedAccountsStmt);
  return (getCreatedAccountsStmt.all(username) as { username: string }[]).map(r => r.username);
}

export function getCreatedAccountsWithPermissions(username: string): { username: string; permissions: Permissions }[] {
  return getCreatedAccounts(username).map(u => ({
    username: u,
    permissions: getUserPermissions(u),
  }));
}

export function updateUserPermissions(username: string, permissions: StoredPermissions): void {
  throwIfNotInit(updatePermissionsStmt);
  userPermissionsCache.delete(username);
  updatePermissionsStmt.run({
    ':permissions': serializePermissions(permissions),
    ':username': username,
  });
}

export function canViewChannel(permissions: Permissions, channelId: ChannelID): boolean {
  return permissions.allowedChannels === 'all' || permissions.allowedChannels.has(channelId);
}

export function canViewVideo(permissions: Permissions, video: { video_id: VideoID; channel_id: ChannelID }): boolean {
  return canViewChannel(permissions, video.channel_id) || (permissions.allowedVideos?.has(video.video_id) ?? false);
}

export type ChannelAccess = 'full' | 'partial' | 'none';
export function channelAccess(permissions: Permissions, channelId: ChannelID): ChannelAccess {
  if (canViewChannel(permissions, channelId)) return 'full';
  if (permissions.partialChannels.has(channelId)) return 'partial';
  return 'none';
}

export function userVisibleVideoCount(channel: { channel_id: ChannelID; video_count: number }, permissions: Permissions): number {
  if (canViewChannel(permissions, channel.channel_id)) return channel.video_count;
  return permissions.partialChannelCounts.get(channel.channel_id) ?? 0;
}

export function applyUserChannelCount(channel: Channel, permissions: Permissions): Channel {
  if (canViewChannel(permissions, channel.channel_id)) return channel;
  return { ...channel, video_count: permissions.partialChannelCounts.get(channel.channel_id) ?? 0 };
}

export function buildSearchScope(permissions: Permissions, scopedChannelId: ChannelID | null): SearchScope {
  if (permissions.allowedChannels === 'all') {
    return { video: { kind: 'all' }, channel: { kind: 'all' } };
  }
  if (scopedChannelId == null) {
    return {
      video: { kind: 'union', channels: permissions.allowedChannels, videos: permissions.allowedVideos },
      channel: { kind: 'allowed', channels: new Set([...permissions.allowedChannels, ...permissions.partialChannels]) },
    };
  }
  if (permissions.allowedChannels.has(scopedChannelId)) {
    return {
      video: { kind: 'union', channels: new Set([scopedChannelId]), videos: new Set() },
      channel: { kind: 'allowed', channels: new Set([scopedChannelId]) },
    };
  }
  return {
    video: { kind: 'channel-partial', channel: scopedChannelId, videos: permissions.allowedVideos },
    channel: { kind: 'allowed', channels: new Set([scopedChannelId]) },
  };
}

export function areRequestedPermissionsAllowedByGranterPermissions(
  requestedPermissions: StoredPermissions,
  granterPermissions: StoredPermissions
): boolean {
  if (requestedPermissions.createUser !== 'no') {
    // NB limited cannot create limited
    if (granterPermissions.createUser !== 'yes') {
      return false;
    }
  }

  if (requestedPermissions.canSubscribe && !granterPermissions.canSubscribe) {
    return false;
  }

  if (requestedPermissions.canSubscribe && requestedPermissions.allowedChannels !== 'all') {
    return false;
  }

  if (granterPermissions.allowedChannels === 'all') {
    return true;
  }

  if (requestedPermissions.allowedChannels === 'all') {
    return false;
  }

  for (const channelId of requestedPermissions.allowedChannels) {
    if (!granterPermissions.allowedChannels.has(channelId)) {
      return false;
    }
  }

  for (const videoId of requestedPermissions.allowedVideos) {
    if (granterPermissions.allowedVideos.has(videoId)) continue;
    let v = getVideoById(videoId);
    if (v == null || !granterPermissions.allowedChannels.has(v.channel_id)) return false;
  }

  return true;
}

export function canCreateUsers(permissions: Permissions): boolean {
  return permissions.createUser !== 'no';
}

export function hasAnyUsers(): boolean {
  throwIfNotInit(hasAnyUsersStmt);
  return !!hasAnyUsersStmt.get();
}

export async function changePassword(username: string, currentPassword: string, newPassword: string): Promise<void> {
  throwIfNotInit(getUserByUsernameStmt);
  throwIfNotInit(updatePasswordStmt);
  throwIfNotInit(keys);

  const user = getUserByUsernameStmt.get(username) as User | undefined;
  if (!user) {
    throw new Error('User not found');
  }

  const isValid = await verifyPassword(currentPassword, user.hashed_password, user.salt, keys.pepper);
  if (!isValid) {
    throw new Error('Current password is incorrect');
  }

  const salt = generateSalt();
  const hashedPassword = await hashPassword(newPassword, salt, keys.pepper);

  updatePasswordStmt.run({
    ':hashed_password': hashedPassword,
    ':salt': salt,
    ':username': username,
  });
}

export async function checkUsernamePassword(username: string, password: string): Promise<string | null> {
  throwIfNotInit(getUserByUsernameStmt);
  throwIfNotInit(keys);

  const user = getUserByUsernameStmt.get(username) as User | undefined;
  if (!user) {
    return null;
  }

  const isValid = await verifyPassword(password, user.hashed_password, user.salt, keys.pepper);

  if (isValid) {
    return generateBearerToken(username);
  }

  return null;
}

export function closeUserDb(): void {
  if (db) {
    console.log('Closing user database connection.');
    db.close();
    db = null;
  }
}
