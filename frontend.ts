import fs from 'node:fs';
import path from 'node:path';
import type { Channel, VideoWithChannel, SearchResults } from './media-db.ts';
import { getChannelById } from './media-db.ts';
import type { Permissions } from './user-db.ts';
import { nameExt, type ChannelID } from './util.ts';
import type { SubscriptionData } from './subscriptions-db.ts';
import { subscriptionsDb } from './server.ts';
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
  const thumbExt = video.thumb_filename ? nameExt(video.thumb_filename).ext : 'png';
  // TODO fallback for missing thumbnails
  return `
    <div class="video-card">
      <a href="/v/${video.video_id}">
        <div class="thumb-container">
          <img class="thumb" src="/media/thumbs/${video.video_id}.${thumbExt}" alt="${video.title}">
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
      if (state === 'loading') {
        loadingEle.style.display = 'none';
        setTimeout(function() { state = 'idle'; }, 100);
      } else {
        setTimeout(function() { state = 'idle'; }, 1000);
      }
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
  .search-bar { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }
  .search-bar form { display: flex; gap: 0; }
  .search-bar input[type="text"] { padding: 6px 12px; border: 1px solid #ddd; border-radius: 4px 0 0 4px; font-size: 14px; width: 280px; }
  .search-bar input[type="text"]:focus { outline: none; border-color: #1976d2; }
  .search-bar button { padding: 6px 14px; background: #1976d2; color: white; border: 1px solid #1976d2; border-radius: 0 4px 4px 0; font-size: 14px; cursor: pointer; }
  .search-bar button:hover { background: #1565c0; }
  .search-bar button + button { border-radius: 4px; margin-left: 6px; }
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
          ${subscriptionsDb ? '<a href="/subscriptions">Subscriptions</a><a href="/video-queue">Video Queue</a>' : ''}
          ${permissions.createUser ? '<a href="/add-user">Add User</a><a href="/manage-users">Manage Users</a>' : ''}
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

function renderSearchBar(query: string = '', channelId?: ChannelID, channelTitle?: string) {
  const escaped = query.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const channelInput = channelId ? `<input type="hidden" name="channel" value="${channelId}">` : '';
  const buttonText = channelId
    ? (channelTitle ? `Search ${channelTitle}` : 'Search this channel')
    : 'Search';
  const placeholder = channelId ? 'Search this channel...' : 'Search...';
  const everywhereBtn = channelTitle
    ? `<button type="submit" formaction="/search" onclick="this.form.querySelector('[name=channel]').disabled=true">Search everywhere</button>`
    : '';
  return `
    <div class="search-bar">
      <form action="/search" method="get">
        ${channelInput}
        <input type="text" name="q" placeholder="${placeholder}" value="${escaped}">
        <button type="submit">${buttonText}</button>
        ${everywhereBtn}
      </form>
    </div>`;
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
    searchBar: renderSearchBar(),
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
    subtitles: Object.keys(video.subtitles_files).map(k => ({ lang: k }))
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
    searchBar: renderSearchBar('', channel.channel_id),
    videoCardScript,
    videos: videos.map(video => ({ html: renderVideoCard(video, false) })),
    hasAvatar: channel.avatar_filename != null,
    shortId: channel.short_id,
    channelTitle: channel.channel_title,
    avatarExt,
    hasDescription: channel.description != null,
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

const manageUsersTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'manage-users.html'), 'utf8'));
export function renderManageUsersPage(
  username: string,
  permissions: Permissions,
  availableChannels: { channel_id: ChannelID; channel_title: string }[],
  createdUsers: { username: string; permissions: Permissions }[],
): string {
  return applyTemplate(manageUsersTemplate, {
    commonCSS,
    formPageCSS,
    topRightBlock: renderTopRightBlock(username, permissions),
    hasAllChannelsPermission: permissions.allowedChannels === 'all',
    availableChannels,
    noCreatedUsers: createdUsers.length === 0,
    createdUsers: createdUsers.map(u => ({
      username: u.username,
      permissionsJSON: JSON.stringify({
        allowedChannels: u.permissions.allowedChannels === 'all' ? 'all' : [...u.permissions.allowedChannels],
        createUser: u.permissions.createUser,
        canSubscribe: u.permissions.canSubscribe,
      }).replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
    })),
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
export function renderSubscriptionsPage(username: string, permissions: Permissions, subscriptionsData: SubscriptionData): string {
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

const videoQueueTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'video-queue.html'), 'utf8'));
export function renderVideoQueuePage(username: string, permissions: Permissions, videoQueue: import('./util.ts').VideoID[]): string {
  return applyTemplate(videoQueueTemplate, {
    commonCSS,
    formPageCSS,
    topRightBlock: renderTopRightBlock(username, permissions),
    canSubscribe: permissions.canSubscribe,
    videosIsEmpty: videoQueue.length === 0,
    videos: videoQueue.map(id => ({ id })),
  });
}

const searchScript = `
"use strict";

${formatDuration.toString()}

${formatDate.toString()}

${renderVideoCard.toString()}

${nameExt.toString()}

${formatLastUpdated.toString()}

${renderChannelCard.toString()}

