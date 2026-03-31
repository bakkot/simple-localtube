import fs from 'node:fs';
import path from 'node:path';
import type { VideoWithChannel } from './media-db.ts';
import { getChannelById } from './media-db.ts';
import type { Permissions } from './user-db.ts';
import { nameExt, type ChannelID, type SubscriptionFile } from './util.ts';
import { parse as parseTemplate, apply as applyTemplate } from './frontend/tinymarker.ts';

const templates = path.join(import.meta.dirname, 'frontend');

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
  .topright-info { position: absolute; top: 0; right: 0; display: flex; align-items: center; gap: 10px; font-size: 16px; }
  .settings { display: inline-flex; position: relative; cursor: pointer; }
  .settings-dropdown { display: none; position: absolute; top: 100%; right: 0; background: white; border: 1px solid #ddd; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); min-width: 150px; z-index: 100; }
  .settings-dropdown::before { content: ''; position: absolute; bottom: 100%; right: 0; width: 150%; height: 16px; }
  .settings:hover:not(.no-hover) .settings-dropdown, .settings.open .settings-dropdown { display: block; }
  .settings-dropdown a { display: block; padding: 8px 16px; color: #333; text-decoration: none; white-space: nowrap; }
  .settings-dropdown a:hover { background: #f0f0f0; }
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

function renderTopRightBlock(username: string, permissions: Permissions) {
  // look, nothing stops you from putting scripts in the middle of presentation elements
  // it's fine
  return `
    <div class="topright-info">
      <span class="settings">
        <!-- icons from Feather: https://github.com/feathericons/feather/blob/593b3bf516087d07d362280b34ec1a5383e71572/LICENSE -->
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-settings"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        <div class="settings-dropdown">
          <a href="/settings">Settings</a>
          <a href="/subscriptions">Subscriptions</a>
          ${permissions.createUser ? '<a href="/add-user">Add User</a>' : ''}
        </div>
      </span>
      <span class="username">${username}</span>
      <a href="#" class="logout-link" onclick="logout(); return false;">Logout</a>
    </div>
    <script>
      function logout() {
        document.cookie = 'auth=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        window.location.href = '/login';
      }

      const settingsBtn = document.querySelector('.settings');
      settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (settingsBtn.classList.contains('open')) {
          settingsBtn.classList.remove('open');
          settingsBtn.classList.add('no-hover');
          settingsBtn.addEventListener('mouseleave', () => {
            settingsBtn.classList.remove('no-hover');
          }, { once: true });
        } else {
          settingsBtn.classList.add('open');
        }
      });
      document.addEventListener('click', () => {
        settingsBtn.classList.remove('open');
      });
    </script>`;
}

const notAllowedTemplate = fs.readFileSync(path.join(templates, 'not-allowed.html'), 'utf8');
export function renderNotAllowed(username: string, permissions: Permissions): string {
  return notAllowedTemplate
    .replace('__COMMON_CSS__', commonCSS)
    .replace('__TOP_RIGHT_BLOCK__', renderTopRightBlock(username, permissions))
}

const setupTemplate = fs.readFileSync(path.join(templates, 'setup.html'), 'utf8');
export function renderSetupPage(): string {
  return setupTemplate
    .replace('__COMMON_CSS__', commonCSS)
    .replace('__FORM_PAGE_CSS__', formPageCSS);
}

const loginTemplate = fs.readFileSync(path.join(templates, 'login.html'), 'utf8');
export function renderLoginPage(): string {
  return loginTemplate
    .replace('__COMMON_CSS__', commonCSS)
    .replace('__FORM_PAGE_CSS__', formPageCSS);
}

const homeTemplate = fs.readFileSync(path.join(templates, 'home.html'), 'utf8');
export function renderHomePage(username: string, permissions: Permissions, videos: VideoWithChannel[]): string {
  return homeTemplate
    .replace('__COMMON_CSS__', commonCSS)
    .replace('__TOP_RIGHT_BLOCK__', renderTopRightBlock(username, permissions))
    .replace('__VIDEOS__', videos.map(video => renderVideoCard(video, true)).join(''))
    .replace('__VIDEO_CARD_SCRIPT__', videoCardScript);
}

const videoTemplate = fs.readFileSync(path.join(templates, 'video.html'), 'utf8');
export function renderVideoPage(video: VideoWithChannel, username: string, permissions: Permissions): string {
  const videoExt = nameExt(video.video_filename).ext;
  const avatarExt = video.avatar_filename == null ? null : nameExt(video.avatar_filename).ext;

  return videoTemplate
    .replace('__COMMON_CSS__', commonCSS)
    .replace('__TOP_RIGHT_BLOCK__', renderTopRightBlock(username, permissions))
    .replaceAll('__VIDEO__TITLE__', video.title)
    .replace('__VIDEO__DESCRIPTION__', video.description)
    .replace('__VIDEO_ID__', video.video_id)
    .replace('__VIDEO_ELEMENT__', `
      <video controls autoplay>
        <source src="/media/videos/${video.video_id}.${videoExt}" type="video/${videoExt === 'mp4' ? 'mp4' : 'webm'}">
        ${Object.entries(video.subtitles).map(([lang, _]) =>
          `<track kind="subtitles" src="/media/subtitles/${video.video_id}/${lang}" srclang="${lang}" label="${lang}">`
        ).join('\n      ')}
      </video>`)
    .replace('__CHANNEL_INFO__', `
      <div class="channel-info">
        ${video.avatar_filename ? `<img class="channel-avatar" width=40 height=40 src="/media/avatars/${video.channel_short_id}.${avatarExt}" alt="${video.channel}">` : ''}
        <a href="/c/${video.channel_short_id}" class="channel-name">${video.channel}</a>
      </div>`)
}

const channelTemplate = fs.readFileSync(path.join(templates, 'channel.html'), 'utf8');
export function renderChannelPage(channel: any, videos: VideoWithChannel[], username: string, permissions: Permissions): string {
  const avatarExt = channel.avatar_filename == null ? null : nameExt(channel.avatar_filename).ext;

  return channelTemplate
    .replace('__COMMON_CSS__', commonCSS)
    .replace('__TOP_RIGHT_BLOCK__', renderTopRightBlock(username, permissions))
    .replace('__CHANNEL_INFO__', `
      <div class="channel-info">
        ${channel.avatar_filename ? `<img class="channel-avatar" width=80 height=80 src="/media/avatars/${channel.short_id}.${avatarExt}" alt="${channel.channel}">` : ''}
        <div class="channel-details">
          <h1>${channel.channel}</h1>
          ${channel.description ? `<div class="channel-description">${channel.description}</div>` : ''}
        </div>
      </div>`)
    .replace('__VIDEOS__', videos.map(video => renderVideoCard(video, false)).join(''))
    .replace('__VIDEO_CARD_SCRIPT__', videoCardScript)
    .replace('__SHORT_ID__', channel.short_id)
    .replace('__TITLE__', channel.channel);
}

const addUserTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'add-user.html'), 'utf8'));
export function renderAddUserPage(username: string, permissions: Permissions, availableChannels: { channel_id: ChannelID; channel: string }[]): string {
  return applyTemplate(addUserTemplate, {
    commonCSS,
    formPageCSS,
    topRightBlock: renderTopRightBlock(username, permissions),
    hasAllChannelsPermission: permissions.allowedChannels === 'all',
    availableChannels,
  });
}

