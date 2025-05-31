import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { parseArgs } from 'util';
import { getRecentVideosForChannels, getVideoById, getChannelByShortId, getVideosByChannel, getAllChannels, getChannelsForUser } from './media-db.ts';
import { nameExt, type VideoID, type ChannelID } from './util.ts';
import { checkUsernamePassword, decodeBearerToken, canUserViewChannel, getUserPermissions, addUser, hasAnyUsers } from './user-db.ts';

// Extend Request interface to include username
declare global {
  namespace Express {
    interface Request {
      username?: string;
    }
  }
}

let { positionals } = parseArgs({ allowPositionals: true });
if (positionals.length !== 1) {
  console.log('Usage: node server.ts path-to-media-dir');
  process.exit(1);
}

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cookieParser());

// Auth middleware - must be first to protect everything
app.use((req: Request, res: Response, next: NextFunction): void => {
  // Skip login and setup routes
  if (req.path === '/login' || req.path === '/api/login' || req.path === '/setup' || req.path === '/api/setup') {
    return next();
  }

  // Check if any users exist - if not, redirect to setup
  if (!hasAnyUsers()) {
    if (req.path.startsWith('/api') || req.method !== 'GET') {
      res.status(403).json({ message: 'Setup required' });
      return;
    }
    res.redirect('/setup');
    return;
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

app.use('/media', express.static(positionals[0]));

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString();
}

function renderNotAllowed(username: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Not Allowed - LocalTube</title>
  <style>
    ${commonCSS}
    body { margin: 20px; }
    .not-allowed-container { max-width: 600px; margin: 50px auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center; }
    .not-allowed-title { color: #d32f2f; font-size: 24px; margin-bottom: 20px; }
    .not-allowed-message { color: #666; line-height: 1.5; margin-bottom: 30px; }
    .home-button { display: inline-block; background: #1976d2; color: white; padding: 12px 24px; border-radius: 4px; text-decoration: none; }
    .home-button:hover { background: #1565c0; }
  </style>
</head>
<body>
  <div class="header">
    <div class="user-info">
      <span class="username">${username}</span>
      <a href="#" class="logout-link" onclick="logout(); return false;">Logout</a>
    </div>
  </div>
  <div class="not-allowed-container">
    <div class="not-allowed-title">Access Not Allowed</div>
    <div class="not-allowed-message">
      You don't have permission to view this content.
    </div>
    <a href="/" class="home-button">Return Home</a>
  </div>
  <script>
    function logout() {
      document.cookie = 'auth=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      window.location.href = '/login';
    }
  </script>
</body>
</html>`;
}

function renderVideoCard(video: any, showChannel: boolean = true): string {
  return `
    <div class="video-card">
      <a href="/v/${video.video_id}">
        <div class="thumb-container">
          <img class="thumb" src="/media/${video.channel_id}/${video.video_id}/${video.thumb_filename || 'thumb.jpg'}" alt="${video.title}">
          <span class="duration">${formatDuration(video.duration_seconds || 0)}</span>
        </div>
      </a>
      <div class="video-info">
        <a href="/v/${video.video_id}" class="video-title">${video.title}</a>
        ${showChannel ? `<div><a href="/c/${video.channel_short_id}" class="channel-name">${video.channel}</a></div>` : ''}
        <div class="upload-date">${formatDate(video.upload_timestamp)}</div>
      </div>
    </div>`;
}

const videoCardScript = `
${formatDuration.toString()}

${formatDate.toString()}

${renderVideoCard.toString()}

function createInfiniteScroll(apiUrl, showChannel) {
  let offset = document.getElementById('video-grid').children.length;
  let loading = false;
  let exhausted = false;

  function loadMoreVideos() {
    if (loading || exhausted) return;
    loading = true;
    document.getElementById('loading').style.display = 'block';

    fetch(apiUrl + '?offset=' + offset + '&limit=30')
      .then(response => response.json())
      .then(videos => {
        if (videos.length === 0) {
          exhausted = true;
          document.getElementById('loading').textContent = 'No more videos';
          return;
        }

        const grid = document.getElementById('video-grid');
        videos.forEach(video => {
          grid.insertAdjacentHTML('beforeend', renderVideoCard(video, showChannel));
        });

        offset += videos.length;
        if (videos.length < 30) {
          exhausted = true;
          document.getElementById('loading').textContent = 'No more videos';
          return;
        }
      })
      .catch(error => {
        console.error('Error loading videos:', error);
        document.getElementById('loading').textContent = 'Error loading videos';
      })
      .finally(() => {
        loading = false;
        if (!exhausted) document.getElementById('loading').style.display = 'none';
      });
  }

  window.addEventListener('scroll', () => {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 200) {
      loadMoreVideos();
    }
  });
}
`;

const commonCSS = `
  body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; }
  .header { position: relative; }
  .user-info { position: absolute; top: 0; right: 0; display: flex; align-items: center; gap: 10px; font-size: 14px; }
  .username { color: #333; font-weight: bold; }
  .logout-link { color: #1976d2; text-decoration: none; cursor: pointer; }
  .logout-link:hover { text-decoration: underline; }
  .back-link { display: inline-block; color: #1976d2; text-decoration: none; }
  .back-link:hover { text-decoration: underline; }
  .content-section { background: #f5f5f5; padding: 20px; }
  .video-container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  .channel-name { color: #1976d2; text-decoration: none; font-weight: bold; }
  .channel-name:hover { text-decoration: underline; }
  .description { color: #666; line-height: 1.5; white-space: pre-wrap; }
  .video-grid { display: grid; grid-template-columns: repeat(auto-fit, 320px); gap: 20px; justify-content: center; }
  .video-card { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  .video-card:hover { box-shadow: 0 4px 8px rgba(0,0,0,0.15); }
  .thumb-container { position: relative; height: 180px; }
  .thumb { width: 100%; height: 100%; object-fit: cover; object-position: center; }
  .duration { position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.8); color: white; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  .video-info { padding: 12px; }
  .video-title { font-weight: bold; color: #333; text-decoration: none; }
  .video-title:hover { color: #1976d2; }
  .upload-date { color: #999; font-size: 12px; margin-top: 4px; }
  a { text-decoration: none; }
  .loading { text-align: center; padding: 30px 20px; color: #666; }
`;

app.get('/setup', (req: Request, res: Response): void => {
  // If users already exist, redirect to login
  if (hasAnyUsers()) {
    res.redirect('/login');
    return;
  }

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Setup - LocalTube</title>
  <style>
    ${commonCSS}
    .setup-container { max-width: 400px; margin: 50px auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .setup-form { display: flex; flex-direction: column; gap: 15px; }
    .form-group { display: flex; flex-direction: column; gap: 5px; }
    label { font-weight: bold; color: #333; }
    input[type="text"], input[type="password"] { padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 16px; }
    input[type="text"]:focus, input[type="password"]:focus { outline: none; border-color: #1976d2; }
    .setup-button { background: #1976d2; color: white; padding: 12px; border: none; border-radius: 4px; font-size: 16px; cursor: pointer; }
    .setup-button:hover { background: #1565c0; }
    .setup-button:disabled { background: #ccc; cursor: not-allowed; }
    .error { color: #d32f2f; font-size: 14px; margin-top: 10px; }
    .success { color: #388e3c; font-size: 14px; margin-top: 10px; }
    h1 { text-align: center; color: #333; margin-bottom: 10px; }
    .setup-info { color: #666; text-align: center; margin-bottom: 30px; font-size: 14px; line-height: 1.4; }
  </style>
</head>
<body>
  <div class="setup-container">
    <h1>Welcome to LocalTube</h1>
    <div class="setup-info">
      No users have been configured yet. Please create the first account to get started.
    </div>
    <form class="setup-form" id="setupForm">
      <div class="form-group">
        <label for="username">Username:</label>
        <input type="text" id="username" name="username" required>
      </div>
      <div class="form-group">
        <label for="password">Password:</label>
        <input type="password" id="password" name="password" required>
      </div>
      <button type="submit" class="setup-button" id="setupButton">Create Account</button>
      <div id="message"></div>
    </form>
  </div>

  <script>
    const form = document.getElementById('setupForm');
    const button = document.getElementById('setupButton');
    const message = document.getElementById('message');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      button.disabled = true;
      button.textContent = 'Creating Account...';
      message.textContent = '';
      message.className = '';

      try {
        const response = await fetch('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        if (response.ok) {
          message.textContent = 'Account created successfully! Redirecting to login...';
          message.className = 'success';
          setTimeout(() => { window.location.href = '/login'; }, 1500);
          return;
        } else {
          const error = await response.json();
          message.textContent = error.message || 'Setup failed';
          message.className = 'error';
        }
      } catch (err) {
        message.textContent = 'Network error. Please try again.';
        message.className = 'error';
      }

      button.disabled = false;
      button.textContent = 'Create Administrator Account';
    });
  </script>
</body>
</html>`);
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

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Login - LocalTube</title>
  <style>
    ${commonCSS}
    .login-container { max-width: 400px; margin: 50px auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .login-form { display: flex; flex-direction: column; gap: 15px; }
    .form-group { display: flex; flex-direction: column; gap: 5px; }
    label { font-weight: bold; color: #333; }
    input[type="text"], input[type="password"] { padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 16px; }
    input[type="text"]:focus, input[type="password"]:focus { outline: none; border-color: #1976d2; }
    .login-button { background: #1976d2; color: white; padding: 12px; border: none; border-radius: 4px; font-size: 16px; cursor: pointer; }
    .login-button:hover { background: #1565c0; }
    .login-button:disabled { background: #ccc; cursor: not-allowed; }
    .error { color: #d32f2f; font-size: 14px; margin-top: 10px; }
    .success { color: #388e3c; font-size: 14px; margin-top: 10px; }
    h1 { text-align: center; color: #333; margin-bottom: 30px; }
  </style>
</head>
<body>
  <div class="login-container">
    <h1>Login to LocalTube</h1>
    <form class="login-form" id="loginForm">
      <div class="form-group">
        <label for="username">Username:</label>
        <input type="text" id="username" name="username" required>
      </div>
      <div class="form-group">
        <label for="password">Password:</label>
        <input type="password" id="password" name="password" required>
      </div>
      <button type="submit" class="login-button" id="loginButton">Login</button>
      <div id="message"></div>
    </form>
  </div>

  <script>
    const form = document.getElementById('loginForm');
    const button = document.getElementById('loginButton');
    const message = document.getElementById('message');

    // Get next URL from query parameters
    const urlParams = new URLSearchParams(window.location.search);
    const nextParam = urlParams.get('next');
    const nextUrl = (nextParam && nextParam.startsWith('/')) ? nextParam : '/';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      button.disabled = true;
      button.textContent = 'Logging in...';
      message.textContent = '';
      message.className = '';

      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        if (response.ok) {
          const data = await response.json();
          document.cookie = 'auth=' + data.token + '; path=/; max-age=' + (365 * 24 * 60 * 60);
          message.textContent = 'Login successful! Redirecting...';
          message.className = 'success';
          setTimeout(() => { window.location.href = nextUrl; }, 100);
          return;
        } else {
          const error = await response.json();
          message.textContent = error.message || 'Login failed';
          message.className = 'error';
        }
      } catch (err) {
        message.textContent = 'Network error. Please try again.';
        message.className = 'error';
      }

      button.disabled = false;
      button.textContent = 'Login';
    });
  </script>
</body>
</html>`);
});

// Homepage
app.get('/', (req, res) => {
  const allowedChannels = getUserPermissions(req.username!).allowedChannels;
  const videos = getRecentVideosForChannels(allowedChannels, 30);

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>LocalTube</title>
  <style>
    ${commonCSS}
    body { margin: 20px; }
    h1 { color: #333; margin: 0px; }
    .video-grid { margin-top: 20px; }
    .video-title { margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>LocalTube</h1>
    <div class="user-info">
      <span class="username">${req.username}</span>
      <a href="#" class="logout-link" onclick="logout(); return false;">Logout</a>
    </div>
  </div>
  <div class="video-grid" id="video-grid">
    ${videos.map(video => renderVideoCard(video, true)).join('')}
  </div>
  <div class="loading" id="loading" style="display: none;">Loading more videos...</div>
  <script>
    ${videoCardScript}

    function logout() {
      document.cookie = 'auth=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      window.location.href = '/login';
    }

    createInfiniteScroll('/api/videos', true);
  </script>
</body>
</html>`);
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

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>${video.title}</title>
  <style>
    ${commonCSS}
    body { margin: 0;  }
    .video-section { background: #000; background: #000; width: 100%; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
    video { max-width: 100%; max-height: 80vh; height: auto; width: auto; }
    .video-title { font-size: 24px; font-weight: bold; margin-bottom: 10px; }
    .channel-info { display: flex; align-items: center; margin-bottom: 15px; }
    .channel-avatar { border-radius: 50%; margin-right: 10px; }
  </style>
</head>
<body>
  <div class="content-section">
    <div class="header">
      <a href="/" class="back-link">← Back to Home</a>
      ${req.username ? `
        <div class="user-info">
          <span class="username">${req.username}</span>
          <a href="#" class="logout-link" onclick="logout(); return false;">Logout</a>
        </div>
      ` : ''}
    </div>
  </div>
  <div class="video-section">
    <video controls autoplay>
      <source src="/media/${video.channel_id}/${video.video_id}/${video.video_filename}" type="video/${nameExt(video.video_filename).ext === 'mp4' ? 'mp4' : 'webm'}">
      Your browser does not support the video tag.
    </video>
  </div>
  <div class="content-section">
    <div class="video-container">
    <div class="video-info">
      <div class="video-title">${video.title}</div>
      <div class="channel-info">
        ${video.avatar_filename ? `<img class="channel-avatar" width=40 height=40 src="/media/${video.channel_id}/${video.avatar_filename}" alt="${video.channel}">` : ''}
        <a href="/c/${video.channel_short_id}" class="channel-name">${video.channel}</a>
      </div>
      <div class="description">${video.description}</div>
    </div>
  </div>
  </div>
  <script>
    function logout() {
      document.cookie = 'auth=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      window.location.href = '/login';
    }
  </script>
</body>
</html>`);
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

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>${channel.channel}</title>
  <style>
    ${commonCSS}
    body { margin: 20px; }
    .channel-header { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-top: 20px; margin-bottom: 20px; }
    .channel-info { display: flex; align-items: center; }
    .channel-avatar { width: 80px; height: 80px; border-radius: 50%; margin-right: 20px; }
    .channel-details h1 { margin: 0 0 10px 0; color: #333; }
    .channel-description { color: #666; line-height: 1.5; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="header">
    <a href="/" class="back-link">← Back to Home</a>
    ${req.username ? `
      <div class="user-info">
        <span class="username">${req.username}</span>
        <a href="#" class="logout-link" onclick="logout(); return false;">Logout</a>
      </div>
    ` : ''}
  </div>
  <div class="channel-header">
    <div class="channel-info">
      ${channel.avatar_filename ? `<img class="channel-avatar" width=80 height=80 src="/media/${channel.channel_id}/${channel.avatar_filename}" alt="${channel.channel}">` : ''}
      <div class="channel-details">
        <h1>${channel.channel}</h1>
        ${channel.description ? `<div class="channel-description">${channel.description}</div>` : ''}
      </div>
    </div>
  </div>
  <div class="video-grid" id="video-grid">
    ${videos.map(video => renderVideoCard(video, false)).join('')}
  </div>
  <div class="loading" id="loading" style="display: none;">Loading more videos...</div>
  <script>
    ${videoCardScript}

    function logout() {
      document.cookie = 'auth=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      window.location.href = '/login';
    }

    createInfiniteScroll('/api/channel/${channel.short_id}/videos', false);
  </script>
</body>
</html>`);
});

// Add user page
app.get('/add-user', (req: Request, res: Response): void => {
  const userPermissions = getUserPermissions(req.username!);

  if (!userPermissions.createUser) {
    res.send(renderNotAllowed(req.username!));
    return;
  }

  const availableChannels = getChannelsForUser(userPermissions.allowedChannels);

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Add User - LocalTube</title>
  <style>
    ${commonCSS}
    body { margin: 20px; }
    .add-user-container { max-width: 600px; margin: 20px auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .form-group { display: flex; flex-direction: column; gap: 5px; margin-bottom: 20px; }
    label { font-weight: bold; color: #333; }
    input[type="text"], input[type="password"] { padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 16px; }
    input[type="text"]:focus, input[type="password"]:focus { outline: none; border-color: #1976d2; }
    .permission-section { margin-bottom: 20px; }
    .permission-section h3 { color: #333; margin-bottom: 15px; }
    .radio-group { display: flex; flex-direction: column; gap: 10px; margin-bottom: 15px; }
    .radio-option { display: flex; align-items: center; gap: 8px; }
    .radio-option input[type="radio"] { margin: 0; }
    .channels-section { display: none; }
    .channels-section.visible { display: block; }
    .channel-controls { display: flex; gap: 10px; margin-bottom: 15px; }
    .channel-controls button { padding: 8px 16px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer; }
    .channel-controls button:hover { background: #f5f5f5; }
    .channels-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px; overflow-y: auto; border: 1px solid #ddd; padding: 15px; border-radius: 4px; }
    .channel-option { display: flex; align-items: center; gap: 8px; }
    .channel-option input[type="checkbox"] { margin: 0; }
    .create-button { background: #1976d2; color: white; padding: 12px 24px; border: none; border-radius: 4px; font-size: 16px; cursor: pointer; width: 100%; }
    .create-button:hover { background: #1565c0; }
    .create-button:disabled { background: #ccc; cursor: not-allowed; }
    .error { color: #d32f2f; font-size: 14px; margin-top: 10px; }
    .success { color: #388e3c; font-size: 14px; margin-top: 10px; }
    h1 { color: #333; margin-bottom: 30px; }
  </style>
</head>
<body>
  <div class="header">
    <a href="/" class="back-link">← Back to Home</a>
    <div class="user-info">
      <span class="username">${req.username}</span>
      <a href="#" class="logout-link" onclick="logout(); return false;">Logout</a>
    </div>
  </div>
  <div class="add-user-container">
    <h1>Add New User</h1>
    <form id="addUserForm">
      <div class="form-group">
        <label for="username">Username:</label>
        <input type="text" id="username" name="username" required>
      </div>
      <div class="form-group">
        <label for="password">Password:</label>
        <input type="password" id="password" name="password" required>
      </div>

      <div class="permission-section">
        <h3>User Permissions</h3>
        <div class="radio-group">
          <div class="radio-option">
            <input type="radio" id="create-user-yes" name="createUser" value="true">
            <label for="create-user-yes">Can create users</label>
          </div>
          <div class="radio-option">
            <input type="radio" id="create-user-no" name="createUser" value="false" checked>
            <label for="create-user-no">Cannot create users</label>
          </div>
        </div>
      </div>

      <div class="permission-section">
        <h3>Channel Permissions</h3>
        ${userPermissions.allowedChannels === 'all' ? `
        <div class="radio-group">
          <div class="radio-option">
            <input type="radio" id="perm-all" name="permissions" value="all" required>
            <label for="perm-all">Access to all channels</label>
          </div>
          <div class="radio-option">
            <input type="radio" id="perm-allowlist" name="permissions" value="allowlist" required>
            <label for="perm-allowlist">Access to selected channels only</label>
          </div>
        </div>

        <div class="channels-section" id="channelsSection">
          <div class="channel-controls">
            <button type="button" onclick="selectAllChannels()">Enable All</button>
            <button type="button" onclick="deselectAllChannels()">Disable All</button>
          </div>
          <div class="channels-list">
            ${availableChannels.map(channel => `
              <div class="channel-option">
                <input type="checkbox" id="channel-${channel.channel_id}" name="channels" value="${channel.channel_id}">
                <label for="channel-${channel.channel_id}">${channel.channel}</label>
              </div>
            `).join('')}
          </div>
        </div>
        ` : `
        <input type="hidden" name="permissions" value="allowlist">
        <p>Select channels to grant access to:</p>
        <div class="channels-section visible">
          <div class="channel-controls">
            <button type="button" onclick="selectAllChannels()">Enable All</button>
            <button type="button" onclick="deselectAllChannels()">Disable All</button>
          </div>
          <div class="channels-list">
            ${availableChannels.map(channel => `
              <div class="channel-option">
                <input type="checkbox" id="channel-${channel.channel_id}" name="channels" value="${channel.channel_id}">
                <label for="channel-${channel.channel_id}">${channel.channel}</label>
              </div>
            `).join('')}
          </div>
        </div>
        `}
      </div>

      <button type="submit" class="create-button" id="createButton">Create User</button>
      <div id="message"></div>
    </form>
  </div>

  <script>
    const permissionRadios = document.querySelectorAll('input[name="permissions"]');
    const channelsSection = document.getElementById('channelsSection');
    const form = document.getElementById('addUserForm');
    const button = document.getElementById('createButton');
    const message = document.getElementById('message');

    function updateChannelsVisibility() {
      if (!channelsSection) return; // it is always visible for restricted users
      const selectedPermission = document.querySelector('input[name="permissions"]:checked')?.value;
      if (selectedPermission === 'allowlist') {
        channelsSection.classList.add('visible');
      } else {
        channelsSection.classList.remove('visible');
      }
    }

    permissionRadios.forEach(radio => {
      radio.addEventListener('change', updateChannelsVisibility);
    });

    function selectAllChannels() {
      document.querySelectorAll('input[name="channels"]').forEach(checkbox => {
        checkbox.checked = true;
      });
    }

    function deselectAllChannels() {
      document.querySelectorAll('input[name="channels"]').forEach(checkbox => {
        checkbox.checked = false;
      });
    }

    function logout() {
      document.cookie = 'auth=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      window.location.href = '/login';
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const selectedPermission = document.querySelector('input[name="permissions"]:checked')?.value ||
                                document.querySelector('input[name="permissions"][type="hidden"]')?.value;
      const createUser = document.querySelector('input[name="createUser"]:checked')?.value === 'true';

      if (!selectedPermission) {
        message.textContent = 'Please select channel permissions';
        message.className = 'error';
        return;
      }

      let allowedChannels;
      if (selectedPermission === 'all') {
        allowedChannels = 'all';
      } else {
        allowedChannels = Array.from(document.querySelectorAll('input[name="channels"]:checked'))
          .map(checkbox => checkbox.value);

        if (allowedChannels.length === 0) {
          message.textContent = 'Please select at least one channel for allowlist access';
          message.className = 'error';
          return;
        }
      }

      button.disabled = true;
      button.textContent = 'Creating User...';
      message.textContent = '';
      message.className = '';

      try {
        const response = await fetch('/api/add-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            password,
            allowedChannels,
            createUser
          })
        });

        if (response.ok) {
          message.textContent = 'User created successfully!';
          message.className = 'success';
          form.reset();
          updateChannelsVisibility();
        } else {
          const error = await response.json();
          message.textContent = error.message || 'Failed to create user';
          message.className = 'error';
        }
      } catch (err) {
        message.textContent = 'Network error. Please try again.';
        message.className = 'error';
      }

      button.disabled = false;
      button.textContent = 'Create User';
    });

    // Initialize visibility
    updateChannelsVisibility();
  </script>
</body>
</html>`);
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
    // Security check: ensure no users exist
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
      createUser: true
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


app.listen(PORT, () => {
  console.log(`LocalTube server running on http://localhost:${PORT}`);
});