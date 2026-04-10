import { addGetRoute, addPostRoute, type App, type HttpRequest, type HttpResponse } from './httplib.ts';
import { addUser, areRequestedPermissionsAllowedByGranterPermissions, canCreateUsers, canViewChannel, changePassword, checkUsernamePassword, getCreatedAccounts, getCreatedBy, getUserPermissions, hasAnyUsers, updateUserPermissions } from './user-db.ts';
import { channelIDFromCanonicalURL, toVideoID, type ChannelID, type VideoID, assertChannelId } from './util.ts';
import { getChannelById, getChannelByShortId, getChannelsSorted, getRecentVideosForChannels, getVideosByChannel, search, searchByTier, type Channel, type ChannelSort, type SearchTier, type Video } from './media-db.ts';
import { subscriptionsDb } from './server.ts';
import { getJsonEnd } from './json-excise.ts';

interface VideoDetails {
  videoId: string;
  title: string;
  channelId: string;
  author: string;
  thumbnail?: { thumbnails: { url: string; width: number; height: number }[] };
}

interface FetchedVideoDetails {
  details: VideoDetails;
  thumbnailBuf: Uint8Array | null;
  thumbnailMime: string | null;
}

async function fetchVideoDetails(videoId: VideoID): Promise<FetchedVideoDetails | null> {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LocalTube/1.0)'
      }
    });
    if (!response.ok) return null;

    const html = await response.text();
    const needle = '"videoDetails":';
    let details: VideoDetails | null = null;
    let searchFrom = 0;
    while (true) {
      const idx = html.indexOf(needle, searchFrom);
      if (idx === -1) break;
      const jsonStart = idx + needle.length;
      const jsonEnd = getJsonEnd(html, jsonStart);
      if (jsonEnd === -1) {
        searchFrom = jsonStart;
        continue;
      }
      try {
        const obj = JSON.parse(html.slice(jsonStart, jsonEnd)) as VideoDetails;
        if (obj && typeof obj.videoId === 'string') {
          details = obj;
          break;
        }
      } catch {
        // not valid JSON, try next
      }
      searchFrom = jsonStart;
    }

    if (!details) return null;
    assertChannelId(details.channelId);

    let thumbnailBuf: Uint8Array | null = null;
    let thumbnailMime: string | null = null;
    const thumbs = details.thumbnail?.thumbnails;
    if (thumbs && thumbs.length > 0) {
      const smallest = thumbs.reduce((a, b) => a.width * a.height <= b.width * b.height ? a : b);
      try {
        const thumbResp = await fetch(smallest.url);
        if (thumbResp.ok) {
          thumbnailBuf = new Uint8Array(await thumbResp.arrayBuffer());
          thumbnailMime = thumbResp.headers.get('content-type') ?? 'image/jpeg';
        }
      } catch {
        // thumbnail fetch failed, non-fatal
      }
    }

    return { details, thumbnailBuf, thumbnailMime };
  } catch {
    // fetch failed
  }
  return null;
}

interface AvatarViewModel {
  image?: {
    sources?: { url: string; width: number; height: number }[];
  };
}

interface FetchedChannelDetails {
  channelId: ChannelID;
  title: string;
  avatarBuf: Uint8Array | null;
  avatarMime: string | null;
}

