import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { toVideoID } from '../util.ts';
// import { isVideoInDb } from './media-db.ts';
import type { ChannelID, VideoID } from '../util.ts';

const execAsync = promisify(execCb);

const YT_DLP_PATH = process.env.YT_DLP_PATH ?? './yt-dlp';
const YT_DLP_BATCH_SIZE = 100; // How many videos to fetch per yt-dlp call
const YT_DLP_PAUSE_MS = 2000; // Pause between yt-dlp calls

export async function hasVideo(server: string, videoId: VideoID): Promise<boolean> {
  return (await fetch(`${server}/public-api/has-video?video_id=${videoId}`)).json();
}

export async function hasChannel(server: string, channelId: ChannelID): Promise<boolean> {
  return (await fetch(`${server}/public-api/has-channel?channel_id=${channelId}`)).json();
}

export async function getLatestVideoUrls(server: string, channelId: ChannelID, all=false): Promise<VideoID[]> {
  const channelVideosUrl = `https://www.youtube.com/channel/${channelId}/videos`;
  // console.log(`Fetching latest videos for channel ${channelId} from ${channelVideosUrl}`);

  const newVideoIds: VideoID[] = [];
  let startIndex = 1;

  while (true) {
    const endIndex = startIndex + YT_DLP_BATCH_SIZE - 1;
    const command = all
      ? `${YT_DLP_PATH} --flat-playlist --print webpage_url "${channelVideosUrl}"`
      : `${YT_DLP_PATH} --playlist-items ${startIndex}:${endIndex} --flat-playlist --print webpage_url "${channelVideosUrl}"`;

    console.log(`Executing: ${command}`);

    try {
      const { stdout, stderr } = await execAsync(command);

      if (stderr) {
        // yt-dlp often prints warnings/info to stderr, only log significant errors
        if (stderr.toLowerCase().includes('error')) {
          console.warn(`yt-dlp stderr for ${channelId} (${startIndex}-${endIndex}): ${stderr.trim()}`);
        }
      }

      const batchUrls = stdout
        .split('\n')
        .map(url => url.trim())
        .filter(url => url.length > 0);

      if (batchUrls.length === 0) {
        console.log(`No more videos found for ${channelId} starting from index ${startIndex}.`);
        break; // Reached the end of the channel's videos
      }

      // console.log(`Fetched batch (${startIndex}-${endIndex}), ${batchUrls.length} URLs found.`);
      for (const url of batchUrls) {
        const videoId = toVideoID(url);
        if (videoId == null) {
          throw new Error('failed to read video ID from url ' + url);
        }

        if (!(await hasVideo(server, videoId))) {
          newVideoIds.push(videoId);
        } else if (!all) {
          console.log(`Found known video ${videoId}. Stopping search.`);
          break;
        }
      }

      startIndex = endIndex + 1;
      // Pause before the next call if we are continuing
      if (batchUrls.length === YT_DLP_BATCH_SIZE) {
        // Only pause if we likely have more videos
        // console.log(`Pausing for ${YT_DLP_PAUSE_MS / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, YT_DLP_PAUSE_MS));
      } else {
        // console.log('Reached end of playlist in this batch.');
        break;
      }
    } catch (error: any) {
      console.error(`Error executing yt-dlp for ${channelId} (${startIndex}-${endIndex}):`, error?.message || error);
      if (error.stderr) {
        console.error(`yt-dlp stderr: ${error.stderr}`);
      }
      throw error;
    }

    if (all) break;
  }

  console.log(`Found ${newVideoIds.length} new videos for channel ${channelId}`);
  return newVideoIds;
}
