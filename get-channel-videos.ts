import { DatabaseSync } from 'node:sqlite';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execCb);

// --- Configuration ---
const DB_PATH = './youtube_data.sqlite';
const YT_DLP_PATH = process.env.YT_DLP_PATH ?? './yt-dlp';
const YT_DLP_PAUSE_MS = 2000; // Pause between yt-dlp calls

// --- Database Setup ---
let db = new DatabaseSync(DB_PATH);

let existing = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all().map(({ name }) => name);
console.log(existing);
if (existing.length === 0) {
  db.exec(`
    CREATE TABLE channels (
        channel_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT
    ) STRICT;

    CREATE TABLE videos (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        publish_date TEXT NOT NULL, -- TODO better type here
        duration_seconds INTEGER,
        FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
    ) STRICT;

    CREATE INDEX idx_videos_channel_id ON videos(channel_id);
  `);
} else if (!(new Set(existing)).isSubsetOf(new Set(['channels', 'videos']))) {
  throw new Error(`${DB_PATH} exists but does not contain the data we expect`);
}

let addChannelStmt = db.prepare(`
    INSERT INTO channels (channel_id, title, description)
    VALUES (:channel_id, :title, :description)
`);

let addVideoStmt = db.prepare(`
    INSERT INTO videos (video_id, channel_id, title, description, publish_date, duration_seconds)
    VALUES (:video_id, :channel_id, :title, :description, :publish_date, :duration_seconds)
`);

let isVideoInDbStmt = db.prepare(`
    SELECT 1 FROM videos WHERE video_id = ? LIMIT 1
`);

// --- Types ---
export interface Channel {
  channel_id: string;
  title: string;
  description?: string | null;
}

export interface Video {
  video_id: string;
  channel_id: string;
  title: string;
  description?: string | null;
  publish_date: string; // Recommend ISO 8601 format (YYYY-MM-DDTHH:MM:SSZ)
  duration_seconds?: number | null;
}

// --- Database Functions ---

/**
 * Inserts or ignores a new channel into the database.
 * @param channel - The channel information.
 */
export function addChannel(channel: Channel): void {
  addChannelStmt.run({
    ':channel_id': channel.channel_id,
    ':title': channel.title,
    ':description': channel.description ?? null,
  });
}

export function addVideo(video: Video): void {
  addVideoStmt.run({
    ':video_id': video.video_id,
    ':channel_id': video.channel_id,
    ':title': video.title,
    ':description': video.description ?? null,
    ':publish_date': video.publish_date,
    ':duration_seconds': video.duration_seconds ?? null,
  });
}

function isVideoInDb(videoId: string): boolean {
  return !!isVideoInDbStmt.get(videoId)
}

/**
 * Extracts the video ID from a YouTube watch URL.
 * @param url - The YouTube video URL.
 * @returns The video ID or null if parsing fails.
 */
function extractVideoId(url: string): string {
  const parsedUrl = new URL(url);
  if (
    parsedUrl.hostname === 'www.youtube.com' ||
    parsedUrl.hostname === 'youtube.com' ||
    parsedUrl.hostname === 'm.youtube.com'
  ) {
    let res = parsedUrl.searchParams.get('v');
    if (!res) {
      throw new Error('youtube url does not have a `?v=` part: ' + url);
    }
    return res;
  } else if (parsedUrl.hostname === 'youtu.be') {
    let pathParts = parsedUrl.pathname.split('/');
    if (pathParts.length === 2 && pathParts[0] === '') {
      return pathParts[1];
    }
  }
  throw new Error('did not recognize URL ' + url);
}

// --- Core Logic ---

export async function getLatestVideoUrls(channelId: string): Promise<string[]> {
  const channelVideosUrl = `https://www.youtube.com/channel/${channelId}/videos`;
  // console.log(`Fetching latest videos for channel ${channelId} from ${channelVideosUrl}`);

  const newVideoUrls: string[] = [];

  const command = `${YT_DLP_PATH} --flat-playlist --print webpage_url "${channelVideosUrl}"`;

  console.log(`Executing: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(command);

    if (stderr) {
      // yt-dlp often prints warnings/info to stderr, only log significant errors
      if (stderr.toLowerCase().includes('error')) {
        console.warn(`yt-dlp stderr for ${channelId}: ${stderr.trim()}`);
      }
    }

    const batchUrls = stdout
      .split('\n')
      .map(url => url.trim())
      .filter(url => url.length > 0);

    if (batchUrls.length === 0) {
      console.log(`No videos found for ${channelId}.`);
      return newVideoUrls; // Reached the end of the channel's videos
    }

    console.log(`${batchUrls.length} URLs found.`);
    for (const url of batchUrls) {
      const videoId = extractVideoId(url);

      if (isVideoInDb(videoId)) {
        console.log(`Found known video ${videoId} in DB. Stopping search.`);
        return newVideoUrls;
      } else {
        // Add to list of potential new videos for this batch
        newVideoUrls.push(url);
      }
    }
  } catch (error: any) {
    console.error(`Error executing yt-dlp for ${channelId}:`, error?.message || error);
    if (error.stderr) {
      console.error(`yt-dlp stderr: ${error.stderr}`);
    }
    // Decide how to handle errors: stop for this channel or try to continue?
    // Stopping is safer to avoid infinite loops on persistent errors.
    console.error(`Aborting fetch for channel ${channelId} due to error.`);
    throw error;
  }

  console.log(`All videos for channel were new.`);
  return newVideoUrls;
}

/**
 * Closes the database connection gracefully.
 * Call this when your application is shutting down.
 */
export function closeDb(): void {
  if (db) {
    console.log('Closing database connection.');
    db.close();
    // @ts-ignore // Allow db to be reassigned if needed later
    db = undefined; // Reset db variable
  }
}

console.log(await getLatestVideoUrls('UCc1ufNROdAxto9Fr0jnEE2Q'));

// Example Usage (can be removed or placed in a separate file)
/*
async function main() {
    // Example: Add a channel (if not already present)
    addChannel({
        channel_id: 'UCexampleChannelId12345', // Replace with a real channel ID (UC...)
        title: 'Example Channel Name',
        custom_url: '@exampleHandle' // Replace with real handle or omit/set null
    });

    // Example: Get latest videos for the channel
    const newUrls = await getLatestVideoUrls('UCexampleChannelId12345'); // Use the channel ID PK

    console.log("\nNew Video URLs found:");
    newUrls.forEach(url => console.log(url));

    // You would typically fetch details for these new URLs using yt-dlp -j
    // and then add them to the DB using addVideo()

    // Example: Manually add a video (replace with actual data)
    // addVideo({
    //     video_id: 'dQw4w9WgXcQ',
    //     channel_id: 'UCexampleChannelId12345',
    //     title: 'Example Video Title',
    //     publish_date: '2023-10-27T00:00:00Z', // ISO 8601 format
    //     description: 'Video description here',
    //     duration: 212
    // });

    // Close the database when done
    closeDb();
}

// Run example if script is executed directly
// Note: Top-level await is available in ESM modules
// await main();
*/
