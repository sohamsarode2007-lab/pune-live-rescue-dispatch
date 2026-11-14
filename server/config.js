import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'server', 'data');
// Machine-local files the server rewrites at runtime (snapshots, call counter, OSRM log). Same folder by
// default; RUNTIME_DATA_DIR moves them (tests run a real server without touching this machine's copies).
export const RUNTIME_DATA_DIR = process.env.RUNTIME_DATA_DIR ? path.resolve(process.env.RUNTIME_DATA_DIR) : DATA_DIR;

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
// TOMTOM_DISABLED=1 ignores the key (no TomTom calls at all; the saved snapshot is still used). Use it for
// tests and rehearsals: an empty TOMTOM_API_KEY does not work in PowerShell, where setting a variable to ''
// deletes it, so the key from .env would be loaded again.
export const TOMTOM_DISABLED = /^(1|true|yes)$/i.test(process.env.TOMTOM_DISABLED ?? '');
export const TOMTOM_API_KEY = TOMTOM_DISABLED ? '' : (process.env.TOMTOM_API_KEY || '');

// Simulation: speed multiplier at start (dispatcher can change it: 1, 5, 10, 30) and tick length.
export const SIM_SPEED = Number(process.env.SIM_SPEED) || 1;
export const TICK_MS = 500;

export const GRAPH_FILE = path.join(DATA_DIR, 'pune-central.graph.json');
export const FACILITIES_FILE = path.join(DATA_DIR, 'facilities.json');

// Phase 4: traffic snapshot, daily call counter and OSRM log (machine-local, git-ignored), burst benchmark.
// Runtime data rewritten by the server (*.json) is git-ignored; the committed *.baseline.json copies are the
// offline fallback, used when there is no runtime copy yet (fresh clone). The server never writes them.
export const TRAFFIC_SNAPSHOT_FILE = path.join(RUNTIME_DATA_DIR, 'traffic-snapshot.json');
export const TRAFFIC_SNAPSHOT_BASELINE_FILE = path.join(DATA_DIR, 'traffic-snapshot.baseline.json');
export const EXTERNAL_CALLS_FILE = path.join(RUNTIME_DATA_DIR, 'external-calls.json');
export const OSRM_LOG_FILE = path.join(RUNTIME_DATA_DIR, 'osrm-comparisons.jsonl');
export const BURST_BENCHMARK_FILE = path.join(DATA_DIR, 'burst-benchmark.json');
export const RIVER_FILE = path.join(DATA_DIR, 'river.json');
// Phase 7: session event logs (git-ignored), saved replays (committed), benchmark results (committed).
export const LOG_DIR = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(ROOT, 'server', 'logs');
export const REPLAY_DIR = path.join(DATA_DIR, 'replays');
export const BENCHMARKS_FILE = path.join(DATA_DIR, 'benchmarks.json');
// Phase 5: SRTM elevations (generated), Open-Meteo Flood API history (committed, for offline use) and the
// latest current-discharge result (runtime copy git-ignored, refreshed at most every 6 h; committed baseline).
export const ELEVATION_FILE = path.join(DATA_DIR, 'elevation.json');
export const FLOOD_HISTORY_FILE = path.join(DATA_DIR, 'flood-history.json');
export const FLOOD_CURRENT_FILE = path.join(RUNTIME_DATA_DIR, 'flood-current.json');
export const FLOOD_CURRENT_BASELINE_FILE = path.join(DATA_DIR, 'flood-current.baseline.json');
// Endpoint overrides, only for testing against a local mock (defaults are the real services).
export const TOMTOM_FLOW_URL = process.env.TOMTOM_FLOW_URL || undefined;
export const OPEN_METEO_FLOOD_URL = process.env.OPEN_METEO_FLOOD_URL || undefined;
export const OSRM_BASE_URL = process.env.OSRM_BASE_URL || undefined;
