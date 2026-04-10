import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { createApp, addGetRoute, withMiddleware, getCookies, listen, type Middleware } from './httplib.ts';
import { init as initMediaDb, getRecentVideosForChannels, getVideoById, getChannelByShortId, getVideosByChannel, getAllChannels, getChannelsForUser, getChannelsSorted, addVideo, addChannel, search, type Video, type Channel, type ChannelSort, isVideoInDb, getChannelById } from './media-db.ts';
import { nameExt, channelIDFromCanonicalURL, lock, type VideoID, type ChannelID } from './util.ts';
import { init as initUserDb, checkUsernamePassword, decodeBearerToken, canViewChannel, getUserPermissions, addUser, hasAnyUsers, areRequestedPermissionsAllowedByGranterPermissions, getCreatedAccountsWithPermissions, canCreateUsers, type Permissions } from './user-db.ts';
import { renderSetupPage, renderLoginPage, renderHomePage, renderChannelsPage, renderVideoPage, renderChannelPage, renderAddUserPage, renderManageUsersPage, renderNotAllowed, renderSubscriptionsPage, renderAddVideoPage, renderSettingsPage, renderSearchPage } from './frontend.ts';
import { addAPIs } from './server-api.ts';

const { values } = parseArgs({
  options: {
    'enable-subscriptions': {
      type: 'boolean',
    },
    'db-dir': {
      type: 'string',
    },
    'port': {
      type: 'string',
    },
  },
});
const enableSubscriptions = values['enable-subscriptions'] ?? false;
const dbDir = values['db-dir'] ?? path.join(import.meta.dirname, 'dbs');
const port = values.port == null ? 3000 : parsePort(values.port);

initMediaDb(dbDir);
initUserDb(dbDir);

type SubscriptionsDB = typeof import('./subscriptions-db.ts');
let subscriptionsDb: SubscriptionsDB | null = null;
if (enableSubscriptions) {
  subscriptionsDb = await import('./subscriptions-db.ts');
  subscriptionsDb.init(dbDir);
}
export { subscriptionsDb };


