import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { fetchMetaForChannel } from '../get-channel-meta.ts';
import type { ChannelID } from '../util.ts';

let { positionals } = parseArgs({ allowPositionals: true });
if (positionals.length !== 1) {
  console.log('Usage: node get-all-channel-meta.ts path-to-media-dir');
  process.exit(1);
}

let dir = positionals[0];

const openedDir = fs.opendirSync(dir);

for await (const entry of openedDir) {
  if (!entry.isDirectory()) continue;
  console.log(entry.name);
  try {
    await fetchMetaForChannel(dir, entry.name as ChannelID);
  } catch (e) {
    if (e instanceof Error && e.message.includes('This channel does not exist.')) {
      console.error(`channel ${entry.name} does not exist`);
    } else {
      throw e;
    }
  }
}
