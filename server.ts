import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { createApp, addGetRoute, withMiddleware, getCookies, listen, send, sendJson, redirect, sendFile, type Middleware } from './httplib.ts';
import { init as initMediaDb, getRecentVideosForUser, getVideoById, getChannelByShortId, getVideosByChannel, getAllChannels, getChannelsForUser, getChannelsSorted, addVideo, addChannel, search, type Video, type Channel, type ChannelSort, isVideoInDb, getChannelById } from './media-db.ts';
import { nameExt, channelIDFromCanonicalURL, lock, type VideoID, type ChannelID } from './util.ts';
import { init as initUserDb, checkUsernamePassword, decodeBearerToken, canViewChannel, canViewVideo, channelAccess, applyUserChannelCount, buildSearchScope, getUserPermissions, addUser, hasAnyUsers, areRequestedPermissionsAllowedByGranterPermissions, getCreatedAccountsWithPermissions, canCreateUsers, videoVisibility, type Permissions, type VideoVisibility } from './user-db.ts';
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

const authMiddleware: Middleware<{ username?: string; permissions?: Permissions }> = (req, rawRes, next) => {
  if (req.path === '/favicon.svg') {
    return next({});
  }

  let isSetup = req.path === '/setup' || req.path === '/api/setup';
  // Check if any users exist - if not, redirect to setup
  if (!hasAnyUsers() && !isSetup) {
    if (req.path.startsWith('/api') || req.method !== 'GET') {
      rawRes.statusCode = 403;
      sendJson(rawRes, { message: 'Setup required' });
      return;
    }
    redirect(rawRes, '/setup');
    return;
  }

  // Login, setup, and public-api do not require auth
  if (req.path === '/login' || req.path.startsWith('/public-api/') || isSetup) {
    return next({});
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
      rawRes.statusCode = 403;
      sendJson(rawRes, { message: 'Authentication required' });
      return;
    }

    // GET requests get redirected
    const redirectUrl = req.path === '/'
      ? '/login'
      : `/login?next=${encodeURIComponent(req.originalUrl)}`;
    redirect(rawRes, redirectUrl);
    return;
  }

  return next({ username, permissions: getUserPermissions(username!) });
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
addGetRoute(app, '/favicon.svg', (req, ctx, rawRes): void => {
  rawRes.setHeader('Content-Type', 'image/svg+xml');
  rawRes.setHeader('Cache-Control', 'public, max-age=86400');
  send(rawRes, favicon);
});

addGetRoute(app, '/setup', (req, ctx, rawRes): void => {
  if (hasAnyUsers()) {
    redirect(rawRes, '/login');
    return;
  }

  send(rawRes, renderSetupPage());
});

addGetRoute(app, '/login', (req, ctx, rawRes): void => {
  const authCookie = getCookies(req).auth as unknown;
  if (typeof authCookie === 'string') {
    try {
      const payload = decodeBearerToken(authCookie);
      getUserPermissions(payload.username); // This will throw if user doesn't exist
      // User is authenticated, redirect to home
      redirect(rawRes, '/');
      return;
    } catch {
      // Invalid or expired token, continue to login page
    }
  }

  send(rawRes, renderLoginPage());
});

addGetRoute(app, '/', (req, ctx, rawRes) => {
  const videos = getRecentVideosForUser(ctx.permissions!.allowedChannels, ctx.permissions!.allowedVideos ?? new Set(), 30);

  send(rawRes, renderHomePage(ctx.username!, ctx.permissions!, videos));
});