function parsePort(value: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    console.error(`Invalid port: "${value}". Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  return num;
}

const authMiddleware: Middleware<{ username?: string; permissions?: Permissions }> = (req, res, next) => {
  if (req.path === '/favicon.svg') {
    return next();
  }

  let isSetup = req.path === '/setup' || req.path === '/api/setup';
  // Check if any users exist - if not, redirect to setup
  if (!hasAnyUsers() && !isSetup) {
    if (req.path.startsWith('/api') || req.method !== 'GET') {
      res.status(403).json({ message: 'Setup required' });
      return;
    }
    res.redirect('/setup');
    return;
  }

  // Login, setup, and public-api do not require auth
  if (req.path === '/login' || req.path.startsWith('/public-api/') || isSetup) {
    return next();
  }

  // Validate auth cookie
  const authCookie = getCookies(req).auth as unknown;
  let isAuthenticated = false;
  let username: string | undefined;

  if (typeof authCookie === 'string') {
    try {
      const payload = decodeBearerToken(authCookie);
      username = payload.username;

      // valid token but can't get permissions = user has been deleted
      // getUserPermissions throws on unrecognized users
      try {
        getUserPermissions(username);
      } catch (e) {
        console.log(e);
        console.error(`user does not exist: ${username}`);
        throw e;
      }
      isAuthenticated = true;
    } catch {
      isAuthenticated = false;
    }
  }

  if (!isAuthenticated) {
    if (req.path.startsWith('/api') || req.method !== 'GET') {
      res.status(403).json({ message: 'Authentication required' });
      return;
    }

    // GET requests get redirected
    const redirectUrl = req.path === '/'
      ? '/login'
      : `/login?next=${encodeURIComponent(req.originalUrl)}`;
    res.redirect(redirectUrl);
    return;
  }

  // Attach username and permissions to request for later use
  req.username = username;
  req.permissions = getUserPermissions(username!);
  next();
};

const app = withMiddleware(createApp(), authMiddleware);

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
  <!-- Rabbit ear antennas -->
  <line x1="32" y1="18" x2="20" y2="4" />
  <line x1="32" y1="18" x2="44" y2="4" />
  <!-- Antenna tips -->
  <circle cx="20" cy="4" r="2" fill="#000" stroke="none" />
  <circle cx="44" cy="4" r="2" fill="#000" stroke="none" />
  <!-- TV body (rounded rectangle) -->
  <rect x="8" y="18" width="48" height="38" rx="5" ry="5" />
  <!-- Screen -->
  <rect x="13" y="23" width="30" height="28" rx="3" ry="3" />
  <!-- Knobs on the right side -->
  <circle cx="50" cy="32" r="3" />
  <circle cx="50" cy="42" r="3" />
  <!-- Legs -->
  <line x1="16" y1="56" x2="13" y2="61" />
  <line x1="48" y1="56" x2="51" y2="61" />
</svg>`;
addGetRoute(app, '/favicon.svg', (req, res): void => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(favicon);
});

addGetRoute(app, '/setup', (req, res): void => {
  if (hasAnyUsers()) {
    res.redirect('/login');
    return;
  }

  res.send(renderSetupPage());
});

addGetRoute(app, '/login', (req, res): void => {
  const authCookie = getCookies(req).auth as unknown;
  if (typeof authCookie === 'string') {
    try {
      const payload = decodeBearerToken(authCookie);
      getUserPermissions(payload.username); // This will throw if user doesn't exist
      // User is authenticated, redirect to home
      res.redirect('/');
      return;
    } catch {
      // Invalid or expired token, continue to login page
    }
  }

  res.send(renderLoginPage());
});

addGetRoute(app, '/', (req, res) => {
  const videos = getRecentVideosForChannels(req.permissions!.allowedChannels, 30);

  res.send(renderHomePage(req.username!, req.permissions!, videos));
});

addGetRoute(app, '/search', (req, res) => {
  const q = (req.query.q as string || '').trim();
  const channelId = req.query.channel;
  let allowedChannels = req.permissions!.allowedChannels;
  let channel: Channel | null = null;
  if (channelId) {
    if (allowedChannels !== 'all' && !allowedChannels.has(channelId as ChannelID)) {
      res.send(renderNotAllowed(req.username!, req.permissions!));
      return;
    }
    channel = getChannelById(channelId as ChannelID);
    if (!channel) {
      res.status(404).send('Channel not found');
      return;
    }
    allowedChannels = new Set([channelId as ChannelID]);
  }
  const results = search(q, allowedChannels, 30, false, !!channelId);
  res.send(renderSearchPage(req.username!, req.permissions!, q, results, channel));
});

addGetRoute(app, '/channels', (req, res) => {
  const channels = getChannelsSorted(req.permissions!.allowedChannels, 'recent', 30);
  res.send(renderChannelsPage(req.username!, req.permissions!, channels));
});

// Video player page
addGetRoute(app, '/v/:video_id', (req, res): void => {
  const video = getVideoById(req.params.video_id as VideoID);
  if (!video) {
    res.status(404).send('Video not found');
    return;
  }

  if (!canViewChannel(req.permissions!, video.channel_id)) {
    res.send(renderNotAllowed(req.username!, req.permissions!));
    return;
  }

  res.send(renderVideoPage(video, req.username!, req.permissions!));
});

// Channel page
addGetRoute(app, '/c/:short_id', (req, res): void => {
  const channel = getChannelByShortId(req.params.short_id);
  if (!channel) {
    res.status(404).send('Channel not found');
    return;
  }

  if (!canViewChannel(req.permissions!, channel.channel_id)) {
    res.send(renderNotAllowed(req.username!, req.permissions!));
    return;
  }

  const videos = getVideosByChannel(channel.channel_id, 30);
  const isSubscribed = subscriptionsDb?.isInSubscriptions(channel.channel_id) ?? false;

  res.send(renderChannelPage(channel, videos, req.username!, req.permissions!, subscriptionsDb != null, isSubscribed));
});

addGetRoute(app, '/add-user', (req, res): void => {
  if (!canCreateUsers(req.permissions!)) {
    res.send(renderNotAllowed(req.username!, req.permissions!));
    return;
  }

  const availableChannels = getChannelsForUser(req.permissions!.allowedChannels);

  res.send(renderAddUserPage(req.username!, req.permissions!, availableChannels));
});

addGetRoute(app, '/manage-users', (req, res): void => {
  if (!canCreateUsers(req.permissions!)) {
    res.send(renderNotAllowed(req.username!, req.permissions!));
    return;
  }

  const availableChannels = getChannelsForUser(req.permissions!.allowedChannels);
  const createdUsers = getCreatedAccountsWithPermissions(req.username!);

  res.send(renderManageUsersPage(req.username!, req.permissions!, availableChannels, createdUsers));
});

addGetRoute(app, '/settings', (req, res): void => {
  res.send(renderSettingsPage(req.username!, req.permissions!));
});

addGetRoute(app, '/subscriptions', (req, res): void => {
  if (!subscriptionsDb) {
    res.status(500).send('Server was started without --enable-subscriptions');
    return;
  }

  const subscriptions = subscriptionsDb.getSubscriptionData();
  res.send(renderSubscriptionsPage(req.username!, req.permissions!, subscriptions));
});

addGetRoute(app, '/add-video', (req, res): void => {
  if (!subscriptionsDb) {
    res.status(500).send('Server was started without --enable-subscriptions');
    return;
  }

  const videoQueue = subscriptionsDb.getVideoQueue();
  res.send(renderAddVideoPage(req.username!, req.permissions!, videoQueue));
});

addGetRoute(app, '/media/videos/:video_id', async (req, res): Promise<void> => {
  const videoId = nameExt(req.params.video_id).name;
  const video = getVideoById(videoId as VideoID);
  if (!video) {
    res.status(404).send('Video not found');
    return;
  }
  if (!canViewChannel(req.permissions!, video.channel_id)) {
    res.status(403).send('Access denied');
    return;
  }
  await res.sendFile(video.video_filename);
});

addGetRoute(app, '/media/thumbs/:video_id', async (req, res): Promise<void> => {
  const videoId = nameExt(req.params.video_id).name;
  const video = getVideoById(videoId as VideoID);
  if (video?.thumb_filename == null) {
    res.status(404).send('not found');
    return;
  }
  if (!canViewChannel(req.permissions!, video.channel_id)) {
    res.status(403).send('Access denied');
    return;
  }
  await res.sendFile(video.thumb_filename);
});

addGetRoute(app, '/media/subtitles/:video_id/:lang', async (req, res): Promise<void> => {
  const video = getVideoById(req.params.video_id as VideoID);
  const subtitlePath = video?.subtitles_files[req.params.lang];
  if (!subtitlePath) {
    res.status(404).send('not found');
    return;
  }
  if (!canViewChannel(req.permissions!, video.channel_id)) {
    res.status(403).send('Access denied');
    return;
  }
  await res.type('text/vtt').sendFile(subtitlePath);
});

addGetRoute(app, '/media/avatars/:short_id', async (req, res): Promise<void> => {
  const channelShortId = nameExt(req.params.short_id).name;
  const channel = getChannelByShortId(channelShortId);
  if (channel?.avatar_filename == null) {
    res.status(404).send('not found');
    return;
  }
  if (!canViewChannel(req.permissions!, channel.channel_id)) {
    res.status(403).send('Access denied');
    return;
  }
  await res.sendFile(channel.avatar_filename);
});

addAPIs(app);


listen(app, port, (error) => {
  if (error) {
    throw error;
  }
  console.log(`LocalTube server running on http://localhost:${port}`);
});
