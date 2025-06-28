import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { parseArgs } from 'util';
import { readFileSync } from 'fs';
import { getRecentVideosForChannels, getVideoById, getChannelByShortId, getVideosByChannel, getAllChannels, getChannelsForUser, addVideo, addChannel, type Video, type Channel, isVideoInDb, getChannelById } from './media-db.ts';
import { nameExt, type VideoID, type ChannelID } from './util.ts';
import { checkUsernamePassword, decodeBearerToken, canUserViewChannel, getUserPermissions, addUser, hasAnyUsers, arePermissionsAtLeastAsRestrictive } from './user-db.ts';
import { renderSetupPage, renderLoginPage, renderHomePage, renderVideoPage, renderChannelPage, renderAddUserPage, renderNotAllowed, renderSubscriptionsPage } from './frontend.ts';

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

  // Login. setup, and public-api do not require auth
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
  const allowedChannels = getUserPermissions(req.username!).allowedChannels;
  const videos = getRecentVideosForChannels(allowedChannels, 30);

  res.send(renderHomePage(req.username!, videos));
});

// Video player page
app.get('/v/:video_id', (req: Request, res: Response): void => {
  const video = getVideoById(req.params.video_id as VideoID);
  if (!video) {
    res.status(404).send('Video not found');
    return;
  }

  if (!canUserViewChannel(req.username!, video.channel_id)) {
    res.send(renderNotAllowed(req.username!));
    return;
  }

  res.send(renderVideoPage(video, req.username!));
});

// Channel page
app.get('/c/:short_id', (req: Request, res: Response): void => {
  const channel = getChannelByShortId(req.params.short_id);
  if (!channel) {
    res.status(404).send('Channel not found');
    return;
  }

  if (!canUserViewChannel(req.username!, channel.channel_id)) {
    res.send(renderNotAllowed(req.username!));
    return;
  }

  const videos = getVideosByChannel(channel.channel_id, 30);

  res.send(renderChannelPage(channel, videos, req.username!));
});

app.get('/add-user', (req: Request, res: Response): void => {
  const userPermissions = getUserPermissions(req.username!);

  if (!userPermissions.createUser) {
    res.send(renderNotAllowed(req.username!));
    return;
  }

  const availableChannels = getChannelsForUser(userPermissions.allowedChannels);

  res.send(renderAddUserPage(req.username!, userPermissions, availableChannels));
});

app.get('/subscriptions', (req: Request, res: Response): void => {
  if (!values.subscriptions) {
    res.status(500).send('Server was started without passing --subscriptions');
    return;
  }

  try {
    const subscriptionsData = JSON.parse(readFileSync(values.subscriptions, 'utf8'));
    const allowedChannels = getUserPermissions(req.username!).allowedChannels;
    res.send(renderSubscriptionsPage(req.username!, subscriptionsData, allowedChannels));
  } catch (error) {
    console.error('Error reading subscriptions file:', error);
    res.status(500).send('Error reading subscriptions file');
  }
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

app.get('/media/avatars/:short_id', async (req: Request, res: Response): Promise<void> => {
  const channelShortId = nameExt(req.params.short_id).name;
  const channel = getChannelByShortId(channelShortId);
  if (channel?.avatar_filename == null) {
    res.status(404).send('not found');
    return;
  }
  res.sendFile(channel.avatar_filename);
});

app.post('/api/setup', async (req: Request, res: Response): Promise<void> => {
  try {
    if (hasAnyUsers()) {
      res.status(403).json({ message: 'Setup has already been completed' });
      return;
    }

    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ message: 'Username and password are required' });
      return;
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ message: 'Username and password must be strings' });
      return;
    }

    // Create first user with full admin permissions
    await addUser(username, password, {
      allowedChannels: 'all',
      createUser: true,
      canSubscribe: true,
    });

    res.json({ message: 'Administrator account created successfully' });
  } catch (error: any) {
    console.error('Setup error:', error);
    if (error.message === 'User already exists') {
      res.status(409).json({ message: 'Username already exists' });
    } else {
      res.status(500).json({ message: 'Internal server error' });
    }
  }
});

app.post('/api/add-user', async (req: Request, res: Response): Promise<void> => {
  try {
    const userPermissions = getUserPermissions(req.username!);

    if (!userPermissions.createUser) {
      res.status(403).json({ message: 'Not authorized to create users' });
      return;
    }

    const { username, password, allowedChannels, createUser, canSubscribe } = req.body;

    if (!username || !password || !allowedChannels || createUser === undefined || canSubscribe === undefined) {
      res.status(400).json({ message: 'Username, password, allowedChannels, createUser, and canSubscribe are required' });
      return;
    }

    if (typeof username !== 'string' || typeof password !== 'string' || typeof createUser !== 'boolean' || typeof canSubscribe !== 'boolean') {
      res.status(400).json({ message: 'Username and password must be strings, createUser and canSubscribe must be boolean' });
      return;
    }

    if (canSubscribe && allowedChannels !== 'all') {
      res.status(400).json({ message: 'Subscription management is only available for users with access to all channels' });
      return;
    }

    let channelPermissions: Set<ChannelID> | 'all';
    if (allowedChannels === 'all') {
      channelPermissions = 'all';
    } else {
      if (!Array.isArray(allowedChannels)) {
        res.status(400).json({ message: 'allowedChannels must be "all" or an array of channel IDs' });
        return;
      }
      channelPermissions = new Set(allowedChannels) as Set<ChannelID>;
    }

    const requestedPermissions = {
      allowedChannels: channelPermissions,
      createUser,
      canSubscribe,
    };

    if (!arePermissionsAtLeastAsRestrictive(requestedPermissions, userPermissions)) {
      res.status(403).json({ message: 'You cannot grant permissions that you do not have' });
      return;
    }

    await addUser(username, password, requestedPermissions);

    res.json({ message: 'User created successfully' });
  } catch (error: any) {
    console.error('Add user error:', error);
    if (error.message === 'User already exists') {
      res.status(409).json({ message: 'Username already exists' });
    } else if (error.message.includes('Channel') && error.message.includes('does not exist')) {
      res.status(400).json({ message: error.message });
    } else {
      res.status(500).json({ message: 'Internal server error' });
    }
  }
});

