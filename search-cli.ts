// for debugging

import { DatabaseSync } from 'node:sqlite';
import path from 'path';

const DB_PATH = path.join(import.meta.dirname, './youtube_data.sqlite');
const db = new DatabaseSync(DB_PATH);

const query = process.argv[2];
if (!query) {
  console.error('Usage: npx tsx search-cli.ts <query>');
  process.exit(1);
}

let tokens = query.trim().split(/\s+/).filter(Boolean);
let ftsStr = tokens.map(t => '"' + t.replace(/"/g, '""') + '"').join(' ');

// --- Channels ---
const channelRows = db.prepare(`
  SELECT
    ch.channel_id,
    ch.channel_title,
    ch.short_id,
    highlight(channels_fts, 0, '>>>', '<<<') as title_highlight,
    highlight(channels_fts, 1, '>>>', '<<<') as desc_highlight,
    bm25(channels_fts, 5.0, 1.0) as rank
  FROM channels_fts fts
  JOIN channels ch ON ch.rowid = fts.rowid
  WHERE channels_fts MATCH ?
  ORDER BY rank
  LIMIT 20
`).all(ftsStr) as any[];

if (channelRows.length > 0) {
  console.log(`\n=== CHANNELS (${channelRows.length} results) ===\n`);
  for (const row of channelRows) {
    console.log(`  ${row.channel_title}  [${row.short_id}]`);
    console.log(`  score: ${row.rank.toFixed(4)}`);
    let titleMatched = row.title_highlight.includes('>>>');
    let descMatched = row.desc_highlight && row.desc_highlight.includes('>>>');
    console.log(`  matched in: ${[titleMatched && 'title', descMatched && 'description'].filter(Boolean).join(', ')}`);
    if (titleMatched) console.log(`    title: ${row.title_highlight}`);
    if (descMatched) console.log(`    desc:  ${truncate(row.desc_highlight, 200)}`);
    console.log();
  }
} else {
  console.log('\n=== CHANNELS: no results ===\n');
}

// --- Videos ---
const videoRows = db.prepare(`
  SELECT
    v.video_id,
    v.title,
    v.channel_id,
    c.channel_title,
    highlight(videos_fts, 0, '>>>', '<<<') as title_highlight,
    highlight(videos_fts, 1, '>>>', '<<<') as desc_highlight,
    highlight(videos_fts, 2, '>>>', '<<<') as subs_highlight,
    bm25(videos_fts, 10.0, 5.0, 1.0) as rank
  FROM videos_fts fts
  JOIN videos v ON v.rowid = fts.rowid
  JOIN channels c ON v.channel_id = c.channel_id
  WHERE videos_fts MATCH ?
  ORDER BY rank
  LIMIT 30
`).all(ftsStr) as any[];

if (videoRows.length > 0) {
  console.log(`=== VIDEOS (${videoRows.length} results) ===\n`);
  for (const row of videoRows) {
    console.log(`  ${row.title}`);
    console.log(`  channel: ${row.channel_title}  |  id: ${row.video_id}  |  score: ${row.rank.toFixed(4)}`);
    let titleMatched = row.title_highlight.includes('>>>');
    let descMatched = row.desc_highlight.includes('>>>');
    let subsMatched = row.subs_highlight.includes('>>>');
    console.log(`  matched in: ${[titleMatched && 'title', descMatched && 'description', subsMatched && 'subtitles'].filter(Boolean).join(', ')}`);
    if (titleMatched) console.log(`    title: ${row.title_highlight}`);
    if (descMatched) console.log(`    desc:  ${truncate(row.desc_highlight, 200)}`);
    if (subsMatched) console.log(`    subs:  ${truncate(row.subs_highlight, 200)}`);
    console.log();
  }
} else {
  console.log('=== VIDEOS: no results ===\n');
}

db.close();

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Try to cut near a highlight marker so we show useful context
  let markerPos = s.indexOf('>>>');
  if (markerPos > max / 2) {
    s = '...' + s.slice(markerPos - 40);
  }
  if (s.length > max) {
    s = s.slice(0, max) + '...';
  }
  return s;
}