async function fetchChannelDetails(input: string): Promise<FetchedChannelDetails> {
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
    // Check if it's alphanumeric/underscore/dash, possibly with leading @
    const cleanInput = input.trim();
    if (cleanInput.startsWith('@')) {
      const handle = cleanInput.slice(1);
      if (!/^[a-zA-Z0-9_]+$/.test(handle)) {
        throw new Error(`Invalid handle format: ${JSON.stringify(cleanInput)}`);
      }
      url = `https://youtube.com/@${handle}`;
    } else {
      if (!/^[a-zA-Z0-9_-]+$/.test(cleanInput)) {
        throw new Error(`Invalid handle format: ${JSON.stringify(cleanInput)}`);
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

    let avatarBuf: Uint8Array | null = null;
    let avatarMime: string | null = null;
    const needle = '"avatarViewModel":';
    let searchFrom = 0;
    while (true) {
      const idx = html.indexOf(needle, searchFrom);
      if (idx === -1) break;
      const jsonStart = idx + needle.length;
      const jsonEnd = getJsonEnd(html, jsonStart);
      if (jsonEnd === -1) {
        searchFrom = jsonStart;
        continue;
      }
      try {
        const obj = JSON.parse(html.slice(jsonStart, jsonEnd)) as AvatarViewModel;
        const sources = obj?.image?.sources;
        if (sources && sources.length > 0) {
          const smallest = sources.reduce((a, b) => a.width * a.height <= b.width * b.height ? a : b);
          try {
            const avatarResp = await fetch(smallest.url);
            if (avatarResp.ok) {
              avatarBuf = new Uint8Array(await avatarResp.arrayBuffer());
              avatarMime = avatarResp.headers.get('content-type') ?? 'image/jpeg';
            }
          } catch {
            // avatar fetch failed, non-fatal
          }
          break;
        }
      } catch {
        // not valid JSON, try next
      }
      searchFrom = jsonStart;
    }

    return { channelId, title, avatarBuf, avatarMime };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to resolve channel: ${error.message}`);
    }
    throw new Error('Failed to resolve channel');
  }
}


export type HealthcheckAPI = boolean;
export type AddUserAPIRequest = {
  username: string;
  password: string;
  allowedChannels: 'all' | ChannelID[];
  createUser: 'yes' | 'no' | 'limited';
  canSubscribe: boolean;
}
export function addAPIs(app: App) {
  addPostRoute(app, '/api/setup', async (req: HttpRequest, res: HttpResponse): Promise<void> => {
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

      await addUser(username, password, {
        allowedChannels: 'all',
        createUser: 'yes',
        canSubscribe: true,
      }, null);

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

  addPostRoute(app, '/api/add-user', async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    try {
      if (!canCreateUsers(req.permissions!)) {
        res.status(403).json({ message: 'Not authorized to create users' });
        return;
      }

      const { username, password, allowedChannels, createUser, canSubscribe } = req.body as AddUserAPIRequest;

      if (typeof username !== 'string' || typeof password !== 'string' || (createUser !== 'yes' && createUser !== 'no' && createUser !== 'limited') || typeof canSubscribe !== 'boolean') {
        res.status(400).json({ message: 'Username and password must be strings, createUser must be "yes", "no", or "limited", canSubscribe must be boolean' });
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

      if (!areRequestedPermissionsAllowedByGranterPermissions(requestedPermissions, req.permissions!)) {
        res.status(403).json({ message: 'You cannot grant permissions that you do not have' });
        return;
      }

      await addUser(username, password, requestedPermissions, req.username!);

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

  addPostRoute(app, '/api/update-user-permissions', async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    try {
      if (!canCreateUsers(req.permissions!)) {
        res.status(403).json({ message: 'Not authorized to manage users' });
        return;
      }

      const { username, allowedChannels, createUser, canSubscribe } = req.body as {
        username: unknown; allowedChannels: unknown; createUser: unknown; canSubscribe: unknown;
      };

      if (typeof username !== 'string' || (createUser !== 'yes' && createUser !== 'no' && createUser !== 'limited') || typeof canSubscribe !== 'boolean') {
        res.status(400).json({ message: 'Invalid request body' });
        return;
      }

      const createdBy = getCreatedBy(username);
      if (createdBy !== req.username) {
        res.status(403).json({ message: 'You can only modify permissions of users you created' });
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
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        createUser: createUser as 'yes' | 'no' | 'limited',
        canSubscribe,
      };

      if (!areRequestedPermissionsAllowedByGranterPermissions(requestedPermissions, req.permissions!)) {
        res.status(403).json({ message: 'You cannot grant permissions that you do not have' });
        return;
      }

      updateUserPermissions(username, requestedPermissions);

      res.json({ message: 'Permissions updated successfully' });
    } catch (error) {
      console.error('Update user permissions error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  addPostRoute(app, '/api/change-password', async (req: HttpRequest, res: HttpResponse): Promise<void> => {
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

  addGetRoute(app, '/api/videos', (req: HttpRequest, res: HttpResponse): void => {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 30;

    const videos = getRecentVideosForChannels(req.permissions!.allowedChannels, limit, offset);

    res.json(videos);
  });

  const validSorts = new Set<ChannelSort>(['recent', 'oldest', 'a-z', 'z-a']);
  addGetRoute(app, '/api/channels', (req: HttpRequest, res: HttpResponse): void => {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 30;
    const sort: ChannelSort = validSorts.has(req.query.sort as ChannelSort) ? req.query.sort as ChannelSort : 'recent';

    const channels = getChannelsSorted(req.permissions!.allowedChannels, sort, limit, offset);

    res.json(channels);
  });

  const validSearchTiers = new Set<SearchTier>(['channels', 'title', 'description', 'subtitles']);
  addGetRoute(app, '/api/search', (req: HttpRequest, res: HttpResponse): void => {
    const q = (req.query.q as string || '').trim();
    if (!q) {
      res.json([]);
      return;
    }
    const limit = parseInt(req.query.limit as string) || 30;
    const offset = parseInt(req.query.offset as string) || 0;
    let allowedChannels = req.permissions!.allowedChannels;
    const channelId = req.query.channel;
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

  addGetRoute(app, '/api/channel/:short_id/videos', (req: HttpRequest, res: HttpResponse): void => {
    const channel = getChannelByShortId(req.params.short_id);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    if (!canViewChannel(req.permissions!, channel.channel_id)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 30;
    const videos = getVideosByChannel(channel.channel_id, limit, offset);
    res.json(videos);
  });


  addPostRoute(app, '/public-api/login', async (req: HttpRequest, res: HttpResponse): Promise<void> => {
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

  addGetRoute(app, '/public-api/healthcheck', (req: HttpRequest, res: HttpResponse): void => {
    res.json(true satisfies HealthcheckAPI);
  });

  addPostRoute(app, '/api/add-subscription', async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    try {
      if (!req.permissions!.canSubscribe) {
        res.status(403).json({ message: 'You do not have permission to manage subscriptions' });
        return;
      }

      if (!subscriptionsDb) {
        res.status(403).json({ message: 'Subscriptions are not enabled' });
        return;
      }

      const { channelId, recentLimit } = req.body as { channelId: unknown; recentLimit: unknown };

      if (typeof channelId !== 'string') {
        res.status(400).json({ message: 'Channel input must be a string' });
        return;
      }

      let resolvedRecentLimit: number | null = null;
      if (recentLimit != null) {
        if (typeof recentLimit !== 'number' || !Number.isInteger(recentLimit) || recentLimit < 1) {
          res.status(400).json({ message: 'recentLimit must be a positive integer' });
          return;
        }
        resolvedRecentLimit = recentLimit;
      }

      const { channelId: resolvedChannelId, title, avatarBuf, avatarMime } = await fetchChannelDetails(channelId.trim());
      subscriptionsDb.addSubscription(resolvedChannelId, title, resolvedRecentLimit, avatarBuf, avatarMime);
      res.json({ message: 'Subscription added successfully' });
    } catch (error) {
      console.error('Add subscription error:', error);
      let msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message: 'Failed to add subscription: ' + msg });
    }
  });

  addPostRoute(app, '/api/add-video', async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    try {
      if (!req.permissions!.canSubscribe) {
        res.status(403).json({ message: 'You do not have permission to manage subscriptions' });
        return;
      }

      if (!subscriptionsDb) {
        res.status(403).json({ message: 'Subscriptions are not enabled' });
        return;
      }

      const { videoInput } = req.body as { videoInput: unknown };

      if (typeof videoInput !== 'string') {
        res.status(400).json({ message: 'Video input must be a string' });
        return;
      }

      const videoId = toVideoID(videoInput.trim());
      if (!videoId) {
        res.status(400).json({ message: 'Could not extract a video ID from the input. Accepts YouTube URLs (including mobile, short, and shorts links) or an 11-character video ID.' });
        return;
      }

      const fetched = await fetchVideoDetails(videoId);
      const d = fetched?.details ?? null;
      subscriptionsDb.addVideoToQueue(
        videoId,
        d?.title ?? null,
        (d?.channelId ?? null) as ChannelID | null,
        d?.author ?? null,
        fetched?.thumbnailBuf ?? null,
      );
      let thumbnailDataUri: string | null = null;
      if (fetched?.thumbnailBuf && fetched.thumbnailMime) {
        thumbnailDataUri = `data:${fetched.thumbnailMime};base64,${fetched.thumbnailBuf.toBase64()}`;
      }
      res.json({
        message: 'Video added to queue',
        videoId,
        title: d?.title ?? null,
        channelId: d?.channelId ?? null,
        channelName: d?.author ?? null,
        thumbnail: thumbnailDataUri,
      });
    } catch (error) {
      console.error('Add video error:', error);
      let msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message: 'Failed to add video: ' + msg });
    }
  });

  addPostRoute(app, '/api/remove-queued-video', (req: HttpRequest, res: HttpResponse): void => {
    try {
      if (!req.permissions!.canSubscribe) {
        res.status(403).json({ message: 'You do not have permission to manage subscriptions' });
        return;
      }

      if (!subscriptionsDb) {
        res.status(403).json({ message: 'Subscriptions are not enabled' });
        return;
      }

      const { videoId } = req.body as { videoId: unknown };

      if (!videoId || typeof videoId !== 'string') {
        res.status(400).json({ message: 'Video ID is required and must be a string' });
        return;
      }

      subscriptionsDb.removeVideoFromQueue(videoId as VideoID);
      res.json({ message: 'Video removed from queue' });
    } catch (error) {
      console.error('Remove queued video error:', error);
      let msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message: 'Failed to remove video: ' + msg });
    }
  });

  addPostRoute(app, '/api/unsubscribe', async (req: HttpRequest, res: HttpResponse): Promise<void> => {
    try {
      if (!req.permissions!.canSubscribe) {
        res.status(403).json({ message: 'You do not have permission to manage subscriptions' });
        return;
      }

      if (!subscriptionsDb) {
        res.status(403).json({ message: 'Subscriptions are not enabled' });
        return;
      }

      const { channelId } = req.body as { channelId: unknown };

      if (!channelId || typeof channelId !== 'string') {
        res.status(400).json({ message: 'Channel ID is required and must be a string' });
        return;
      }

      subscriptionsDb.removeSubscription(channelId as ChannelID);
      res.json({ message: 'Unsubscribed successfully' });
    } catch (error) {
      console.error('Unsubscribe error:', error);
      let msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message: 'Failed to unsubscribe: ' + msg });
    }
  });


}