const settingsTemplate = fs.readFileSync(path.join(templates, 'settings.html'), 'utf8');
export function renderSettingsPage(username: string, permissions: Permissions): string {
  return settingsTemplate
    .replace('__COMMON_CSS__', commonCSS)
    .replace('__FORM_PAGE_CSS__', formPageCSS)
    .replace('__TOP_RIGHT_BLOCK__', renderTopRightBlock(username, permissions))
}

// const subscriptionsTemplate = fs.readFileSync(path.join(templates, 'subscriptions.html'), 'utf8');
export function renderSubscriptionsPage(username: string, permissions: Permissions, subscriptionsData: SubscriptionFile): string {
  const subscribing = subscriptionsData.subscribing;
  const subscribed = subscriptionsData.subscribed;
  const titles = subscriptionsData.titles;

  const allChannelIds = [...subscribing, ...subscribed];
  const channelInfos = [];

  for (const channelId of allChannelIds) {
    if (permissions.allowedChannels !== 'all' && !permissions.allowedChannels.has(channelId)) {
      continue;
    }

    const channel = getChannelById(channelId);
    if (channel) {
      const avatarExt = channel.avatar_filename ? nameExt(channel.avatar_filename).ext : null;
      channelInfos.push({
        ...channel,
        status: subscribing.includes(channelId) ? 'subscribing' : 'subscribed',
        avatarExt
      });
    } else {
      // Channel not in media DB, use stored title
      const storedTitle = titles[channelId] || 'Unknown Channel';
      channelInfos.push({
        channel_id: channelId,
        channel: storedTitle,
        short_id: null, // No short_id available
        description: null,
        avatar_filename: null,
        banner_filename: null,
        banner_uncropped_filename: null,
        status: subscribing.includes(channelId) ? 'subscribing' : 'subscribed',
        avatarExt: null
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
    ${formPageCSS}
    body { margin: 20px; }
    .form-container { max-width: 600px; margin: 20px auto; }
    .channel-list { display: flex; flex-direction: column; gap: 15px; }
    .channel-item { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); display: flex; align-items: center; gap: 15px; }
    .channel-avatar { width: 60px; height: 60px; border-radius: 50%; }
    .channel-details { display: flex; flex-direction: column; gap: 3px; flex: 1; }
    .channel-status { font-size: 14px; padding: 4px 8px; border-radius: 4px; }
    .status-subscribing { background: #fff3cd; color: #856404; }
    .status-subscribed { background: #d4edda; color: #155724; }
    .channel-id { font-size: 12px; color: #666; margin-top: 5px; }
    .unsubscribe-btn { background: #d32f2f; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    .unsubscribe-btn:hover { background: #b71c1c; }
    .unsubscribe-btn:disabled { background: #ccc; cursor: not-allowed; }
    .no-channels { text-align: center; color: #666; padding: 40px; }
    .form-row { display: flex; gap: 10px; align-items: flex-end; width: 100%; }
    .form-group { flex: 1; }
    .form-group input { width: 100%; box-sizing: border-box; }
    .add-button { background: #1976d2; color: white; padding: 10px 20px; border: none; border-radius: 4px; font-size: 16px; cursor: pointer; white-space: nowrap; }
    .add-button:hover { background: #1565c0; }
    .add-button:disabled { background: #ccc; cursor: not-allowed; }
    .message { margin-top: 10px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="header">
    <a href="/" class="back-link">← Back to Home</a>
    ${renderTopRightBlock(username, permissions)}
  </div>
  <div class="form-container">
    <h1>Subscriptions</h1>
    ${permissions.canSubscribe ? `
      <form id="addSubscriptionForm" class="page-form">
        <div class="form-row">
          <div class="form-group">
            <label for="channelId">Handle, ID, or channel URL:</label>
            <input type="text" id="channelId" name="channelId" placeholder="e.g. @username, UCxxxxx, or https://youtube.com/..." required>
          </div>
          <button type="submit" class="add-button" id="addButton">Add</button>
        </div>
        <div id="addMessage" class="message"></div>
      </form>
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
              <div>
                ${channel.short_id ? `
                  <a href="/c/${channel.short_id}" class="channel-name">${channel.channel}</a>
                ` : `
                  <span>${channel.channel}</span>
                `}
              </div>
              <div>
                <span class="channel-status ${channel.status === 'subscribing' ? 'status-subscribing' : 'status-subscribed'}">
                  ${channel.status}
                </span>
              </div>
              <div class="channel-id">${channel.channel_id}</div>
            </div>
            ${permissions.canSubscribe ? `
              <button class="unsubscribe-btn" onclick="unsubscribe('${channel.channel_id}', '${channel.channel.replace(/'/g, "\\'")}', event)">
                Unsubscribe
              </button>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `}
  </div>
  </div>
  <script>
    ${permissions.canSubscribe ? `
      async function unsubscribe(channelId, channelName, event) {
        const shiftPressed = event.shiftKey;

        if (!shiftPressed) {
          const confirmed = confirm(\`Are you sure you want to unsubscribe from "\${channelName}"?\\n\\nTip: Hold Shift while clicking to bypass this confirmation.\`);
          if (!confirmed) {
            return;
          }
        }

        const button = event.target;
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Unsubscribing...';

        try {
          const response = await fetch('/api/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId })
          });

          if (response.ok) {
            window.location.reload();
          } else {
            const error = await response.json();
            alert('Failed to unsubscribe: ' + (error.message || 'Unknown error'));
            button.disabled = false;
            button.textContent = originalText;
          }
        } catch (err) {
          alert('Network error: ' + err.message);
          button.disabled = false;
          button.textContent = originalText;
        }
      }

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
            setTimeout(() => { window.location.reload(); }, 500);
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