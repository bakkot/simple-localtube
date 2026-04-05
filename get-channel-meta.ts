import fs from 'fs';
import path from 'path';

import { spawnSync } from 'child_process';
import { fetchTo, getTemp, move, type ChannelID } from './util.ts';

const YT_DLP_PATH = process.env.YT_DLP_PATH ?? path.join(import.meta.dirname, 'yt-dlp');

