import type { VideoWithChannel } from './media-db.ts';
import { getChannelById } from './media-db.ts';
import { nameExt, type ChannelID } from './util.ts';

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

function renderVideoCard(video: VideoWithChannel, showChannel: boolean = true): string {
  const ext = nameExt(video.video_filename).ext;
  return `
    <div class="video-card">
      <a href="/v/${video.video_id}">
        <div class="thumb-container">
          <img class="thumb" src="/media/thumbs/${video.video_id}.${ext}" alt="${video.title}">
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

${nameExt.toString()}

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

const formPageCSS = `
  .form-container { max-width: 400px; margin: 50px auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  .form-container h1 { text-align: center; color: #333; margin-bottom: 30px; }
  .page-form { display: flex; flex-direction: column; gap: 15px; }
  .form-group { display: flex; flex-direction: column; gap: 5px; }
  label { font-weight: bold; color: #333; }
  input[type="text"], input[type="password"] { padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 16px; }
  input[type="text"]:focus, input[type="password"]:focus { outline: none; border-color: #1976d2; }
  .form-button { background: #1976d2; color: white; padding: 12px; border: none; border-radius: 4px; font-size: 16px; cursor: pointer; }
  .form-button:hover { background: #1565c0; }
  .form-button:disabled { background: #ccc; cursor: not-allowed; }
  .error { color: #d32f2f; font-size: 14px; margin-top: 10px; }
  .success { color: #388e3c; font-size: 14px; margin-top: 10px; }
  .form-info { color: #666; text-align: center; margin-bottom: 30px; font-size: 14px; line-height: 1.4; }
`;

export function renderNotAllowed(username: string): string {
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

export function renderSetupPage(): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Setup - LocalTube</title>
  <style>
    ${commonCSS}
    ${formPageCSS}
  </style>
</head>
<body>
  <div class="form-container">
    <h1>Welcome to LocalTube</h1>
    <div class="form-info">
      No users have been configured yet. Please create the first account to get started.
    </div>
    <form class="page-form" id="setupForm">
      <div class="form-group">
        <label for="username">Username:</label>
        <input type="text" id="username" name="username" required>
      </div>
      <div class="form-group">
        <label for="password">Password:</label>
        <input type="password" id="password" name="password" required>
      </div>
      <button type="submit" class="form-button" id="setupButton">Create Account</button>
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
      button.textContent = 'Create Account';
    });
  </script>
</body>
</html>`;
}

export function renderLoginPage(): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Login - LocalTube</title>
  <style>
    ${commonCSS}
    ${formPageCSS}
  </style>
</head>
<body>
  <div class="form-container">
    <h1>Login to LocalTube</h1>
    <form class="page-form" id="loginForm">
      <div class="form-group">
        <label for="username">Username:</label>
        <input type="text" id="username" name="username" required>
      </div>
      <div class="form-group">
        <label for="password">Password:</label>
        <input type="password" id="password" name="password" required>
      </div>
      <button type="submit" class="form-button" id="loginButton">Login</button>
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
        const response = await fetch('/public-api/login', {
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
</html>`;
}

export function renderHomePage(username: string, videos: VideoWithChannel[]): string {
  return `
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
      <span class="username">${username}</span>
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
</html>`;
}

export function renderVideoPage(video: any, username: string): string {
  const videoExt = nameExt(video.video_filename).ext;
  const avatarExt = video.avatar_filename == null ? null : nameExt(video.avatar_filename).ext;

  return `
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
      ${username ? `
        <div class="user-info">
          <span class="username">${username}</span>
          <a href="#" class="logout-link" onclick="logout(); return false;">Logout</a>
        </div>
      ` : ''}
    </div>
  </div>
  <div class="video-section">
    <video controls autoplay>
      <source src="/media/videos/${video.video_id}.${videoExt}" type="video/${videoExt === 'mp4' ? 'mp4' : 'webm'}">
      Your browser does not support the video tag.
    </video>
  </div>
  <div class="content-section">
    <div class="video-container">
    <div class="video-info">
      <div class="video-title">${video.title}</div>
      <div class="channel-info">
        ${video.avatar_filename ? `<img class="channel-avatar" width=40 height=40 src="/media/avatars/${video.channel_short_id}.${avatarExt}" alt="${video.channel}">` : ''}
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
</html>`;
}

export function renderChannelPage(channel: any, videos: VideoWithChannel[], username: string): string {
  const avatarExt = channel.avatar_filename == null ? null : nameExt(channel.avatar_filename).ext;

  return `
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
    ${username ? `
      <div class="user-info">
        <span class="username">${username}</span>
        <a href="#" class="logout-link" onclick="logout(); return false;">Logout</a>
      </div>
    ` : ''}
  </div>
  <div class="channel-header">
    <div class="channel-info">
      ${channel.avatar_filename ? `<img class="channel-avatar" width=80 height=80 src="/media/avatars/${channel.short_id}.${avatarExt}" alt="${channel.channel}">` : ''}
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
</html>`;
}

export function renderAddUserPage(username: string, userPermissions: any, availableChannels: any[]): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Add User - LocalTube</title>
  <style>
    ${commonCSS}
    ${formPageCSS}
    body { margin: 20px; }
    .form-container { max-width: 600px; margin: 20px auto; }
    .form-group { margin-bottom: 20px; }
    .permission-section h3 { color: #333; margin-bottom: 15px; margin-top: 0px; }
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
    .form-button { width: 100%; }
  </style>
</head>
<body>
  <div class="header">
    <a href="/" class="back-link">← Back to Home</a>
    <div class="user-info">
      <span class="username">${username}</span>
      <a href="#" class="logout-link" onclick="logout(); return false;">Logout</a>
    </div>
  </div>
  <div class="form-container">
    <h1>Add New User</h1>
    <form class="page-form" id="addUserForm">
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
        <h3>Subscription Permissions</h3>
        <div class="radio-group">
          <div class="radio-option">
            <input type="radio" id="can-subscribe-yes" name="canSubscribe" value="true" ${userPermissions.allowedChannels !== 'all' ? 'disabled' : ''}>
            <label for="can-subscribe-yes">Can manage subscriptions</label>
          </div>
          <div class="radio-option">
            <input type="radio" id="can-subscribe-no" name="canSubscribe" value="false" checked>
            <label for="can-subscribe-no">Cannot manage subscriptions</label>
          </div>
        </div>
        ${userPermissions.allowedChannels !== 'all' ? `
          <p style="color: #666; font-size: 14px; margin-top: 10px;">Subscription management is only available for users with access to all channels.</p>
        ` : ''}
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

      <button type="submit" class="form-button" id="createButton">Create User</button>
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
      const canSubscribe = document.querySelector('input[name="canSubscribe"]:checked')?.value === 'true';

      if (!selectedPermission) {
        message.textContent = 'Please select channel permissions';
        message.className = 'error';
        return;
      }

      if (canSubscribe && selectedPermission !== 'all') {
        message.textContent = 'Subscription management is only available for users with access to all channels';
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
            createUser,
            canSubscribe
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
</html>`;
}

export function renderSubscriptionsPage(username: string, subscriptionsData: { subscribing?: string[], subscribed?: string[] }, allowedChannels: Set<ChannelID> | 'all', canSubscribe: boolean): string {
  const subscribing = subscriptionsData.subscribing || [];
  const subscribed = subscriptionsData.subscribed || [];

  const allChannelIds = [...subscribing, ...subscribed];
  const channelInfos = [];

  for (const channelId of allChannelIds) {
    if (allowedChannels !== 'all' && !allowedChannels.has(channelId as ChannelID)) {
      continue;
    }

    const channel = getChannelById(channelId as ChannelID);
    if (channel) {
      const avatarExt = channel.avatar_filename ? nameExt(channel.avatar_filename).ext : null;
      channelInfos.push({
        ...channel,
        status: subscribing.includes(channelId) ? 'subscribing' : 'subscribed',
        avatarExt
      });
    }
  }

  channelInfos.sort((a, b) => a.channel.localeCompare(b.channel));

  return `
<!DOCTYPE html>
<html>
<head>
  <title>Subscriptions - LocalTube</title>
  <style>
    ${commonCSS}
    body { margin: 20px; }
    h1 { color: #333; margin: 0px; }
    .subscriptions-container { margin-top: 20px; }
    .channel-list { display: flex; flex-direction: column; gap: 15px; }
    .channel-item { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); display: flex; align-items: center; gap: 15px; }
    .channel-avatar { width: 60px; height: 60px; border-radius: 50%; }
    .channel-details { flex: 1; }
    .channel-name { font-weight: bold; font-size: 16px; margin-bottom: 5px; }
    .channel-status { font-size: 14px; padding: 4px 8px; border-radius: 4px; }
    .status-subscribing { background: #fff3cd; color: #856404; }
    .status-subscribed { background: #d4edda; color: #155724; }
    .channel-id { font-size: 12px; color: #666; margin-top: 5px; }
    .no-channels { text-align: center; color: #666; padding: 40px; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .add-subscription-form { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .add-subscription-form h2 { margin: 0 0 15px 0; color: #333; }
    .form-row { display: flex; gap: 10px; align-items: flex-end; }
    .form-group { flex: 1; }
    .form-group label { display: block; margin-bottom: 5px; font-weight: bold; color: #333; }
    .form-group input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 16px; box-sizing: border-box; }
    .add-button { background: #1976d2; color: white; padding: 10px 20px; border: none; border-radius: 4px; font-size: 16px; cursor: pointer; white-space: nowrap; }
    .add-button:hover { background: #1565c0; }
    .add-button:disabled { background: #ccc; cursor: not-allowed; }
    .message { margin-top: 10px; font-size: 14px; }
    .error { color: #d32f2f; }
    .success { color: #388e3c; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Subscriptions</h1>
    <a href="/" class="back-link">← Back to Home</a>
    <div class="user-info">
      <span class="username">${username}</span>
      <a href="#" class="logout-link" onclick="logout(); return false;">Logout</a>
    </div>
  </div>
  ${canSubscribe ? `
    <div class="add-subscription-form">
      <h2>Add New Subscription</h2>
      <form id="addSubscriptionForm">
        <div class="form-row">
          <div class="form-group">
            <label for="channelId">Channel URL, Handle, or ID:</label>
            <input type="text" id="channelId" name="channelId" placeholder="e.g. @username, UCxxxxx, or https://youtube.com/..." required>
          </div>
          <button type="submit" class="add-button" id="addButton">Add Subscription</button>
        </div>
        <div id="addMessage" class="message"></div>
      </form>
    </div>
  ` : ''}
  <div class="subscriptions-container">
    ${channelInfos.length === 0 ? `
      <div class="no-channels">No subscriptions found</div>
    ` : `
      <div class="channel-list">
        ${channelInfos.map(channel => `
          <div class="channel-item">
            ${channel.avatar_filename ? `
              <img class="channel-avatar" src="/media/avatars/${channel.short_id}.${channel.avatarExt}" alt="${channel.channel}">
            ` : `
              <div class="channel-avatar" style="background: #ddd;"></div>
            `}
            <div class="channel-details">
              <div class="channel-name">
                <a href="/c/${channel.short_id}" class="channel-name">${channel.channel}</a>
              </div>
              <span class="channel-status ${channel.status === 'subscribing' ? 'status-subscribing' : 'status-subscribed'}">
                ${channel.status}
              </span>
              <div class="channel-id">${channel.channel_id}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `}
  </div>
  <script>
    function logout() {
      document.cookie = 'auth=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      window.location.href = '/login';
    }

    ${canSubscribe ? `
      const addForm = document.getElementById('addSubscriptionForm');
      const addButton = document.getElementById('addButton');
      const addMessage = document.getElementById('addMessage');

      addForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const channelId = document.getElementById('channelId').value.trim();
        if (!channelId) {
          addMessage.textContent = 'Please enter a channel ID';
          addMessage.className = 'message error';
          return;
        }

        addButton.disabled = true;
        addButton.textContent = 'Adding...';
        addMessage.textContent = '';
        addMessage.className = 'message';

        try {
          const response = await fetch('/api/add-subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId })
          });

          if (response.ok) {
            addMessage.textContent = 'Subscription added successfully! Refreshing page...';
            addMessage.className = 'message success';
            document.getElementById('channelId').value = '';
            setTimeout(() => { window.location.reload(); }, 1500);
          } else {
            const error = await response.json();
            addMessage.textContent = error.message || 'Failed to add subscription';
            addMessage.className = 'message error';
          }
        } catch (err) {
          addMessage.textContent = \`Network error: \${err.message}. Please try again.\`;
          addMessage.className = 'message error';
        }

        addButton.disabled = false;
        addButton.textContent = 'Add Subscription';
      });
    ` : ''}
  </script>
</body>
</html>`;
}