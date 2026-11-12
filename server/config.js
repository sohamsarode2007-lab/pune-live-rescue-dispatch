import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'server', 'data');

// Minimal .env loader (no extra dependency). Only TOMTOM_API_KEY is used, and only from Phase 4.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

// Central Pune: Kothrud, Deccan, Shivajinagar, Swargate, Camp, Mutha riverbank.
// Must match scripts/osm_common.py BBOX.
export const DEMO_BBOX = Object.freeze({ north: 18.56, south: 18.49, east: 73.88, west: 73.80 });

// Full city, used only by scripts/bench.mjs (Phase 7).
export const BENCH_AREA = 'Pune, Maharashtra, India';

export const PORT = Number(process.env.PORT) || 3001;
export const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY || '';

export const GRAPH_FILE = path.join(DATA_DIR, 'pune-central.graph.json');
export const FACILITIES_FILE = path.join(DATA_DIR, 'facilities.json');
