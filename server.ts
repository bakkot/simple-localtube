import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { parseArgs } from 'util';
import { readFileSync, writeFileSync } from 'fs';
import { getRecentVideosForChannels, getVideoById, getChannelByShortId, getVideosByChannel, getAllChannels, getChannelsForUser, getChannelsSorted, addVideo, addChannel, search, type Video, type Channel, type ChannelSort, isVideoInDb, getChannelById } from './media-db.ts';
import { nameExt, channelIDFromCanonicalURL, lock, type VideoID, type ChannelID, readSubscriptionsFile } from './util.ts';
import { checkUsernamePassword, decodeBearerToken, canUserViewChannel, getUserPermissions, addUser, hasAnyUsers, arePermissionsAtLeastAsRestrictive, getCreatedAccountsWithPermissions, type Permissions } from './user-db.ts';
import { renderSetupPage, renderLoginPage, renderHomePage, renderChannelsPage, renderVideoPage, renderChannelPage, renderAddUserPage, renderManageUsersPage, renderNotAllowed, renderSubscriptionsPage, renderSettingsPage, renderSearchPage } from './frontend.ts';
import { addAPIs } from './server-api.ts';

// Extend Request interface to include username
declare global {
  namespace Express {
    interface Request {
      username?: string;
      permissions?: Permissions;
    }
  }
}

const { values } = parseArgs({
  options: {
    subscriptions: {
      type: 'string',
    },
  },
});
export const subscriptionsFile = values.subscriptions;


const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cookieParser());

// Auth middleware - must be first to protect everything
app.use((req: Request, res: Response, next: NextFunction): void => {
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
  const authCookie = req.cookies?.auth as unknown;
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
});

app.get('/setup', (req: Request, res: Response): void => {
  if (hasAnyUsers()) {
    res.redirect('/login');
    return;
  }

  res.send(renderSetupPage());
});

app.get('/login', (req: Request, res: Response): void => {
  // Check if user is already authenticated
  const authCookie = req.cookies?.auth as unknown;
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

app.get('/', (req, res) => {
  const videos = getRecentVideosForChannels(req.permissions!.allowedChannels, 30);

  res.send(renderHomePage(req.username!, req.permissions!, videos));
});

app.get('/search', (req, res) => {
  const q = (req.query.q as string || '').trim();
  const channelId = req.query.channel as string | undefined;
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

app.get('/channels', (req, res) => {
  const channels = getChannelsSorted(req.permissions!.allowedChannels, 'recent', 30);
  res.send(renderChannelsPage(req.username!, req.permissions!, channels));
});

// Video player page
app.get('/v/:video_id', (req: Request, res: Response): void => {
  const video = getVideoById(req.params.video_id as VideoID);
  if (!video) {
    res.status(404).send('Video not found');
    return;
  }

  if (!canUserViewChannel(req.username!, video.channel_id)) {
    res.send(renderNotAllowed(req.username!, req.permissions!));
    return;
  }

  res.send(renderVideoPage(video, req.username!, req.permissions!));
});

// Channel page
app.get('/c/:short_id', (req: Request, res: Response): void => {
  const channel = getChannelByShortId(req.params.short_id);
  if (!channel) {
    res.status(404).send('Channel not found');
    return;
  }

  if (!canUserViewChannel(req.username!, channel.channel_id)) {
    res.send(renderNotAllowed(req.username!, req.permissions!));
    return;
  }

  const videos = getVideosByChannel(channel.channel_id, 30);

  res.send(renderChannelPage(channel, videos, req.username!, req.permissions!));
});

app.get('/add-user', (req: Request, res: Response): void => {
  if (!req.permissions!.createUser) {
    res.send(renderNotAllowed(req.username!, req.permissions!));
    return;
  }

  const availableChannels = getChannelsForUser(req.permissions!.allowedChannels);

  res.send(renderAddUserPage(req.username!, req.permissions!, availableChannels));
});

app.get('/manage-users', (req: Request, res: Response): void => {
  if (!req.permissions!.createUser) {
    res.send(renderNotAllowed(req.username!, req.permissions!));
    return;
  }

  const availableChannels = getChannelsForUser(req.permissions!.allowedChannels);
  const createdUsers = getCreatedAccountsWithPermissions(req.username!);

  res.send(renderManageUsersPage(req.username!, req.permissions!, availableChannels, createdUsers));
});

app.get('/settings', (req: Request, res: Response): void => {
  res.send(renderSettingsPage(req.username!, req.permissions!));
});

app.get('/subscriptions', (req: Request, res: Response): void => {
  if (!subscriptionsFile) {
    res.status(500).send('Server was started without passing --subscriptions');
    return;
  }

  let subscriptionsData
  try {
    subscriptionsData = readSubscriptionsFile(subscriptionsFile);
  } catch (error) {
    console.error('Error reading subscriptions file:', error);
    res.status(500).send('Error reading subscriptions file');
    return;
  }
  res.send(renderSubscriptionsPage(req.username!, req.permissions!, subscriptionsData));
});

app.get('/media/videos/:video_id', async (req: Request, res: Response): Promise<void> => {
  const videoId = nameExt(req.params.video_id).name;
  const video = getVideoById(videoId as VideoID);
  if (!video) {
    res.status(404).send('Video not found');
    return;
  }
  if (!canUserViewChannel(req.username!, video.channel_id)) {
    res.status(403).send('Access denied');
    return;
  }
  res.sendFile(video.video_filename);
});

app.get('/media/thumbs/:video_id', async (req: Request, res: Response): Promise<void> => {
  const videoId = nameExt(req.params.video_id).name;
  const video = getVideoById(videoId as VideoID);
  if (video?.thumb_filename == null) {
    res.status(404).send('not found');
    return;
  }
  if (!canUserViewChannel(req.username!, video.channel_id)) {
    res.status(403).send('Access denied');
    return;
  }
  res.sendFile(video.thumb_filename);
});

app.get('/media/subtitles/:video_id/:lang', async (req: Request, res: Response): Promise<void> => {
  const video = getVideoById(req.params.video_id as VideoID);
  const subtitlePath = video?.subtitles_files[req.params.lang];
  if (!subtitlePath) {
    res.status(404).send('not found');
    return;
  }
  if (!canUserViewChannel(req.username!, video!.channel_id)) {
    res.status(403).send('Access denied');
    return;
  }
  res.type('text/vtt').sendFile(subtitlePath);
});

app.get('/media/avatars/:short_id', async (req: Request, res: Response): Promise<void> => {
  const channelShortId = nameExt(req.params.short_id).name;
  const channel = getChannelByShortId(channelShortId);
  if (channel?.avatar_filename == null) {
    res.status(404).send('not found');
    return;
  }
  if (!canUserViewChannel(req.username!, channel.channel_id)) {
    res.status(403).send('Access denied');
    return;
  }
  res.sendFile(channel.avatar_filename);
});

addAPIs(app);


app.listen(PORT, (error) => {
  if (error) {
    throw error;
  }
  console.log(`LocalTube server running on http://localhost:${PORT}`);
});
