// "Burst": 8 simultaneous incidents in a fixed, seeded pattern, for showing greedy vs Hungarian live.
// The same seed always gives the same 8 calls. BURST_SEED was chosen with scripts/find-burst-seed.mjs
// as a seed where, with every unit at its station, the optimal assignment beats greedy clearly.
import { mulberry32 } from '../../shared/sim/random.js';
import { haversineM } from '../../shared/spatial/haversine.js';

// Seed 92 (search over 1..300, all units at their stations): greedy 2,882.9 s vs optimal 2,431.0 s total
// ETA for the 8 incidents, 452 s (15.7 %) saved. With units already busy the numbers differ.
export const BURST_SEED = 92;
export const BURST_SIZE = 8;
const MIN_SEPARATION_M = 300;     // well above the 100 m clustering radius: 8 distinct incidents
const TYPES = [['medical', 0.4], ['fire', 0.35], ['flood', 0.25]];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'];

export function burstPattern(seed, bbox, size = BURST_SIZE) {
  const r = mulberry32(seed);
  const padLat = (bbox.north - bbox.south) * 0.12, padLng = (bbox.east - bbox.west) * 0.12;
  const out = [];
  let guard = 0;
  while (out.length < size && guard++ < 10_000) {
    const lat = bbox.south + padLat + r() * (bbox.north - bbox.south - 2 * padLat);
    const lng = bbox.west + padLng + r() * (bbox.east - bbox.west - 2 * padLng);
    if (out.some((p) => haversineM(p.lat, p.lng, lat, lng) < MIN_SEPARATION_M)) continue;
    const x = r();
    let acc = 0, type = TYPES.at(-1)[0];
    for (const [t, w] of TYPES) { acc += w; if (x < acc) { type = t; break; } }
    out.push({
      lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, type,
      severity: SEVERITIES[Math.floor(r() * 3)], people: 1 + Math.floor(r() * 6),
    });
  }
  return out;
}