{
  const state = JSON.parse(document.getElementById('search-state').textContent);
  const showChannel = !state.channelId;
  const tiers = state.channelId ? ['title', 'description', 'subtitles'] : ['channels', 'title', 'description', 'subtitles'];
  const tierLabels = { title: 'Matching title', description: 'Matching description', subtitles: 'Matching subtitles' };
  const container = document.getElementById('search-results');
  const loadingEle = document.getElementById('loading');
  const noResultsEle = document.getElementById('no-results');
  let seenVideoIds = new Set(state.seenVideoIds);
  let offsets = state.offsets;
  let exhausted = state.exhausted;
  let currentTierIdx = tiers.findIndex(t => !exhausted[t]);
  let loadState = 'idle';
  let videosHeadingShown = state.videosHeadingShown;

  function ensureTierSection(tier) {
    let gridId = tier + '-grid';
    let existing = document.getElementById(gridId);
    if (existing) return existing;

    if (tier !== 'channels') {
      if (!videosHeadingShown) {
        container.insertAdjacentHTML('beforeend', '<h2 class="section-title">Videos</h2>');
        videosHeadingShown = true;
      }
      if (tier !== 'title') {
        container.insertAdjacentHTML('beforeend', '<hr class="section-divider">');
      }
      container.insertAdjacentHTML('beforeend',
        '<p class="match-label">' + tierLabels[tier] + '</p>' +
        '<div class="video-grid" id="' + gridId + '"></div>');
    } else {
      container.insertAdjacentHTML('beforeend',
        '<h2 class="section-title">Channels</h2>' +
        '<div class="channels-grid" id="' + gridId + '"></div>');
    }
    return document.getElementById(gridId);
  }

  async function loadMore() {
    if (loadState !== 'idle' || currentTierIdx < 0 || currentTierIdx >= tiers.length) return;
    loadState = 'loading';
    loadingEle.style.display = 'block';

    try {
      while (currentTierIdx < tiers.length) {
        let tier = tiers[currentTierIdx];
        if (exhausted[tier]) { currentTierIdx++; continue; }

        let url = '/api/search?q=' + encodeURIComponent(state.query) +
          '&tier=' + tier + '&offset=' + offsets[tier] + '&limit=30' +
          (state.channelId ? '&channel=' + encodeURIComponent(state.channelId) : '');
        let resp = await fetch(url);
        let items = await resp.json();
        offsets[tier] += items.length;

        if (items.length < 30) {
          exhausted[tier] = true;
        }

        let grid = ensureTierSection(tier);
        if (tier === 'channels') {
          items.forEach(function(ch) { grid.insertAdjacentHTML('beforeend', renderChannelCard(ch)); });
          if (items.length > 0) break;
        } else {
          let added = 0;
          items.forEach(function(v) {
            if (!seenVideoIds.has(v.video_id)) {
              seenVideoIds.add(v.video_id);
              grid.insertAdjacentHTML('beforeend', renderVideoCard(v, showChannel));
              added++;
            }
          });
          if (added > 0) break;
        }

        if (exhausted[tier]) currentTierIdx++;
      }

      if (noResultsEle) noResultsEle.style.display = 'none';

      if (currentTierIdx >= tiers.length || tiers.every(function(t) { return exhausted[t]; })) {
        loadState = 'exhausted';
        if (container.children.length === 0 && noResultsEle) {
          noResultsEle.style.display = '';
        }
        loadingEle.textContent = container.children.length === 0 ? '' : 'No more results';
        return;
      }
    } catch (error) {
      console.error('Error loading search results:', error);
      loadState = 'errored';
      loadingEle.textContent = 'Error loading results';
      return;
    } finally {
      if (loadState === 'loading') {
        loadingEle.style.display = 'none';
        setTimeout(function() { loadState = 'idle'; }, 100);
      } else {
        setTimeout(function() { loadState = 'idle'; }, 1000);
      }
    }
  }

  window.addEventListener('scroll', function() {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 200) {
      loadMore();
    }
  });

  loadMore();
}
`;

const searchTemplate = parseTemplate(fs.readFileSync(path.join(templates, 'search.html'), 'utf8'));
export function renderSearchPage(username: string, permissions: Permissions, query: string, results: SearchResults, channel?: Channel | null): string {
  let allVideoIds = [
    ...results.videosByTitle.map(v => v.video_id),
    ...results.videosByDescription.map(v => v.video_id),
    ...results.videosBySubtitles.map(v => v.video_id),
  ];
  let videosHeadingShown = results.videosByTitle.length > 0 || results.videosByDescription.length > 0 || results.videosBySubtitles.length > 0;
  let searchState = JSON.stringify({
    query,
    channelId: channel?.channel_id || null,
    offsets: results.offsets,
    exhausted: results.exhausted,
    seenVideoIds: allVideoIds,
    videosHeadingShown,
  });
  let showChannel = !channel;
  return applyTemplate(searchTemplate, {
    commonCSS,
    topRightBlock: renderTopRightBlock(username, permissions),
    searchBar: renderSearchBar(query, channel?.channel_id, channel?.channel_title),
    query,
    hasChannel: !!channel,
    channelTitle: channel?.channel_title,
    channelShortId: channel?.short_id,
    hasChannels: results.channels.length > 0,
    channels: results.channels.map(ch => ({ html: renderChannelCard(ch) })),
    hasAnyVideos: videosHeadingShown,
    hasTitleVideos: results.videosByTitle.length > 0,
    titleVideos: results.videosByTitle.map(video => ({ html: renderVideoCard(video, showChannel) })),
    hasDescVideos: results.videosByDescription.length > 0,
    descVideos: results.videosByDescription.map(video => ({ html: renderVideoCard(video, showChannel) })),
    hasSubsVideos: results.videosBySubtitles.length > 0,
    subsVideos: results.videosBySubtitles.map(video => ({ html: renderVideoCard(video, showChannel) })),
    noResults: results.channels.length === 0 && !videosHeadingShown,
    searchState,
    searchScript,
  });
}