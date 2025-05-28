import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { parseArgs } from 'util';
import { getRecentVideos, getVideoById, getChannelByShortId, getVideosByChannel } from './db-manager.ts';
import { nameExt, type VideoID } from './util.ts';
import { checkUsernamePassword, decodeBearerToken } from './user-db.ts';

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
app.use('/', (req: Request, res: Response, next: NextFunction): void => {
  // Skip login routes
  if (req.path === '/login' || req.path === '/api/login') {
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
  body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
  .header { position: relative; }
  .user-info { position: absolute; top: 0; right: 0; display: flex; align-items: center; gap: 10px; font-size: 14px; }
  .username { color: #333; font-weight: bold; }
  .logout-link { color: #1976d2; text-decoration: none; cursor: pointer; }
  .logout-link:hover { text-decoration: underline; }
  .video-grid { display: grid; grid-template-columns: repeat(auto-fit, 320px); gap: 20px; justify-content: center; }
  .video-card { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  .video-card:hover { box-shadow: 0 4px 8px rgba(0,0,0,0.15); }
  .thumb-container { position: relative; height: 180px; }
  .thumb { width: 100%; height: 100%; object-fit: cover; object-position: center; }
  .duration { position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.8); color: white; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  .video-info { padding: 12px; }
  .video-title { font-weight: bold; color: #333; text-decoration: none; }
  .video-title:hover { color: #1976d2; }
  .channel-name { color: #666; font-size: 14px; text-decoration: none; }
  .channel-name:hover { color: #1976d2; }
  .upload-date { color: #999; font-size: 12px; margin-top: 4px; }
  a { text-decoration: none; }
  .loading { text-align: center; padding: 30px 20px; color: #666; }
`;

function renderVideoGrid(videos: any[], title: string = 'Recent Videos', username?: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <style>
    ${commonCSS}
    h1 { color: #333; }
    .video-grid { margin-top: 20px; }
    .video-title { margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${title}</h1>
    ${username ? `
      <div class="user-info">
        <span class="username">${username}</span>
        <a href="#" class="logout-link" onclick="logout(); return false;">Logout</a>
      </div>
    ` : ''}
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
</html>`;
}

app.get('/login', (req: Request, res: Response): void => {
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

// API endpoints
app.get('/api/videos', (req: Request, res: Response): void => {
  const offset = parseInt(req.query.offset as string) || 0;
  const limit = parseInt(req.query.limit as string) || 30;
  const videos = getRecentVideos(limit, offset);
  res.json(videos);
});

app.get('/api/channel/:short_id/videos', (req: Request, res: Response): void => {
  const channel = getChannelByShortId(req.params.short_id);
  if (!channel) {
    res.status(404).json({ error: 'Channel not found' });
    return;
  }

  const offset = parseInt(req.query.offset as string) || 0;
  const limit = parseInt(req.query.limit as string) || 30;
  const videos = getVideosByChannel(channel.channel_id, limit, offset);
  res.json(videos);
});

// Homepage
app.get('/', (req, res) => {
  const videos = getRecentVideos(30);
  res.send(renderVideoGrid(videos, 'LocalTube', req.username));
});

// Video player page
app.get('/v/:video_id', (req: Request, res: Response): void => {
  const video = getVideoById(req.params.video_id as VideoID);
  if (!video) {
    res.status(404).send('Video not found');
    return;
  }

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>${video.title}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #000; }
    .video-section { background: #000; width: 100%; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
    video { max-width: 100%; max-height: 80vh; height: auto; width: auto; }
    .content-section { background: #f5f5f5; padding: 20px; }
    .header { position: relative; }
    .user-info { position: absolute; top: 0; right: 0; display: flex; align-items: center; gap: 10px; font-size: 14px; }
    .username { color: #333; font-weight: bold; }
    .logout-link { color: #1976d2; text-decoration: none; cursor: pointer; }
    .logout-link:hover { text-decoration: underline; }
    .video-container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .video-info { margin-top: 15px; }
    .video-title { font-size: 24px; font-weight: bold; margin-bottom: 10px; color: #333; }
    .channel-info { display: flex; align-items: center; margin-bottom: 15px; }
    .channel-avatar { width: 40px; height: 40px; border-radius: 50%; margin-right: 10px; }
    .channel-name { color: #1976d2; text-decoration: none; font-weight: bold; }
    .channel-name:hover { text-decoration: underline; }
    .description { color: #666; line-height: 1.5; white-space: pre-wrap; }
    .back-link { display: inline-block; color: #1976d2; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
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
        ${video.avatar_filename ? `<img class="channel-avatar" src="/media/${video.channel_id}/${video.avatar_filename}" alt="${video.channel}">` : ''}
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

  const videos = getVideosByChannel(channel.channel_id, 30);

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>${channel.channel}</title>
  <style>
    ${commonCSS}
    .channel-header { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .channel-info { display: flex; align-items: center; }
    .channel-avatar { width: 80px; height: 80px; border-radius: 50%; margin-right: 20px; }
    .channel-details h1 { margin: 0 0 10px 0; color: #333; }
    .channel-description { color: #666; line-height: 1.5; white-space: pre-wrap; }
    .back-link { display: inline-block; color: #1976d2; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
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
  <div class="channel-header">
    <div class="channel-info">
      ${channel.avatar_filename ? `<img class="channel-avatar" src="/media/${channel.channel_id}/${channel.avatar_filename}" alt="${channel.channel}">` : ''}
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

app.listen(PORT, () => {
  console.log(`LocalTube server running on http://localhost:${PORT}`);
});