app.get('/api/videos', (req: Request, res: Response): void => {
  const offset = parseInt(req.query.offset as string) || 0;
  const limit = parseInt(req.query.limit as string) || 30;

  const allowedChannels = getUserPermissions(req.username!).allowedChannels;
  const videos = getRecentVideosForChannels(allowedChannels, limit, offset);

  res.json(videos);
});

app.get('/api/channel/:short_id/videos', (req: Request, res: Response): void => {
  const channel = getChannelByShortId(req.params.short_id);
  if (!channel) {
    res.status(404).json({ error: 'Channel not found' });
    return;
  }

  if (!canUserViewChannel(req.username!, channel.channel_id)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  const offset = parseInt(req.query.offset as string) || 0;
  const limit = parseInt(req.query.limit as string) || 30;
  const videos = getVideosByChannel(channel.channel_id, limit, offset);
  res.json(videos);
});

app.post('/public-api/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ message: 'Username and password required' });
      return;
    }

    const token = await checkUsernamePassword(username, password);

    if (token) {
      res.json({ token });
    } else {
      res.status(401).json({ message: 'Invalid username or password' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/public-api/has-video', (req: Request, res: Response): void => {
  const videoId = req.query.video_id as string;

  if (!videoId) {
    res.status(400).json({ message: 'video_id query parameter is required' });
    return;
  }

  res.json(isVideoInDb(videoId as VideoID));
});

app.get('/public-api/has-channel', (req: Request, res: Response): void => {
  const channelId = req.query.channel_id as string;

  if (!channelId) {
    res.status(400).json({ message: 'channel_id query parameter is required' });
    return;
  }

  res.json(getChannelByShortId(channelId as ChannelID) != null);
});

app.get('/public-api/healthcheck', (req: Request, res: Response): void => {
  res.json(true);
});

app.post('/public-api/add-video', async (req: Request, res: Response): Promise<void> => {
  try {
    const video = req.body as Video;

    if (!video) {
      res.status(400).json({ message: 'add-video requires video data' });
      return;
    }

    const requiredVideoFields = ['video_id', 'title', 'description', 'channel_id', 'video_filename', 'upload_timestamp'] as const;

    for (const field of requiredVideoFields) {
      if (video[field] == null) {
        res.status(400).json({ message: `Video field '${field}' is required` });
        return;
      }
    }
    if (getChannelById(video.channel_id) == null) {
      res.status(400).json({ message: `Trying to add video for unknown channel ${video.channel_id}` });
      return;
    }

    // TODO adding video which agrees with existing data should not error

    addVideo(video);
    console.log(`added ${JSON.stringify(video.title)} from API`);

    res.json(true);
  } catch (error: any) {
    console.error('Add video error:', error);
    if (error.message.includes('UNIQUE constraint failed')) {
      if (error.message.includes('videos.video_id')) {
        res.status(409).json({ message: 'Video with this ID already exists' });
      } else if (error.message.includes('channels.channel_id')) {
        res.status(409).json({ message: 'Channel with this ID already exists' });
      } else if (error.message.includes('channels.short_id')) {
        res.status(409).json({ message: 'Channel with this short ID already exists' });
      } else {
        res.status(409).json({ message: 'Duplicate entry detected' });
      }
    } else {
      res.status(500).json({ message: 'Internal server error' });
    }
  }
});

app.post('/public-api/add-channel', async (req: Request, res: Response): Promise<void> => {
  try {
    const channel = req.body as Channel;

    if (!channel) {
      res.status(400).json({ message: 'add-channel requires channel data' });
      return;
    }

    const requiredChannelFields = ['channel_id', 'channel', 'short_id'] as const;
    for (const field of requiredChannelFields) {
      if (channel[field] == null) {
        res.status(400).json({ message: `Channel field '${field}' is required` });
        return;
      }
    }
    // TODO adding channel which agrees with existing data should not error

    addChannel(channel);

    console.log(`added ${JSON.stringify(channel.channel)} from API`);

    res.json(true);
  } catch (error: any) {
    console.error('Add video error:', error);
    if (error.message.includes('UNIQUE constraint failed')) {
      if (error.message.includes('videos.video_id')) {
        res.status(409).json({ message: 'Video with this ID already exists' });
      } else if (error.message.includes('channels.channel_id')) {
        res.status(409).json({ message: 'Channel with this ID already exists' });
      } else if (error.message.includes('channels.short_id')) {
        res.status(409).json({ message: 'Channel with this short ID already exists' });
      } else {
        res.status(409).json({ message: 'Duplicate entry detected' });
      }
    } else {
      res.status(500).json({ message: 'Internal server error' });
    }
  }
});

app.listen(PORT, () => {
  console.log(`LocalTube server running on http://localhost:${PORT}`);
});
