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

// --- Channels (title only) ---
const channelRows = db.prepare(`
  SELECT
    ch.channel_id,
    ch.channel_title,
    ch.short_id,
    highlight(channels_fts, 0, '>>>', '<<<') as title_highlight,
    bm25(channels_fts) as rank
  FROM channels_fts fts
  JOIN channels ch ON ch.rowid = fts.rowid
  WHERE channels_fts MATCH ?
  ORDER BY rank
  LIMIT 20
`).all(`channel_title : ${ftsStr}`) as any[];

if (channelRows.length > 0) {
  console.log(`\n=== CHANNELS (${channelRows.length} results) ===\n`);
  for (const row of channelRows) {
    console.log(`  ${row.channel_title}  [${row.short_id}]`);
    console.log(`  score: ${row.rank.toFixed(4)}`);
    console.log(`    title: ${row.title_highlight}`);
    console.log();
  }
} else {
  console.log('\n=== CHANNELS: no results ===\n');
}

// --- Videos by tier ---
const videoStmt = db.prepare(`
  SELECT
    v.video_id,
    v.title,
    v.channel_id,
    c.channel_title,
    highlight(videos_fts, 0, '>>>', '<<<') as title_highlight,
    highlight(videos_fts, 1, '>>>', '<<<') as desc_highlight,
    highlight(videos_fts, 2, '>>>', '<<<') as subs_highlight,
    bm25(videos_fts) as rank
  FROM videos_fts fts
  JOIN videos v ON v.rowid = fts.rowid
  JOIN channels c ON v.channel_id = c.channel_id
  WHERE videos_fts MATCH ?
  ORDER BY rank
  LIMIT 30
`);

const tiers = [
  { column: 'title', label: 'TITLE MATCHES', highlightKey: 'title_highlight' },
  { column: 'description', label: 'DESCRIPTION MATCHES', highlightKey: 'desc_highlight' },
  { column: 'subtitles_text', label: 'SUBTITLE MATCHES', highlightKey: 'subs_highlight' },
] as const;

let seenIds = new Set<string>();

for (const tier of tiers) {
  const rows = videoStmt.all(`${tier.column} : ${ftsStr}`) as any[];
  const unique = rows.filter(r => !seenIds.has(r.video_id));

  console.log(`=== VIDEOS — ${tier.label} (${unique.length} results) ===\n`);
  for (const row of unique) {
    seenIds.add(row.video_id);
    console.log(`  ${row.title}`);
    console.log(`  channel: ${row.channel_title}  |  id: ${row.video_id}  |  score: ${row.rank.toFixed(4)}`);
    let highlight = row[tier.highlightKey];
    if (highlight && highlight.includes('>>>')) {
      console.log(`    ${tier.column}: ${truncate(highlight, 200)}`);
    }
    console.log();
  }
}

db.close();

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let markerPos = s.indexOf('>>>');
  if (markerPos > max / 2) {
    s = '...' + s.slice(markerPos - 40);
  }
  if (s.length > max) {
    s = s.slice(0, max) + '...';
  }
  return s;
}
