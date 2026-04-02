import type { Express, Request, Response } from 'express';
import { addUser, arePermissionsAtLeastAsRestrictive, canUserViewChannel, changePassword, checkUsernamePassword, getUserPermissions, hasAnyUsers } from './user-db.ts';
import { lock, channelIDFromCanonicalURL, type ChannelID, type VideoID, readSubscriptionsFile, assertChannelId } from './util.ts';
import { addChannel, addVideo, getChannelById, getChannelByShortId, getChannelsSorted, getRecentVideosForChannels, getVideosByChannel, isVideoInDb, search, searchByTier, type Channel, type ChannelSort, type SearchTier, type Video } from './media-db.ts';
import { readFileSync, writeFileSync } from 'fs';
import { subscriptionsFile } from './server.ts';

async function resolveChannelInput(input: string): Promise<{ channelId: ChannelID; title: string }> {
  let url: string;

  // Check if input looks like a URL
  if (input.startsWith('http:') || input.startsWith('https:')) {
    try {
      const parsedUrl = new URL(input);
      if (!parsedUrl.hostname.endsWith('youtube.com')) {
        throw new Error('Only YouTube URLs are supported');
      }
      url = input;
    } catch (error) {
      throw new Error('Invalid URL format');
    }
  } else {
    // Check if it's alphanumeric/underscore, possibly with leading @
    const cleanInput = input.trim();
    if (cleanInput.startsWith('@')) {
      const handle = cleanInput.slice(1);
      if (!/^[a-zA-Z0-9_]+$/.test(handle)) {
        throw new Error('Invalid handle format. Use only letters, numbers, and underscores');
      }
      url = `https://youtube.com/@${handle}`;
    } else {
      if (!/^[a-zA-Z0-9_]+$/.test(cleanInput)) {
        throw new Error('Invalid channel ID format. Use only letters, numbers, and underscores');
      }
      url = `https://youtube.com/channel/${cleanInput}`;
    }
  }

  // Fetch the page and extract canonical URL
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LocalTube/1.0)'
      }
    });

    if (!response.ok) {
      throw new Error(`YouTube returned ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);

    if (!canonicalMatch) {
      throw new Error('Could not find canonical URL on YouTube page');
    }

    const channelId = channelIDFromCanonicalURL(canonicalMatch[1]);
    if (!channelId) {
      throw new Error('Could not extract channel ID from canonical URL');
    }

    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/ - YouTube$/, '') : 'Unknown Channel';

    return { channelId, title };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to resolve channel: ${error.message}`);
    }
    throw new Error('Failed to resolve channel');
  }
}

async function addSubscription(channelId: ChannelID, title: string): Promise<void> {
  if (!subscriptionsFile) {
    throw new Error('Subscriptions file not configured');
  }

  using _lockfile = await lock(subscriptionsFile);
  const subscriptionsData = readSubscriptionsFile(subscriptionsFile);

  const subscribing = subscriptionsData.subscribing || [];
  const subscribed = subscriptionsData.subscribed || [];
  const titles = subscriptionsData.titles || {};

  if (subscribing.includes(channelId) || subscribed.includes(channelId)) {
    throw new Error('Channel is already in subscriptions');
  }

  subscriptionsData.subscribing = [...subscribing, channelId];
  subscriptionsData.titles = { ...titles, [channelId]: title };

  writeFileSync(subscriptionsFile, JSON.stringify(subscriptionsData, null, 2));
}

