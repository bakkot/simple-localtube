import fs from 'node:fs';
import path from 'node:path';
import type { Channel, VideoWithChannel } from './media-db.ts';
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
        ${showChannel ? `<div><a href="/c/${video.channel_short_id}" class="channel-name">${video.channel_title}</a></div>` : ''}
        <div class="upload-date">${formatDate(video.upload_timestamp)}</div>
      </div>
    </div>`;
}

const videoCardScript = `
"use strict";

${formatDuration.toString()}

${formatDate.toString()}

${renderVideoCard.toString()}

${nameExt.toString()}

function createInfiniteScroll(apiUrl, showChannel) {
  let offset = document.getElementById('video-grid').children.length;
  let state = 'idle'; // idle | loading | exhausted | errored
  const loadingEle = document.getElementById('loading');

  async function loadMoreVideos() {
    if (state !== 'idle') return;
    state = 'loading';
    loadingEle.style.display = 'block';

    try {
      const response = await fetch(apiUrl + '?offset=' + offset + '&limit=30');
      const videos = await response.json();

      if (videos.length === 0) {
        state = 'exhausted';
        loadingEle.textContent = 'No more videos';
        return;
      }

      const grid = document.getElementById('video-grid');
      videos.forEach(video => {
        grid.insertAdjacentHTML('beforeend', renderVideoCard(video, showChannel));
      });

      offset += videos.length;
      if (videos.length < 30) {
        state = 'exhausted';
        loadingEle.textContent = 'No more videos';
        return;
      }
    } catch (error) {
      console.error('Error loading videos:', error);
      state = 'errored';
      loadingEle.textContent = 'Error loading videos';
    } finally {
      if (state !== 'errored') loadingEle.style.display = 'none';
      if (state === 'exhausted') return;
      setTimeout(() => { state = 'idle'; }, 1000);
    }
  }

  window.addEventListener('scroll', () => {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 200) {
      loadMoreVideos();
    }
  });
}
`;

function formatLastUpdated(timestamp: number | null): string {
  if (timestamp == null) return '';
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const msPerDay = 86400000;
  if (now.getTime() - date.getTime() > msPerDay) {
    return date.toLocaleDateString();
  }
  return date.toLocaleString();
}

function renderChannelCard(channel: Channel): string {
  const avatarExt = channel.avatar_filename == null ? null : nameExt(channel.avatar_filename).ext;
  const avatar = avatarExt
    ? `<img class="channel-card-avatar" width=64 height=64 src="/media/avatars/${channel.short_id}.${avatarExt}" alt="${channel.channel_title}">`
    : `<div class="channel-card-placeholder">${channel.channel_title[0] || '?'}</div>`;
  const updated = channel.latest_upload_timestamp ? ` · ${formatLastUpdated(channel.latest_upload_timestamp)}` : '';
  return `
    <a href="/c/${channel.short_id}" class="channel-card">
      ${avatar}
      <div class="channel-card-info">
        <div class="channel-card-title">${channel.channel_title}</div>
        <div class="channel-card-meta">${channel.video_count} video${channel.video_count === 1 ? '' : 's'}${updated}</div>
      </div>
    </a>`;
}

const channelCardScript = `
"use strict";

${nameExt.toString()}

${formatLastUpdated.toString()}

${renderChannelCard.toString()}

{
  const grid = document.getElementById('channels-grid');
  const loadingEle = document.getElementById('loading');
  let sort = 'recent';
  let offset = grid.children.length;
  let state = 'idle';

  async function loadMore() {
    if (state !== 'idle') return;
    state = 'loading';
    loadingEle.style.display = 'block';

    try {
      const response = await fetch('/api/channels?sort=' + sort + '&offset=' + offset + '&limit=30');
      const channels = await response.json();

      if (channels.length === 0) {
        state = 'exhausted';
        loadingEle.textContent = 'No more channels';
        return;
      }

      channels.forEach(channel => {
        grid.insertAdjacentHTML('beforeend', renderChannelCard(channel));
      });

      offset += channels.length;
      if (channels.length < 30) {
        state = 'exhausted';
        loadingEle.textContent = 'No more channels';
        return;
      }
    } catch (error) {
      console.error('Error loading channels:', error);
      state = 'errored';
      loadingEle.textContent = 'Error loading channels';
    } finally {
      if (state !== 'errored') loadingEle.style.display = 'none';
      if (state === 'exhausted') return;
      setTimeout(() => { state = 'idle'; }, 1000);
    }
  }

  window.addEventListener('scroll', () => {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 200) {
      loadMore();
    }
  });

  document.getElementById('sort-select').addEventListener('change', async function() {
    sort = this.value;
    offset = 0;
    state = 'idle';
    grid.innerHTML = '';
    loadingEle.style.display = 'none';
    loadingEle.textContent = 'Loading more channels...';

    const response = await fetch('/api/channels?sort=' + sort + '&offset=0&limit=30');
    const channels = await response.json();
    channels.forEach(channel => {
      grid.insertAdjacentHTML('beforeend', renderChannelCard(channel));
    });
    offset = channels.length;
    if (channels.length < 30) {
      state = 'exhausted';
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

// TODO fix styling to use form page CSS
const notAllowedTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'not-allowed.html'), 'utf8'));
export function renderNotAllowed(username: string, permissions: Permissions): string {
  return applyTemplate(notAllowedTemplate, {
    commonCSS,
    topRightBlock: renderTopRightBlock(username, permissions),
  });
}

const setupTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'setup.html'), 'utf8'));
export function renderSetupPage(): string {
  return applyTemplate(setupTemplate, {
    commonCSS,
    formPageCSS,
  });
}

const loginTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'login.html'), 'utf8'));
export function renderLoginPage(): string {
  return applyTemplate(loginTemplate, {
    commonCSS,
    formPageCSS,
  });
}

const homeTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'home.html'), 'utf8'));
export function renderHomePage(username: string, permissions: Permissions, videos: VideoWithChannel[]): string {
  return applyTemplate(homeTemplate, {
    commonCSS,
    topRightBlock: renderTopRightBlock(username, permissions),
    videos: videos.map(video => ({ html: renderVideoCard(video, true) })),
    noVideos: videos.length === 0,
    videoCardScript,
  });
}

const channelsTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'channels.html'), 'utf8'));
export function renderChannelsPage(username: string, permissions: Permissions, channels: Channel[]): string {
  return applyTemplate(channelsTemplate, {
    commonCSS,
    topRightBlock: renderTopRightBlock(username, permissions),
    channels: channels.map(channel => ({ html: renderChannelCard(channel) })),
    noChannels: channels.length === 0,
    channelCardScript,
  });
}

const videoTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'video.html'), 'utf8'));
export function renderVideoPage(video: VideoWithChannel, username: string, permissions: Permissions): string {
  const videoExt = nameExt(video.video_filename).ext;
  const avatarExt = video.avatar_filename == null ? null : nameExt(video.avatar_filename).ext;

  return applyTemplate(videoTemplate, {
    commonCSS,
    topRightBlock: renderTopRightBlock(username, permissions),
    videoTitle: video.title,
    videoDescription: video.description,
    videoId: video.video_id,
    hasAvatar: video.avatar_filename != null,
    videoExt,
    avatarExt,
    channelShortId: video.channel_short_id,
    channel: video.channel_title,
    subtitles: Object.keys(video.subtitles).map(k => ({ lang: k }))
  });
}

const channelTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'channel.html'), 'utf8'));
export function renderChannelPage(channel: Channel, videos: VideoWithChannel[], username: string, permissions: Permissions): string {
  const avatarExt = channel.avatar_filename == null ? null : nameExt(channel.avatar_filename).ext;

  // TODO figure out why short_id is nullable and what to do about it
  // probably we should not be using short_id in the API anyway
  return applyTemplate(channelTemplate, {
    commonCSS,
    topRightBlock: renderTopRightBlock(username, permissions),
    videoCardScript,
    videos: videos.map(video => ({ html: renderVideoCard(video, false) })),
    hasAvatar: channel.avatar_filename != null,
    shortId: channel.short_id,
    channelTitle: channel.channel_title,
    avatarExt,
    hasDescription: channel.description == null,
    description: channel.description,
  });
}

const addUserTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'add-user.html'), 'utf8'));
export function renderAddUserPage(username: string, permissions: Permissions, availableChannels: { channel_id: ChannelID; channel_title: string }[]): string {
  return applyTemplate(addUserTemplate, {
    commonCSS,
    formPageCSS,
    topRightBlock: renderTopRightBlock(username, permissions),
    hasAllChannelsPermission: permissions.allowedChannels === 'all',
    availableChannels,
  });
}

const settingsTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'settings.html'), 'utf8'));
export function renderSettingsPage(username: string, permissions: Permissions): string {
  return applyTemplate(settingsTemplate, {
    commonCSS,
    formPageCSS,
    topRightBlock: renderTopRightBlock(username, permissions),
  });
}

const subscriptionsTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'subscriptions.html'), 'utf8'));
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
        channel_title: storedTitle,
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

  channelInfos.sort((a, b) => a.channel_title.localeCompare(b.channel_title));

  return applyTemplate(subscriptionsTemplate, {
    commonCSS,
    formPageCSS,
    topRightBlock: renderTopRightBlock(username, permissions),
    canSubscribe: permissions.canSubscribe,
    channelInfosIsEmpty: channelInfos.length === 0,
    channels: channelInfos.map(c => ({
      title: c.channel_title,
      id: c.channel_id,
      escapedTitle: JSON.stringify(c.channel_title),
      shortId: c.short_id,
      hasAvatar: c.avatar_filename != null,
      avatarExt: c.avatarExt,
      status: c.status,
    })),
  });
}