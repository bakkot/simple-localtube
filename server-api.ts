import { addGetRoute, addPostRoute, getBodyJson, sendJson, type App } from './httplib.ts';
import { addAllowedVideoToUser, addUser, applyUserChannelCount, areRequestedPermissionsAllowedByGranterPermissions, buildSearchScope, canCreateUsers, canViewChannel, canViewVideo, channelAccess, changePassword, checkUsernamePassword, getCreatedAccounts, getCreatedBy, getUserPermissions, hasAnyUsers, removeAllowedVideoFromUser, updateUserPermissions, type Permissions, type StoredPermissions } from './user-db.ts';
import { channelIDFromCanonicalURL, toVideoID, type ChannelID, type VideoID, assertChannelId } from './util.ts';
import { getChannelById, getChannelByShortId, getChannelsSorted, getRecentVideosForUser, getVideoById, getVideosByChannel, getVideosByIds, search, searchByTier, type Channel, type ChannelSort, type SearchTier, type Video } from './media-db.ts';
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

const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const allowedMediaMimes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

function isAllowedMediaHost(host: string): boolean {
  return host === 'ytimg.com' || host.endsWith('.ytimg.com')
    || host === 'ggpht.com' || host.endsWith('.ggpht.com')
    || host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com');
}

// Fetch a YouTube-served avatar/thumbnail with strict allowlists on host, size, and content-type
// to prevent the surrounding flow from being abused as an SSRF / memory-DoS / XSS-via-data-URI primitive.
async function fetchMedia(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !isAllowedMediaHost(parsed.hostname)) {
    return null;
  }

  let resp: Response;
  try {
    resp = await fetch(url, { redirect: 'error' });
  } catch {
    return null;
  }
  if (!resp.ok || !resp.body) return null;

  const mime = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!allowedMediaMimes.has(mime)) {
    void resp.body.cancel();
    return null;
  }

  const declared = resp.headers.get('content-length');
  if (declared != null && Number(declared) > MAX_MEDIA_BYTES) {
    void resp.body.cancel();
    return null;
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MEDIA_BYTES) {
        void reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, mime };
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
      const fetched = await fetchMedia(smallest.url);
      if (fetched) {
        thumbnailBuf = fetched.bytes;
        thumbnailMime = fetched.mime;
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
      const host = parsedUrl.hostname;
      if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) {
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
          const fetched = await fetchMedia(smallest.url);
          if (fetched) {
            avatarBuf = fetched.bytes;
            avatarMime = fetched.mime;
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
export function addAPIs(app: App<{ username?: string; permissions?: Permissions }>) {
  addPostRoute(app, '/api/setup', async (req, ctx, rawRes): Promise<void> => {
    try {
      if (hasAnyUsers()) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'Setup has already been completed' });
        return;
      }

      const { username, password } = await getBodyJson(req) as { username: unknown; password: unknown };

      if (typeof username !== 'string' || typeof password !== 'string') {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Username and password must be strings' });
        return;
      }

      await addUser(username, password, {
        allowedChannels: 'all',
        allowedVideos: null,
        createUser: 'yes',
        canSubscribe: true,
      }, null);

      sendJson(rawRes, { message: 'Administrator account created successfully' });
    } catch (error) {
      console.error('Setup error:', error);
      let msg = error instanceof Error ? error.message : '';
      if (msg === 'User already exists') {
        rawRes.statusCode = 409;
        sendJson(rawRes, { message: 'Username already exists' });
      } else {
        rawRes.statusCode = 500;
        sendJson(rawRes, { message: 'Internal server error' });
      }
    }
  });

  addPostRoute(app, '/api/add-user', async (req, ctx, rawRes): Promise<void> => {
    try {
      if (!canCreateUsers(ctx.permissions!)) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'Not authorized to create users' });
        return;
      }

      const { username, password, allowedChannels, createUser, canSubscribe } = await getBodyJson(req) as AddUserAPIRequest;

      if (typeof username !== 'string' || typeof password !== 'string' || (createUser !== 'yes' && createUser !== 'no' && createUser !== 'limited') || typeof canSubscribe !== 'boolean') {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Username and password must be strings, createUser must be "yes", "no", or "limited", canSubscribe must be boolean' });
        return;
      }

      if (canSubscribe && allowedChannels !== 'all') {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Subscription management is only available for users with access to all channels' });
        return;
      }

      let requestedPermissions: StoredPermissions;
      if (allowedChannels === 'all') {
        requestedPermissions = { allowedChannels: 'all', allowedVideos: null, createUser, canSubscribe };
      } else {
        if (!Array.isArray(allowedChannels)) {
          rawRes.statusCode = 400;
          sendJson(rawRes, { message: 'allowedChannels must be "all" or an array of channel IDs' });
          return;
        }
        try {
          allowedChannels.forEach(assertChannelId);
        } catch (e: unknown) {
          rawRes.statusCode = 400;
          sendJson(rawRes, { message: (e as Error).message });
          return;
        }
        requestedPermissions = {
          allowedChannels: new Set(allowedChannels),
          allowedVideos: new Set(),
          createUser,
          canSubscribe,
        };
      }

      if (!areRequestedPermissionsAllowedByGranterPermissions(requestedPermissions, ctx.permissions!)) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'You cannot grant permissions that you do not have' });
        return;
      }

      await addUser(username, password, requestedPermissions, ctx.username!);

      sendJson(rawRes, { message: 'User created successfully' });
    } catch (error) {
      console.error('Add user error:', error);
      let msg = error instanceof Error ? error.message : '';
      if (msg === 'User already exists') {
        rawRes.statusCode = 409;
        sendJson(rawRes, { message: 'Username already exists' });
      } else if (msg.includes('Channel') && msg.includes('does not exist')) {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: msg });
      } else {
        rawRes.statusCode = 500;
        sendJson(rawRes, { message: 'Internal server error' });
      }
    }
  });

  addPostRoute(app, '/api/update-user-permissions', async (req, ctx, rawRes): Promise<void> => {
    try {
      if (!canCreateUsers(ctx.permissions!)) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'Not authorized to manage users' });
        return;
      }

      const { username, allowedChannels, createUser, canSubscribe } = await getBodyJson(req) as {
        username: unknown; allowedChannels: unknown; createUser: unknown; canSubscribe: unknown;
      };

      if (typeof username !== 'string' || (createUser !== 'yes' && createUser !== 'no' && createUser !== 'limited') || typeof canSubscribe !== 'boolean') {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Invalid request body' });
        return;
      }

      const createdBy = getCreatedBy(username);
      if (createdBy !== ctx.username) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'You can only modify permissions of users you created' });
        return;
      }

      if (canSubscribe && allowedChannels !== 'all') {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Subscription management is only available for users with access to all channels' });
        return;
      }

      const existing = getUserPermissions(username);
      let requestedPermissions: StoredPermissions;
      if (allowedChannels === 'all') {
        requestedPermissions = { allowedChannels: 'all', allowedVideos: null, createUser, canSubscribe };
      } else {
        if (!Array.isArray(allowedChannels)) {
          rawRes.statusCode = 400;
          sendJson(rawRes, { message: 'allowedChannels must be "all" or an array of channel IDs' });
          return;
        }
        try {
          allowedChannels.forEach(assertChannelId);
        } catch (e: unknown) {
          rawRes.statusCode = 400;
          sendJson(rawRes, { message: (e as Error).message });
          return;
        }
        requestedPermissions = {
          allowedChannels: new Set(allowedChannels),
          allowedVideos: existing.allowedVideos ?? new Set(),
          createUser,
          canSubscribe,
        };
      }

      if (!areRequestedPermissionsAllowedByGranterPermissions(requestedPermissions, ctx.permissions!)) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'You cannot grant permissions that you do not have' });
        return;
      }

      updateUserPermissions(username, requestedPermissions);

      sendJson(rawRes, { message: 'Permissions updated successfully' });
    } catch (error) {
      console.error('Update user permissions error:', error);
      rawRes.statusCode = 500;
      sendJson(rawRes, { message: 'Internal server error' });
    }
  });

  addPostRoute(app, '/api/update-user-allowed-video', async (req, ctx, rawRes): Promise<void> => {
    try {
      if (!canCreateUsers(ctx.permissions!)) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'Not authorized to manage users' });
        return;
      }

      const { username, videoId, action } = await getBodyJson(req) as {
        username: unknown; videoId: unknown; action: unknown;
      };

      if (typeof username !== 'string' || typeof videoId !== 'string' || (action !== 'add' && action !== 'remove')) {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Invalid request body' });
        return;
      }

      let createdBy: string | null;
      try {
        createdBy = getCreatedBy(username);
      } catch {
        rawRes.statusCode = 404;
        sendJson(rawRes, { message: 'User not found' });
        return;
      }
      if (createdBy !== ctx.username) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'You can only modify permissions of users you created' });
        return;
      }

      const targetPerms = getUserPermissions(username);
      if (targetPerms.allowedChannels === 'all') {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'User already has access to all channels' });
        return;
      }

      const video = getVideoById(videoId as VideoID);
      if (!video) {
        rawRes.statusCode = 404;
        sendJson(rawRes, { message: 'Video not found' });
        return;
      }

      if (action === 'add') {
        if (!canViewVideo(ctx.permissions!, video)) {
          rawRes.statusCode = 403;
          sendJson(rawRes, { message: 'You cannot grant access to a video you cannot see' });
          return;
        }
        addAllowedVideoToUser(username, video.video_id);
      } else {
        removeAllowedVideoFromUser(username, video.video_id);
      }

      sendJson(rawRes, { message: 'Updated successfully' });
    } catch (error) {
      console.error('Update user allowed video error:', error);
      rawRes.statusCode = 500;
      sendJson(rawRes, { message: 'Internal server error' });
    }
  });

  addGetRoute(app, '/api/user-allowed-videos', (req, ctx, rawRes): void => {
    if (!canCreateUsers(ctx.permissions!)) {
      rawRes.statusCode = 403;
      sendJson(rawRes, { message: 'Not authorized to manage users' });
      return;
    }
    const username = req.query.username;
    if (typeof username !== 'string' || !username) {
      rawRes.statusCode = 400;
      sendJson(rawRes, { message: 'username parameter required' });
      return;
    }
    let createdBy: string | null;
    try {
      createdBy = getCreatedBy(username);
    } catch {
      rawRes.statusCode = 404;
      sendJson(rawRes, { message: 'User not found' });
      return;
    }
    if (createdBy !== ctx.username) {
      rawRes.statusCode = 403;
      sendJson(rawRes, { message: 'You can only view videos of users you created' });
      return;
    }
    const targetPerms = getUserPermissions(username);
    if (targetPerms.allowedChannels === 'all') {
      sendJson(rawRes, []);
      return;
    }
    const videos = getVideosByIds([...targetPerms.allowedVideos]);
    sendJson(rawRes, videos);
  });

  addPostRoute(app, '/api/change-password', async (req, ctx, rawRes): Promise<void> => {
    try {
      const { currentPassword, newPassword } = await getBodyJson(req) as { currentPassword: unknown; newPassword: unknown };

      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Passwords must be strings' });
        return;
      }

      await changePassword(ctx.username!, currentPassword, newPassword);

      sendJson(rawRes, { message: 'Password changed successfully' });
    } catch (error) {
      // console.error('Change password error:', error);
      let msg = error instanceof Error ? error.message : '';
      if (msg === 'Current password is incorrect') {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'Current password is incorrect' });
      } else {
        rawRes.statusCode = 500;
        sendJson(rawRes, { message: 'Internal server error' });
      }
    }
  });

  addGetRoute(app, '/api/videos', (req, ctx, rawRes): void => {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 30;

    const videos = getRecentVideosForUser(ctx.permissions!.allowedChannels, ctx.permissions!.allowedVideos ?? new Set(), limit, offset);

    sendJson(rawRes, videos);
  });

  const validSorts = new Set<ChannelSort>(['recent', 'oldest', 'a-z', 'z-a']);
  addGetRoute(app, '/api/channels', (req, ctx, rawRes): void => {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 30;
    const sort: ChannelSort = validSorts.has(req.query.sort as ChannelSort) ? req.query.sort as ChannelSort : 'recent';

    const channels = getChannelsSorted(ctx.permissions!.allowedChannels, sort, limit, offset);

    sendJson(rawRes, channels);
  });

  const validSearchTiers = new Set<SearchTier>(['channels', 'title', 'description', 'subtitles']);
  addGetRoute(app, '/api/search', (req, ctx, rawRes): void => {
    const q = (req.query.q as string || '').trim();
    if (!q) {
      sendJson(rawRes, []);
      return;
    }
    const limit = parseInt(req.query.limit as string) || 30;
    const offset = parseInt(req.query.offset as string) || 0;
    const channelId = req.query.channel;
    let scopedChannelId: ChannelID | null = null;
    if (channelId) {
      if (channelAccess(ctx.permissions!, channelId as ChannelID) === 'none') {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'Access denied' });
        return;
      }
      scopedChannelId = channelId as ChannelID;
    }
    const prefix = req.query.prefix === '1' || req.query.prefix === 'true';
    const tier = req.query.tier as SearchTier;
    if (!validSearchTiers.has(tier)) {
      rawRes.statusCode = 400;
      sendJson(rawRes, { message: 'tier parameter required: channels, title, description, or subtitles' });
      return;
    }
    const scope = buildSearchScope(ctx.permissions!, scopedChannelId);
    let results = searchByTier(q, tier, scope, limit, offset, prefix);
    if (tier === 'channels') {
      results = (results as Channel[]).map(c => applyUserChannelCount(c, ctx.permissions!));
    }
    sendJson(rawRes, results);
  });

  addGetRoute(app, '/api/channel/:short_id/videos', (req, ctx, rawRes): void => {
    const channel = getChannelByShortId(req.params.short_id);
    if (!channel) {
      rawRes.statusCode = 404;
      sendJson(rawRes, { error: 'Channel not found' });
      return;
    }

    const access = channelAccess(ctx.permissions!, channel.channel_id);
    if (access === 'none') {
      rawRes.statusCode = 403;
      sendJson(rawRes, { error: 'Access denied' });
      return;
    }

    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 30;
    const videos = access === 'full'
      ? getVideosByChannel(channel.channel_id, limit, offset)
      : getVideosByChannel(channel.channel_id, limit, offset, ctx.permissions!.allowedVideos);
    sendJson(rawRes, videos);
  });


  addPostRoute(app, '/public-api/login', async (req, ctx, rawRes): Promise<void> => {
    let username, password;
    try {
      ({ username, password } = await getBodyJson(req) as { username: string, password: string });

      if (typeof username !== 'string' || typeof password !== 'string') {
        console.error(`Malformed login attempt`);
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Username and password required' });
        return;
      }

      const token = await checkUsernamePassword(username, password);

      if (token) {
        console.log(`Successful login for ${username}`);
        sendJson(rawRes, { token });
      } else {
        console.error(`Failed login for ${username}`);
        rawRes.statusCode = 401;
        sendJson(rawRes, { message: 'Invalid username or password' });
      }
    } catch (error) {
      if (username) {
        console.error(`Login failure for ${username}`, error);
      } else {
        console.error(`Login error`, error);
      }
      rawRes.statusCode = 500;
      sendJson(rawRes, { message: 'Internal server error' });
    }
  });

  addGetRoute(app, '/public-api/healthcheck', (req, ctx, rawRes): void => {
    sendJson(rawRes, true satisfies HealthcheckAPI);
  });

  addPostRoute(app, '/api/add-subscription', async (req, ctx, rawRes): Promise<void> => {
    try {
      if (!ctx.permissions!.canSubscribe) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'You do not have permission to manage subscriptions' });
        return;
      }

      if (!subscriptionsDb) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'Subscriptions are not enabled' });
        return;
      }

      const { channelId, recentLimit } = await getBodyJson(req) as { channelId: unknown; recentLimit: unknown };

      if (typeof channelId !== 'string') {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Channel input must be a string' });
        return;
      }

      let resolvedRecentLimit: number | null = null;
      if (recentLimit != null) {
        if (typeof recentLimit !== 'number' || !Number.isInteger(recentLimit) || recentLimit < 1) {
          rawRes.statusCode = 400;
          sendJson(rawRes, { message: 'recentLimit must be a positive integer' });
          return;
        }
        resolvedRecentLimit = recentLimit;
      }

      const { channelId: resolvedChannelId, title, avatarBuf, avatarMime } = await fetchChannelDetails(channelId.trim());
      subscriptionsDb.addSubscription(resolvedChannelId, title, resolvedRecentLimit, avatarBuf, avatarMime);
      sendJson(rawRes, { message: 'Subscription added successfully' });
    } catch (error) {
      console.error('Add subscription error:', error);
      let msg = error instanceof Error ? error.message : String(error);
      rawRes.statusCode = 500;
      sendJson(rawRes, { message: 'Failed to add subscription: ' + msg });
    }
  });

  addPostRoute(app, '/api/add-video', async (req, ctx, rawRes): Promise<void> => {
    try {
      if (!ctx.permissions!.canSubscribe) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'You do not have permission to manage subscriptions' });
        return;
      }

      if (!subscriptionsDb) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'Subscriptions are not enabled' });
        return;
      }

      const { videoInput } = await getBodyJson(req) as { videoInput: unknown };

      if (typeof videoInput !== 'string') {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Video input must be a string' });
        return;
      }

      const videoId = toVideoID(videoInput.trim());
      if (!videoId) {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Could not extract a video ID from the input. Accepts YouTube URLs (including mobile, short, and shorts links) or an 11-character video ID.' });
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
      sendJson(rawRes, {
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
      rawRes.statusCode = 500;
      sendJson(rawRes, { message: 'Failed to add video: ' + msg });
    }
  });

  addPostRoute(app, '/api/remove-queued-video', async (req, ctx, rawRes): Promise<void> => {
    try {
      if (!ctx.permissions!.canSubscribe) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'You do not have permission to manage subscriptions' });
        return;
      }

      if (!subscriptionsDb) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'Subscriptions are not enabled' });
        return;
      }

      const { videoId } = await getBodyJson(req) as { videoId: unknown };

      if (!videoId || typeof videoId !== 'string') {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Video ID is required and must be a string' });
        return;
      }

      subscriptionsDb.removeVideoFromQueue(videoId as VideoID);
      sendJson(rawRes, { message: 'Video removed from queue' });
    } catch (error) {
      console.error('Remove queued video error:', error);
      let msg = error instanceof Error ? error.message : String(error);
      rawRes.statusCode = 500;
      sendJson(rawRes, { message: 'Failed to remove video: ' + msg });
    }
  });

  addPostRoute(app, '/api/unsubscribe', async (req, ctx, rawRes): Promise<void> => {
    try {
      if (!ctx.permissions!.canSubscribe) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'You do not have permission to manage subscriptions' });
        return;
      }

      if (!subscriptionsDb) {
        rawRes.statusCode = 403;
        sendJson(rawRes, { message: 'Subscriptions are not enabled' });
        return;
      }

      const { channelId } = await getBodyJson(req) as { channelId: unknown };

      if (!channelId || typeof channelId !== 'string') {
        rawRes.statusCode = 400;
        sendJson(rawRes, { message: 'Channel ID is required and must be a string' });
        return;
      }

      subscriptionsDb.removeSubscription(channelId as ChannelID);
      sendJson(rawRes, { message: 'Unsubscribed successfully' });
    } catch (error) {
      console.error('Unsubscribe error:', error);
      let msg = error instanceof Error ? error.message : String(error);
      rawRes.statusCode = 500;
      sendJson(rawRes, { message: 'Failed to unsubscribe: ' + msg });
    }
  });
}