addGetRoute(app, '/search', (req, ctx, rawRes) => {
  const q = (req.query.q as string || '').trim();
  const channelId = req.query.channel;
  let channel: Channel | null = null;
  let scopedChannelId: ChannelID | null = null;
  if (channelId) {
    if (channelAccess(ctx.permissions!, channelId as ChannelID) === 'none') {
      send(rawRes, renderNotAllowed(ctx.username!, ctx.permissions!));
      return;
    }
    channel = getChannelById(channelId as ChannelID);
    if (!channel) {
      rawRes.statusCode = 404;
      send(rawRes, 'Channel not found');
      return;
    }
    scopedChannelId = channelId as ChannelID;
  }
  const scope = buildSearchScope(ctx.permissions!, scopedChannelId);
  const results = search(q, scope, 30, false, !!channelId);
  results.channels = results.channels.map(c => applyUserChannelCount(c, ctx.permissions!));
  send(rawRes, renderSearchPage(ctx.username!, ctx.permissions!, q, results, channel));
});

addGetRoute(app, '/channels', (req, ctx, rawRes) => {
  const channels = getChannelsSorted(ctx.permissions!.allowedChannels, 'recent', 30);
  send(rawRes, renderChannelsPage(ctx.username!, ctx.permissions!, channels));
});

// Video player page
addGetRoute(app, '/v/:video_id', (req, ctx, rawRes): void => {
  const video = getVideoById(req.params.video_id as VideoID);
  if (!video) {
    rawRes.statusCode = 404;
    send(rawRes, 'Video not found');
    return;
  }

  if (!canViewVideo(ctx.permissions!, video)) {
    send(rawRes, renderNotAllowed(ctx.username!, ctx.permissions!));
    return;
  }

  const manageableUsers: { username: string; visibility: VideoVisibility }[] = [];
  if (canCreateUsers(ctx.permissions!)) {
    for (const u of getCreatedAccountsWithPermissions(ctx.username!)) {
      if (u.permissions.allowedChannels === 'all') continue;
      manageableUsers.push({ username: u.username, visibility: videoVisibility(u.permissions, video) });
    }
  }

  send(rawRes, renderVideoPage(video, ctx.username!, ctx.permissions!, manageableUsers));
});

// Channel page
addGetRoute(app, '/c/:short_id', (req, ctx, rawRes): void => {
  const channel = getChannelByShortId(req.params.short_id);
  if (!channel) {
    rawRes.statusCode = 404;
    send(rawRes, 'Channel not found');
    return;
  }

  const access = channelAccess(ctx.permissions!, channel.channel_id);
  if (access === 'none') {
    send(rawRes, renderNotAllowed(ctx.username!, ctx.permissions!));
    return;
  }

  const videos = access === 'full'
    ? getVideosByChannel(channel.channel_id, 30)
    : getVideosByChannel(channel.channel_id, 30, 0, ctx.permissions!.allowedVideos);
  const isSubscribed = subscriptionsDb?.isInSubscriptions(channel.channel_id) ?? false;

  send(rawRes, renderChannelPage(channel, videos, ctx.username!, ctx.permissions!, subscriptionsDb != null, isSubscribed));
});

addGetRoute(app, '/add-user', (req, ctx, rawRes): void => {
  if (!canCreateUsers(ctx.permissions!)) {
    send(rawRes, renderNotAllowed(ctx.username!, ctx.permissions!));
    return;
  }

  const availableChannels = getChannelsForUser(ctx.permissions!.allowedChannels);

  send(rawRes, renderAddUserPage(ctx.username!, ctx.permissions!, availableChannels));
});

addGetRoute(app, '/manage-users', (req, ctx, rawRes): void => {
  if (!canCreateUsers(ctx.permissions!)) {
    send(rawRes, renderNotAllowed(ctx.username!, ctx.permissions!));
    return;
  }

  const availableChannels = getChannelsForUser(ctx.permissions!.allowedChannels);
  const createdUsers = getCreatedAccountsWithPermissions(ctx.username!);

  send(rawRes, renderManageUsersPage(ctx.username!, ctx.permissions!, availableChannels, createdUsers));
});

addGetRoute(app, '/settings', (req, ctx, rawRes): void => {
  send(rawRes, renderSettingsPage(ctx.username!, ctx.permissions!));
});

