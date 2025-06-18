import { DatabaseSync } from 'node:sqlite';
import { scrypt, randomBytes, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'path';
import fs from 'fs';
import { isChannelInDb } from './media-db.ts';
import type { ChannelID } from './util.ts';
import { LRUCache } from './util.ts';

const scryptAsync = promisify(scrypt);

// TODO configurable
const USER_DB_PATH = path.join(import.meta.dirname, './user_data.sqlite');
const KEYS_PATH = path.join(import.meta.dirname, './keys.json');

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

type Permissions = {
  allowedChannels: Set<ChannelID> | 'all';
  createUser: boolean;
};


let db: DatabaseSync | undefined = new DatabaseSync(USER_DB_PATH);


const userPermissionsCache = new LRUCache<string, Permissions>(100);

let existing = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all().map(({ name }) => name);
if (existing.length === 0) {
  db.exec(`
    CREATE TABLE users (
        username TEXT PRIMARY KEY,
        hashed_password BLOB NOT NULL,
        salt BLOB NOT NULL,
        permissions TEXT NOT NULL -- stored as JSON for future compat; we cache on user load anyway
    ) STRICT;
  `);
} else if (!(new Set(existing)).isSubsetOf(new Set(['users']))) {
  throw new Error(`${USER_DB_PATH} exists but does not contain the data we expect`);
}

if (!fs.existsSync(KEYS_PATH)) {
  const pepper = randomBytes(32);
  const hmacKey = randomBytes(32);

  const keysData = {
    pepper: pepper.toString('base64'),
    hmacKey: hmacKey.toString('base64')
  };

  fs.writeFileSync(KEYS_PATH, JSON.stringify(keysData, null, 2));
  console.log('Generated new keys.json file');
}

const keysData = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
let keys: Keys = {
  pepper: Buffer.from(keysData.pepper, 'base64'),
  hmacKey: Buffer.from(keysData.hmacKey, 'base64')
};


let getUserByUsernameStmt = db.prepare(`
  SELECT * FROM users WHERE username = ?
`);

let addUserStmt = db.prepare(`
  INSERT INTO users (username, hashed_password, salt, permissions)
  VALUES (:username, :hashed_password, :salt, :permissions)
`);

let hasAnyUsersStmt = db.prepare(`
  SELECT 1 FROM users LIMIT 1
`);

async function hashPassword(password: string, salt: Buffer, pepper: Buffer): Promise<Buffer> {
  const normalizedPassword = password.normalize('NFC');
  const passwordWithPepper = normalizedPassword + pepper.toString('base64');
  const hash = await scryptAsync(passwordWithPepper, salt, 64) as Buffer;
  return hash;
}

async function verifyPassword(password: string, storedHash: Buffer, salt: Buffer, pepper: Buffer): Promise<boolean> {
  const computedHash = await hashPassword(password, salt, pepper);
  return computedHash.equals(storedHash);
}

function generateBearerToken(username: string): string {
  const payload = {
    username,
    timestamp: Date.now()
  };

  const payloadStr = JSON.stringify(payload);
  const signature = createHmac('sha256', keys.hmacKey)
    .update(payloadStr)
    .digest('base64');

  const token = {
    payloadStr,
    signature
  };

  return Buffer.from(JSON.stringify(token)).toString('base64');
}

export function decodeBearerToken(tokenStr: string): { username: string; timestamp: number } {
  let tokenData;
  try {
    const tokenJson = Buffer.from(tokenStr, 'base64').toString('utf8');
    tokenData = JSON.parse(tokenJson);
  } catch (error) {
    throw new Error('Invalid token format');
  }

  if (!tokenData.payloadStr || !tokenData.signature) {
    throw new Error('Missing token payload or signature');
  }

  const expectedSignature = createHmac('sha256', keys.hmacKey)
    .update(tokenData.payloadStr)
    .digest('base64');

  if (tokenData.signature !== expectedSignature) {
    throw new Error('Invalid token signature');
  }

  let payload;
  try {
    payload = JSON.parse(tokenData.payloadStr);
  } catch (error) {
    throw new Error('Invalid payload JSON');
  }

  if (typeof payload.username !== 'string' || typeof payload.timestamp !== 'number') {
    throw new Error('Invalid token payload structure');
  }

  return payload;
}

function parsePermissions(permissionsString: string): Permissions {
  let { allowedChannels, createUser } = JSON.parse(permissionsString);
  if (allowedChannels !== 'all' && !Array.isArray(allowedChannels) || typeof createUser != 'boolean') {
    throw new Error('malformed permissions');
  }
  return {
    allowedChannels: allowedChannels === 'all' ? 'all' : new Set(allowedChannels.filter((c: unknown) => typeof c === 'string' && isChannelInDb(c as ChannelID))),
    createUser,
  };
}

function serializePermissions(permissions: Permissions): string {
  return JSON.stringify({
    allowedChannels: permissions.allowedChannels === 'all' ? 'all' : [...permissions.allowedChannels],
    createUser: permissions.createUser,
  });
}

export async function addUser(
  username: string,
  password: string,
  permissions: Permissions,
): Promise<void> {
  const existingUser = getUserByUsernameStmt.get(username);
  if (existingUser) {
    throw new Error('User already exists');
  }

  if (permissions.allowedChannels !== 'all') {
    for (const channelId of permissions.allowedChannels) {
      if (!isChannelInDb(channelId as ChannelID)) {
        throw new Error(`Channel '${channelId}' does not exist`);
      }
    }
  }

  const salt = randomBytes(32);
  const hashedPassword = await hashPassword(password, salt, keys.pepper);

  addUserStmt.run({
    ':username': username,
    ':hashed_password': hashedPassword,
    ':salt': salt,
    'permissions': serializePermissions(permissions),
  });
}

export function getUserPermissions(username: string): Permissions {
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

export function canUserViewChannel(username: string, channelId: ChannelID): boolean {
  const permissions = getUserPermissions(username);
  return permissions.allowedChannels === 'all' || permissions.allowedChannels.has(channelId);
}

export function hasAnyUsers(): boolean {
  return !!hasAnyUsersStmt.get();
}

export async function checkUsernamePassword(username: string, password: string): Promise<string | null> {
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
    db = undefined;
  }
}
