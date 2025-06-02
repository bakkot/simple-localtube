import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { getRecentVideosForChannels, getVideoById, getChannelByShortId, getVideosByChannel, getAllChannels, getChannelsForUser, addVideo, addChannel, channelExists, type Video, type Channel } from './media-db.ts';
import { nameExt, type VideoID, type ChannelID } from './util.ts';
import { checkUsernamePassword, decodeBearerToken, canUserViewChannel, getUserPermissions, addUser, hasAnyUsers } from './user-db.ts';
import { renderSetupPage, renderLoginPage, renderHomePage, renderVideoPage, renderChannelPage, renderAddUserPage, renderNotAllowed } from './frontend.ts';

// Extend Request interface to include username
declare global {
  namespace Express {
    interface Request {
      username?: string;
    }
  }
}

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

  // Skip login, setup, and add-video routes
  if (req.path === '/login' || req.path === '/api/login' || req.path === '/api/add-video' || isSetup) {
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

app.post('/api/login', async (req: Request, res: Response): Promise<void> => {
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

    const { username, password, allowedChannels, createUser } = req.body;

    if (!username || !password || !allowedChannels || createUser === undefined) {
      res.status(400).json({ message: 'Username, password, allowedChannels, and createUser are required' });
      return;
    }

    if (typeof username !== 'string' || typeof password !== 'string' || typeof createUser !== 'boolean') {
      res.status(400).json({ message: 'Username and password must be strings, createUser must be boolean' });
      return;
    }

    let channelPermissions: Set<ChannelID> | 'all';
    if (allowedChannels === 'all') {
      if (userPermissions.allowedChannels !== 'all') {
        res.status(403).json({ message: 'Only users with all-channel access can grant all-channel access' });
        return;
      }
      channelPermissions = 'all';
    } else {
      if (!Array.isArray(allowedChannels)) {
        res.status(400).json({ message: 'allowedChannels must be "all" or an array of channel IDs' });
        return;
      }

      const requestedChannelSet = new Set(allowedChannels);
      const currentUserChannels = userPermissions.allowedChannels;

      if (currentUserChannels !== 'all') {
        for (const channelId of requestedChannelSet) {
          if (!currentUserChannels.has(channelId as ChannelID)) {
            res.status(403).json({ message: `You don't have permission to grant access to channel: ${channelId}` });
            return;
          }
        }
      }

      channelPermissions = requestedChannelSet as Set<ChannelID>;
    }

    await addUser(username, password, {
      allowedChannels: channelPermissions,
      createUser,
    });

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

app.post('/api/add-video', async (req: Request, res: Response): Promise<void> => {
  try {
    const { video, channel } = req.body;

    if (!video || !channel) {
      res.status(400).json({ message: 'Both video and channel data are required' });
      return;
    }

    const requiredVideoFields = ['video_id', 'title', 'description', 'video_filename', 'upload_timestamp'];
    const requiredChannelFields = ['channel_id', 'channel', 'short_id'];

    for (const field of requiredVideoFields) {
      if (!video[field]) {
        res.status(400).json({ message: `Video field '${field}' is required` });
        return;
      }
    }

    for (const field of requiredChannelFields) {
      if (!channel[field]) {
        res.status(400).json({ message: `Channel field '${field}' is required` });
        return;
      }
    }

    if (!channelExists(video.channel_id as ChannelID)) {
      const channelData: Channel = {
        channel_id: channel.channel_id,
        channel: channel.channel,
        short_id: channel.short_id,
        description: channel.description || null,
        avatar_filename: channel.avatar_filename || null,
        banner_filename: channel.banner_filename || null,
        banner_uncropped_filename: channel.banner_uncropped_filename || null,
      };
      addChannel(channelData);
    }

    const videoData: Video = {
      video_id: video.video_id,
      channel_id: video.channel_id,
      title: video.title,
      description: video.description,
      video_filename: video.video_filename,
      thumb_filename: video.thumb_filename || null,
      duration_seconds: video.duration_seconds || 0,
      upload_timestamp: video.upload_timestamp,
      subtitles: video.subtitles || {},
    };

    addVideo(videoData);

    res.json({ message: 'Video added successfully' });
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