addGetRoute(app, '/subscriptions', (req, ctx, rawRes): void => {
  if (!subscriptionsDb) {
    rawRes.statusCode = 500;
    send(rawRes, 'Server was started without --enable-subscriptions');
    return;
  }

  if (!ctx.permissions!.canSubscribe) {
    send(rawRes, renderNotAllowed(ctx.username!, ctx.permissions!));
    return;
  }

  const subscriptions = subscriptionsDb.getSubscriptionData();
  send(rawRes, renderSubscriptionsPage(ctx.username!, ctx.permissions!, subscriptions));
});

addGetRoute(app, '/add-video', (req, ctx, rawRes): void => {
  if (!subscriptionsDb) {
    rawRes.statusCode = 500;
    send(rawRes, 'Server was started without --enable-subscriptions');
    return;
  }

  if (!ctx.permissions!.canSubscribe) {
    send(rawRes, renderNotAllowed(ctx.username!, ctx.permissions!));
    return;
  }

  const videoQueue = subscriptionsDb.getVideoQueue();
  send(rawRes, renderAddVideoPage(ctx.username!, ctx.permissions!, videoQueue));
});

addGetRoute(app, '/media/videos/:video_id', async (req, ctx, rawRes): Promise<void> => {
  const videoId = nameExt(req.params.video_id).name;
  const video = getVideoById(videoId as VideoID);
  if (!video) {
    rawRes.statusCode = 404;
    send(rawRes, 'Video not found');
    return;
  }
  if (!canViewVideo(ctx.permissions!, video)) {
    rawRes.statusCode = 403;
    send(rawRes, 'Access denied');
    return;
  }
  await sendFile(req, rawRes, video.video_filename);
});

addGetRoute(app, '/media/thumbs/:video_id', async (req, ctx, rawRes): Promise<void> => {
  const videoId = nameExt(req.params.video_id).name;
  const video = getVideoById(videoId as VideoID);
  if (video?.thumb_filename == null) {
    rawRes.statusCode = 404;
    send(rawRes, 'not found');
    return;
  }
  if (!canViewVideo(ctx.permissions!, video)) {
    rawRes.statusCode = 403;
    send(rawRes, 'Access denied');
    return;
  }
  await sendFile(req, rawRes, video.thumb_filename);
});

addGetRoute(app, '/media/subtitles/:video_id/:lang', async (req, ctx, rawRes): Promise<void> => {
  const video = getVideoById(req.params.video_id as VideoID);
  const subtitlePath = video?.subtitles_files[req.params.lang];
  if (!subtitlePath) {
    rawRes.statusCode = 404;
    send(rawRes, 'not found');
    return;
  }
  if (!canViewVideo(ctx.permissions!, video)) {
    rawRes.statusCode = 403;
    send(rawRes, 'Access denied');
    return;
  }
  rawRes.setHeader('Content-Type', 'text/vtt');
  await sendFile(req, rawRes, subtitlePath);
});

addGetRoute(app, '/media/avatars/:short_id', async (req, ctx, rawRes): Promise<void> => {
  const channelShortId = nameExt(req.params.short_id).name;
  const channel = getChannelByShortId(channelShortId);
  if (channel?.avatar_filename == null) {
    rawRes.statusCode = 404;
    send(rawRes, 'not found');
    return;
  }
  if (channelAccess(ctx.permissions!, channel.channel_id) === 'none') {
    rawRes.statusCode = 403;
    send(rawRes, 'Access denied');
    return;
  }
  await sendFile(req, rawRes, channel.avatar_filename);
});

addAPIs(app);

const original404 = app.notFoundHandler;
app.notFoundHandler = (req, ctx, rawRes) => {
  console.error(`404 for ${req.originalUrl}`);
  original404(req, ctx, rawRes);
};

listen(app, port, (error) => {
  if (error) {
    throw error;
  }
  console.log(`LocalTube server running on http://localhost:${port}`);
});
