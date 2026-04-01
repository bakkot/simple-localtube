import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { parseArgs } from 'util';
import { readFileSync, writeFileSync } from 'fs';
import { getRecentVideosForChannels, getVideoById, getChannelByShortId, getVideosByChannel, getAllChannels, getChannelsForUser, getChannelsSorted, addVideo, addChannel, type Video, type Channel, type ChannelSort, isVideoInDb, getChannelById } from './media-db.ts';
import { nameExt, channelIDFromCanonicalURL, lock, type VideoID, type ChannelID, readSubscriptionsFile } from './util.ts';
import { checkUsernamePassword, decodeBearerToken, canUserViewChannel, getUserPermissions, addUser, hasAnyUsers, arePermissionsAtLeastAsRestrictive } from './user-db.ts';
import { renderSetupPage, renderLoginPage, renderHomePage, renderChannelsPage, renderVideoPage, renderChannelPage, renderAddUserPage, renderNotAllowed, renderSubscriptionsPage, renderSettingsPage } from './frontend.ts';
import { addAPIs } from './server-api.ts';

// Extend Request interface to include username
declare global {
  namespace Express {
    interface Request {
      username?: string;
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
  const authCookie = req.cookies?.auth;
  let isAuthenticated = false;
  let username: string | undefined;

  if (authCookie) {
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

  // Attach username to request for later use
  req.username = username;
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
  const authCookie = req.cookies?.auth;
  if (authCookie) {
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
  const permissions = getUserPermissions(req.username!);
  const videos = getRecentVideosForChannels(permissions.allowedChannels, 30);

  res.send(renderHomePage(req.username!, permissions, videos));
});

app.get('/channels', (req, res) => {
  const permissions = getUserPermissions(req.username!);
  const channels = getChannelsSorted(permissions.allowedChannels, 'recent', 30);
  res.send(renderChannelsPage(req.username!, permissions, channels));
});

// Video player page
app.get('/v/:video_id', (req: Request, res: Response): void => {
  const video = getVideoById(req.params.video_id as VideoID);
  if (!video) {
    res.status(404).send('Video not found');
    return;
  }

  const permissions = getUserPermissions(req.username!);
  if (!canUserViewChannel(req.username!, video.channel_id)) {
    res.send(renderNotAllowed(req.username!, permissions));
    return;
  }

  res.send(renderVideoPage(video, req.username!, permissions));
});

// Channel page
app.get('/c/:short_id', (req: Request, res: Response): void => {
  const channel = getChannelByShortId(req.params.short_id);
  if (!channel) {
    res.status(404).send('Channel not found');
    return;
  }

  const permissions = getUserPermissions(req.username!);
  if (!canUserViewChannel(req.username!, channel.channel_id)) {
    res.send(renderNotAllowed(req.username!, permissions));
    return;
  }

  const videos = getVideosByChannel(channel.channel_id, 30);

  res.send(renderChannelPage(channel, videos, req.username!, permissions));
});

app.get('/add-user', (req: Request, res: Response): void => {
  const userPermissions = getUserPermissions(req.username!);

  if (!userPermissions.createUser) {
    res.send(renderNotAllowed(req.username!, userPermissions));
    return;
  }

  const availableChannels = getChannelsForUser(userPermissions.allowedChannels);

  res.send(renderAddUserPage(req.username!, userPermissions, availableChannels));
});

app.get('/settings', (req: Request, res: Response): void => {
  const permissions = getUserPermissions(req.username!);
  res.send(renderSettingsPage(req.username!, permissions));
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
  const userPermissions = getUserPermissions(req.username!);
  res.send(renderSubscriptionsPage(req.username!, userPermissions, subscriptionsData));
});

app.get('/media/videos/:video_id', async (req: Request, res: Response): Promise<void> => {
  const videoId = nameExt(req.params.video_id).name;
  const video = getVideoById(videoId as VideoID);
  if (!video) {
    res.status(404).send('Video not found');
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
  res.sendFile(video.thumb_filename);
});

app.get('/media/subtitles/:video_id/:lang', async (req: Request, res: Response): Promise<void> => {
  const video = getVideoById(req.params.video_id as VideoID);
  const subtitlePath = video?.subtitles_files[req.params.lang];
  if (!subtitlePath) {
    res.status(404).send('not found');
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
  res.sendFile(channel.avatar_filename);
});

addAPIs(app);


app.listen(PORT, (error) => {
  if (error) {
    throw error;
  }
  console.log(`LocalTube server running on http://localhost:${PORT}`);
});