async function removeSubscription(channelId: ChannelID): Promise<void> {
  if (!subscriptionsFile) {
    throw new Error('Subscriptions file not configured');
  }

  using _lockfile = await lock(subscriptionsFile);
  const subscriptionsData = readSubscriptionsFile(subscriptionsFile);

  const subscribing = subscriptionsData.subscribing || [];
  const subscribed = subscriptionsData.subscribed || [];
  const titles = subscriptionsData.titles || {};

  if (!subscribing.includes(channelId) && !subscribed.includes(channelId)) {
    throw new Error(`Channel ${channelId} is not in subscriptions`);
  }

  subscriptionsData.subscribing = subscribing.filter((id: string) => id !== channelId);
  subscriptionsData.subscribed = subscribed.filter((id: string) => id !== channelId);
  const { [channelId]: removed, ...remainingTitles } = titles;
  subscriptionsData.titles = remainingTitles;

  writeFileSync(subscriptionsFile, JSON.stringify(subscriptionsData, null, 2));
}

export type HealthcheckAPI = boolean;
export type AddChannelAPI = boolean;
export type AddVideoAPI = boolean;
export type AddUserAPIRequest = {
  username: string;
  password: string;
  allowedChannels: 'all' | ChannelID[];
  createUser: boolean;
  canSubscribe: boolean;
}
export function addAPIs(app: Express) {
  app.post('/api/setup', async (req: Request, res: Response): Promise<void> => {
    try {
      if (hasAnyUsers()) {
        res.status(403).json({ message: 'Setup has already been completed' });
        return;
      }

      const { username, password } = req.body as { username: unknown; password: unknown };

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
    } catch (error) {
      console.error('Setup error:', error);
      let msg = error instanceof Error ? error.message : '';
      if (msg === 'User already exists') {
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

      const { username, password, allowedChannels, createUser, canSubscribe } = req.body as AddUserAPIRequest;

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
        try {
          allowedChannels.forEach(assertChannelId);
        } catch (e: unknown) {
          res.status(400).json({ message: (e as Error).message });
          return;
        }
        channelPermissions = new Set(allowedChannels);
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
    } catch (error) {
      console.error('Add user error:', error);
      let msg = error instanceof Error ? error.message : '';
      if (msg === 'User already exists') {
        res.status(409).json({ message: 'Username already exists' });
      } else if (msg.includes('Channel') && msg.includes('does not exist')) {
        res.status(400).json({ message: msg });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.post('/api/change-password', async (req: Request, res: Response): Promise<void> => {
    try {
      const { currentPassword, newPassword } = req.body as { currentPassword: unknown; newPassword: unknown };

      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        res.status(400).json({ message: 'Passwords must be strings' });
        return;
      }

      await changePassword(req.username!, currentPassword, newPassword);

      res.json({ message: 'Password changed successfully' });
    } catch (error) {
      // console.error('Change password error:', error);
      let msg = error instanceof Error ? error.message : '';
      if (msg === 'Current password is incorrect') {
        res.status(403).json({ message: 'Current password is incorrect' });
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

  const validSorts = new Set<ChannelSort>(['recent', 'oldest', 'a-z', 'z-a']);
  app.get('/api/channels', (req: Request, res: Response): void => {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 30;
    const sort: ChannelSort = validSorts.has(req.query.sort as ChannelSort) ? req.query.sort as ChannelSort : 'recent';

    const allowedChannels = getUserPermissions(req.username!).allowedChannels;
    const channels = getChannelsSorted(allowedChannels, sort, limit, offset);

    res.json(channels);
  });

  const validSearchTiers = new Set<SearchTier>(['channels', 'title', 'description', 'subtitles']);
  app.get('/api/search', (req: Request, res: Response): void => {
    const q = (req.query.q as string || '').trim();
    if (!q) {
      res.json([]);
      return;
    }
    const limit = parseInt(req.query.limit as string) || 30;
    const offset = parseInt(req.query.offset as string) || 0;
    let allowedChannels = getUserPermissions(req.username!).allowedChannels;
    const channelId = req.query.channel as string | undefined;
    if (channelId) {
      if (allowedChannels !== 'all' && !allowedChannels.has(channelId as ChannelID)) {
        res.status(403).json({ message: 'Access denied' });
        return;
      }
      allowedChannels = new Set([channelId as ChannelID]);
    }
    const prefix = req.query.prefix === '1' || req.query.prefix === 'true';
    const tier = req.query.tier as SearchTier;
    if (!validSearchTiers.has(tier)) {
      res.status(400).json({ message: 'tier parameter required: channels, title, description, or subtitles' });
      return;
    }
    res.json(searchByTier(q, tier, allowedChannels, limit, offset, prefix));
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
      const { username, password } = req.body as { username: string, password: string };

      if (typeof username !== 'string' || typeof password !== 'string') {
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

    res.json(getChannelById(channelId as ChannelID) != null);
  });

  app.get('/public-api/healthcheck', (req: Request, res: Response): void => {
    res.json(true satisfies HealthcheckAPI);
  });

  app.post('/api/add-subscription', async (req: Request, res: Response): Promise<void> => {
    try {
      const userPermissions = getUserPermissions(req.username!);

      if (!userPermissions.canSubscribe) {
        res.status(403).json({ message: 'You do not have permission to manage subscriptions' });
        return;
      }

      // TODO 403 if no subscriptions file configured

      const { channelId } = req.body as { channelId: unknown };

      if (typeof channelId !== 'string') {
        res.status(400).json({ message: 'Channel input must be a string' });
        return;
      }

      const { channelId: resolvedChannelId, title } = await resolveChannelInput(channelId.trim());
      await addSubscription(resolvedChannelId, title);
      res.json({ message: 'Subscription added successfully' });
    } catch (error) {
      console.error('Add subscription error:', error);
      let msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message: 'Failed to add subscription: ' + msg });
    }
  });

  app.post('/api/unsubscribe', async (req: Request, res: Response): Promise<void> => {
    try {
      const userPermissions = getUserPermissions(req.username!);

      if (!userPermissions.canSubscribe) {
        res.status(403).json({ message: 'You do not have permission to manage subscriptions' });
        return;
      }

      const { channelId } = req.body as { channelId: unknown };

      if (!channelId || typeof channelId !== 'string') {
        res.status(400).json({ message: 'Channel ID is required and must be a string' });
        return;
      }

      await removeSubscription(channelId as ChannelID);
      res.json({ message: 'Unsubscribed successfully' });
    } catch (error) {
      console.error('Unsubscribe error:', error);
      let msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message: 'Failed to unsubscribe: ' + msg });
    }
  });


  // TODO probably this should not be public
  // for the downloader, maybe spin up a separate server on a separate port?
  // or of course just write to the db directly, it's probably fine
  // ditto add-channel
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

      addVideo(video);
      console.log(`added ${JSON.stringify(video.title)} from API`);

      res.json(true satisfies AddVideoAPI);
    } catch (error) {
      console.error('Add video error:', error);
      let msg = error instanceof Error ? error.message : '';
      if (msg.includes('UNIQUE constraint failed')) {
        if (msg.includes('videos.video_id')) {
          res.status(409).json({ message: 'Video with this ID already exists' });
        } else if (msg.includes('channels.channel_id')) {
          res.status(409).json({ message: 'Channel with this ID already exists' });
        } else if (msg.includes('channels.short_id')) {
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
    // TODO bail if exists
    try {
      const channel = req.body as Record<string, unknown>;

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

      // TODO validate
      addChannel(channel as unknown as Channel);

      console.log(`added ${JSON.stringify(channel.channel)} from API`);

      res.json(true satisfies AddChannelAPI);
    } catch (error) {
      console.error('Add video error:', error);
      let msg = error instanceof Error ? error.message : '';
      if (msg.includes('UNIQUE constraint failed')) {
        if (msg.includes('videos.video_id')) {
          res.status(409).json({ message: 'Video with this ID already exists' });
        } else if (msg.includes('channels.channel_id')) {
          res.status(409).json({ message: 'Channel with this ID already exists' });
        } else if (msg.includes('channels.short_id')) {
          res.status(409).json({ message: 'Channel with this short ID already exists' });
        } else {
          res.status(409).json({ message: 'Duplicate entry detected' });
        }
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });
}
