import express from 'express';
import type { Request, Response } from 'express';
import { parseArgs } from 'util';
import { getRecentVideos, getVideoById, getChannelByShortId, getVideosByChannel } from './db-manager.ts';
import type { VideoID } from './util.ts';

let { positionals } = parseArgs({ allowPositionals: true });
if (positionals.length !== 1) {
  console.log('Usage: node server.ts path-to-media-dir');
  process.exit(1);
}

const app = express();
const PORT = 3000;

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

function renderVideoGrid(videos: any[], title: string = 'Recent Videos'): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    h1 { color: #333; }
    .video-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; margin-top: 20px; }
    .video-card { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .video-card:hover { box-shadow: 0 4px 8px rgba(0,0,0,0.15); }
    .thumb-container { position: relative; }
    .thumb { width: 100%; height: 180px; object-fit: cover; }
    .duration { position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.8); color: white; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    .video-info { padding: 12px; }
    .video-title { font-weight: bold; margin-bottom: 8px; color: #333; text-decoration: none; }
    .video-title:hover { color: #1976d2; }
    .channel-name { color: #666; font-size: 14px; text-decoration: none; }
    .channel-name:hover { color: #1976d2; }
    a { text-decoration: none; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="video-grid">
    ${videos.map(video => `
      <div class="video-card">
        <a href="/v/${video.video_id}">
          <div class="thumb-container">
            <img class="thumb" src="/media/${video.channel_id}/${video.video_id}/thumb.${video.thumb_extension || 'jpg'}" alt="${video.title}">
            <span class="duration">${formatDuration(video.duration_seconds || 0)}</span>
          </div>
        </a>
        <div class="video-info">
          <a href="/v/${video.video_id}" class="video-title">${video.title}</a>
          <div><a href="/c/${video.channel_short_id}" class="channel-name">${video.channel}</a></div>
        </div>
      </div>
    `).join('')}
  </div>
</body>
</html>`;
}

// Homepage
app.get('/', (req, res) => {
  const videos = getRecentVideos(30);
  res.send(renderVideoGrid(videos, 'LocalTube'));
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
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .video-container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    video { width: 100%; max-width: 800px; height: auto; }
    .video-info { margin-top: 15px; }
    .video-title { font-size: 24px; font-weight: bold; margin-bottom: 10px; color: #333; }
    .channel-info { display: flex; align-items: center; margin-bottom: 15px; }
    .channel-avatar { width: 40px; height: 40px; border-radius: 50%; margin-right: 10px; }
    .channel-name { color: #1976d2; text-decoration: none; font-weight: bold; }
    .channel-name:hover { text-decoration: underline; }
    .description { color: #666; line-height: 1.5; white-space: pre-wrap; }
    .back-link { display: inline-block; margin-bottom: 20px; color: #1976d2; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <a href="/" class="back-link">← Back to Home</a>
  <div class="video-container">
    <video controls>
      <source src="/media/${video.channel_id}/${video.video_id}/video.${video.extension}" type="video/${video.extension === 'mp4' ? 'mp4' : 'webm'}">
      Your browser does not support the video tag.
    </video>
    <div class="video-info">
      <div class="video-title">${video.title}</div>
      <div class="channel-info">
        ${video.avatar ? `<img class="channel-avatar" src="/media/${video.channel_id}/avatar.png" alt="${video.channel}">` : ''}
        <a href="/c/${video.channel_short_id}" class="channel-name">${video.channel}</a>
      </div>
      <div class="description">${video.description}</div>
    </div>
  </div>
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
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .channel-header { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .channel-info { display: flex; align-items: center; }
    .channel-avatar { width: 80px; height: 80px; border-radius: 50%; margin-right: 20px; }
    .channel-details h1 { margin: 0 0 10px 0; color: #333; }
    .channel-description { color: #666; line-height: 1.5; }
    .back-link { display: inline-block; margin-bottom: 20px; color: #1976d2; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
    .video-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
    .video-card { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .video-card:hover { box-shadow: 0 4px 8px rgba(0,0,0,0.15); }
    .thumb-container { position: relative; }
    .thumb { width: 100%; height: 180px; object-fit: cover; }
    .duration { position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.8); color: white; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    .video-info { padding: 12px; }
    .video-title { font-weight: bold; color: #333; text-decoration: none; }
    .video-title:hover { color: #1976d2; }
    a { text-decoration: none; }
  </style>
</head>
<body>
  <a href="/" class="back-link">← Back to Home</a>
  <div class="channel-header">
    <div class="channel-info">
      ${channel.avatar ? `<img class="channel-avatar" src="/media/${channel.channel_id}/avatar.png" alt="${channel.channel}">` : ''}
      <div class="channel-details">
        <h1>${channel.channel}</h1>
        ${channel.description ? `<div class="channel-description">${channel.description}</div>` : ''}
      </div>
    </div>
  </div>
  <div class="video-grid">
    ${videos.map(video => `
      <div class="video-card">
        <a href="/v/${video.video_id}">
          <div class="thumb-container">
            <img class="thumb" src="/media/${video.channel_id}/${video.video_id}/thumb.${video.thumb_extension || 'jpg'}" alt="${video.title}">
            <span class="duration">${formatDuration(video.duration_seconds || 0)}</span>
          </div>
        </a>
        <div class="video-info">
          <a href="/v/${video.video_id}" class="video-title">${video.title}</a>
        </div>
      </div>
    `).join('')}
  </div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`LocalTube server running on http://localhost:${PORT}`);
});