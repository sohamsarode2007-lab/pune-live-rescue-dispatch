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

// Simulation: speed multiplier at start (dispatcher can change it: 1, 5, 10, 30) and tick length.
export const SIM_SPEED = Number(process.env.SIM_SPEED) || 1;
export const TICK_MS = 500;

export const GRAPH_FILE = path.join(DATA_DIR, 'pune-central.graph.json');
export const FACILITIES_FILE = path.join(DATA_DIR, 'facilities.json');

// Phase 4: traffic snapshot (committed, so the demo works offline), daily call counter and OSRM log
// (machine-local, git-ignored), burst benchmark.
export const TRAFFIC_SNAPSHOT_FILE = path.join(DATA_DIR, 'traffic-snapshot.json');
export const EXTERNAL_CALLS_FILE = path.join(DATA_DIR, 'external-calls.json');
export const OSRM_LOG_FILE = path.join(DATA_DIR, 'osrm-comparisons.jsonl');
export const BURST_BENCHMARK_FILE = path.join(DATA_DIR, 'burst-benchmark.json');
// Endpoint overrides, only for testing against a local mock (defaults are the real services).
export const TOMTOM_FLOW_URL = process.env.TOMTOM_FLOW_URL || undefined;
export const OSRM_BASE_URL = process.env.OSRM_BASE_URL || undefined;
