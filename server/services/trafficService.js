// Live traffic from the TomTom Traffic Flow Segment Data API (free tier, server-side key only).
//
// 1. ~60 sample points on major roads (trunk / primary / secondary), longest roads first, at least
//    MIN_SEPARATION_M apart.
// 2. For each point, flowSegmentData returns currentSpeed, freeFlowSpeed and the segment's shape.
//    trafficFactor = freeFlowSpeed / currentSpeed, clamped to [1.0, 4.0] (traffic can only slow a road,
//    which keeps the A* heuristic admissible). A road closure counts as the maximum factor.
// 3. The segment shape is matched to our roads with the EdgeIndex (nearest-edge matching) and the factor
//    is set on those roads (the largest factor wins if two samples hit one road). Roads without a sample
//    stay at 1.0.
// No timer: refresh only when a dispatcher connects (at most every 15 min) or on "Refresh traffic".
// Every successful fetch is saved to disk and the last snapshot is loaded on startup (offline demo).
// Daily cap (200 calls) is enforced through ExternalCalls before every request.
import fs from 'node:fs';
import { EdgeIndex } from '../../shared/spatial/edgeMatcher.js';
import { haversineM } from '../../shared/spatial/haversine.js';
import { clampTrafficFactor, TRAFFIC_FACTOR_MAX } from '../../shared/graph/Graph.js';

export const SAMPLE_HIGHWAYS = new Set(['trunk', 'primary', 'secondary']);
const MATCH_HIGHWAYS = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link']);
export const SAMPLE_COUNT = 60;
const MIN_SEPARATION_M = 450;
const MATCH_DIST_M = 20;            // a TomTom shape point must be this close to one of our roads
const DENSIFY_M = 25;               // spacing of points checked along a TomTom segment
const MIN_REFRESH_MS = 15 * 60 * 1000;
const REQUEST_SPACING_MS = 250;     // stay well under TomTom's queries-per-second limit
const REQUEST_TIMEOUT_MS = 8000;
const TOMTOM_URL = 'https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json';

// freeFlow / current, clamped to [1, 4]; a closure or a stopped road gets the maximum.
export function trafficFactorFrom({ currentSpeed, freeFlowSpeed, roadClosure = false }) {
  if (roadClosure || !(currentSpeed > 0)) return TRAFFIC_FACTOR_MAX;
  return clampTrafficFactor(freeFlowSpeed / currentSpeed);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TrafficService {
  constructor({
    store, apiKey = '', snapshotFile = null, calls, fetchImpl = globalThis.fetch, now = () => Date.now(),
    sampleCount = SAMPLE_COUNT, spacingMs = REQUEST_SPACING_MS, minRefreshMs = MIN_REFRESH_MS, baseUrl = TOMTOM_URL,
    onChange = () => {},
  }) {
    Object.assign(this, { store, graph: store.graph, apiKey, snapshotFile, calls, fetchImpl, now, sampleCount, spacingMs, minRefreshMs, baseUrl, onChange });
    this.edges = new EdgeIndex(this.graph, { filter: (r) => MATCH_HIGHWAYS.has(r.highway) });
    this.samples = this.#pickSamples();
    this.snapshot = null;
    this.snapshotSource = null;     // 'fetched' | 'disk'
    this.mode = 'free-flow';
    this.refreshing = null;
    this.lastResult = null;
    this.#loadSnapshot();
  }

  // Longest major roads first; a sample is the road's midpoint (along its shape), kept only if it is at
  // least MIN_SEPARATION_M from every sample already chosen. Deterministic.
  #pickSamples() {
    const roads = [...this.graph.roads.values()].filter((r) => SAMPLE_HIGHWAYS.has(r.highway))
      .sort((a, b) => b.lengthM - a.lengthM || (a.id < b.id ? -1 : 1));
    const out = [];
    for (const r of roads) {
      if (out.length >= this.sampleCount) break;
      const g = this.graph.roadGeometry(r.id, r.from);
      const p = midpoint(g);
      if (out.some((s) => haversineM(s.lat, s.lng, p[0], p[1]) < MIN_SEPARATION_M)) continue;
      out.push({ id: `S${out.length + 1}`, lat: round6(p[0]), lng: round6(p[1]), roadId: r.id, roadName: r.name, highway: r.highway });
    }
    return out;
  }

  // ---------- snapshot ----------
  #loadSnapshot() {
    if (!this.snapshotFile || !fs.existsSync(this.snapshotFile)) return;
    try {
      const snap = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
      if (!Array.isArray(snap.samples) || !snap.fetchedAt) return;
      this.snapshot = snap;
      this.snapshotSource = 'disk';
      this.mode = 'live';
      this.apply();
    } catch { /* unreadable snapshot: stay on free-flow */ }
  }

  #saveSnapshot() {
    if (!this.snapshotFile) return;
    try { fs.writeFileSync(this.snapshotFile, JSON.stringify(this.snapshot, null, 1)); } catch { /* keep in memory */ }
  }

  // Puts the current snapshot's factors on the graph (or all 1.0 in free-flow mode).
  apply() {
    for (const r of this.graph.roads.values()) if (r.trafficFactor !== 1) this.graph.setTrafficFactor(r.id, 1);
    if (this.mode !== 'live' || !this.snapshot) return 0;
    const best = new Map();
    for (const s of this.snapshot.samples) {
      if (!s.ok) continue;
      const f = trafficFactorFrom(s);
      for (const id of s.roadIds) if (this.graph.getRoad(id)) best.set(id, Math.max(best.get(id) ?? 1, f));
    }
    for (const [id, f] of best) this.graph.setTrafficFactor(id, f);
    return best.size;
  }

  // Used by tests and tools: apply a given snapshot ({ fetchedAt, samples: [{ ok, currentSpeed, freeFlowSpeed, roadIds }] }).
  applySnapshot(snapshot, source = 'fetched') {
    this.snapshot = snapshot;
    this.snapshotSource = source;
    this.mode = 'live';
    return this.apply();
  }

  setMode(mode) {
    if (mode !== 'live' && mode !== 'free-flow') throw new Error('Unknown traffic mode');
    if (mode === 'live' && !this.snapshot) throw new Error('No traffic snapshot yet');
    this.mode = mode;
    this.apply();
    this.onChange(this.status());
  }

  // ---------- TomTom ----------
  // Shape points of a TomTom segment, densified every DENSIFY_M, matched to our roads.
  matchSegment(coords) {
    const pts = [];
    for (let i = 0; i < coords.length; i++) {
      pts.push(coords[i]);
      if (i + 1 < coords.length) {
        const [a, b] = [coords[i], coords[i + 1]];
        const n = Math.floor(haversineM(a[0], a[1], b[0], b[1]) / DENSIFY_M);
        for (let k = 1; k <= n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / (n + 1), a[1] + ((b[1] - a[1]) * k) / (n + 1)]);
      }
    }
    const votes = new Map();
    for (const [lat, lng] of pts) {
      const hit = this.edges.nearestEdge(lat, lng, MATCH_DIST_M);
      if (hit) votes.set(hit.roadId, (votes.get(hit.roadId) ?? 0) + 1);
    }
    // keep roads hit at least twice (or the only hit), to ignore stray matches on crossing roads
    return [...votes].filter(([, n]) => n >= 2 || votes.size === 1).map(([id]) => id).sort();
  }

  async #fetchSample(s) {
    const url = `${this.baseUrl}?key=${encodeURIComponent(this.apiKey)}&point=${s.lat},${s.lng}&unit=KMPH`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };       // never echo the URL: it contains the key
      const body = await res.json();
      const d = body?.flowSegmentData;
      if (!d || !(d.freeFlowSpeed > 0)) return { ok: false, error: 'Unexpected response' };
      const coords = (d.coordinates?.coordinate ?? []).map((c) => [c.latitude, c.longitude]);
      return {
        ok: true, currentSpeed: d.currentSpeed, freeFlowSpeed: d.freeFlowSpeed, confidence: d.confidence ?? null,
        roadClosure: Boolean(d.roadClosure), frc: d.frc ?? null, roadIds: this.matchSegment(coords.length ? coords : [[s.lat, s.lng]]),
      };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? 'Timeout' : 'Network error' };
    } finally {
      clearTimeout(timer);
    }
  }

  // Dispatcher connected: refresh only if we have a key and the snapshot is missing or older than 15 min.
  maybeAutoRefresh() {
    if (!this.apiKey) return null;
    const age = this.snapshot ? this.now() - Date.parse(this.snapshot.fetchedAt) : Infinity;
    if (age < this.minRefreshMs) return null;
    return this.refresh({ reason: 'auto' });
  }

  refresh({ reason = 'manual' } = {}) {
    if (!this.refreshing) this.refreshing = this.#doRefresh(reason).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async #doRefresh(reason) {
    if (!this.apiKey) return (this.lastResult = { ok: false, reason: 'NO_KEY', message: 'No TOMTOM_API_KEY: live traffic unavailable, using free-flow.' });
    const previous = new Map((this.snapshot?.samples ?? []).map((s) => [s.id, s]));
    const samples = [];
    let fetched = 0, failed = 0, capReached = false;
    for (const s of this.samples) {
      if (!this.calls.tryRecord('tomtom')) { capReached = true; break; }
      const r = await this.#fetchSample(s);
      if (r.ok) { fetched++; samples.push({ ...s, ...r, fetchedAt: new Date(this.now()).toISOString() }); }
      else { failed++; this.calls.error('tomtom'); }
      if (this.spacingMs) await sleep(this.spacingMs);
    }
    if (fetched === 0) {
      return (this.lastResult = {
        ok: false, reason: capReached ? 'DAILY_CAP' : 'FETCH_FAILED', fetched, failed,
        message: capReached ? `Daily TomTom cap reached (${this.calls.cap('tomtom')} calls). Keeping the last snapshot.` : 'TomTom unreachable. Keeping the last snapshot.',
      });
    }
    // Samples not fetched this time (cap reached part-way, or failed) keep their previous values.
    const got = new Set(samples.map((s) => s.id));
    for (const s of this.samples) if (!got.has(s.id) && previous.get(s.id)?.ok) samples.push({ ...previous.get(s.id), stale: true });
    this.snapshot = {
      fetchedAt: new Date(this.now()).toISOString(), source: 'TomTom Traffic Flow (flowSegmentData)', reason,
      partial: fetched < this.samples.length, samples,
    };
    this.snapshotSource = 'fetched';
    this.#saveSnapshot();
    this.mode = 'live';
    const matched = this.apply();
    this.onChange(this.status());
    return (this.lastResult = { ok: true, fetched, failed, capReached, matchedRoads: matched });
  }

  // ---------- views ----------
  status() {
    const s = this.snapshot;
    const ok = s ? s.samples.filter((x) => x.ok) : [];
    return {
      mode: this.mode, hasKey: Boolean(this.apiKey), refreshing: Boolean(this.refreshing),
      snapshotAt: s?.fetchedAt ?? null, snapshotSource: this.snapshotSource, partial: s?.partial ?? false,
      samples: this.samples.length, fetchedSamples: ok.length,
      matchedRoads: new Set(ok.flatMap((x) => x.roadIds)).size,
      lastResult: this.lastResult,
      message: this.mode === 'live' && s
        ? `Traffic as of ${s.fetchedAt}${this.snapshotSource === 'disk' ? ' (saved snapshot)' : ''}`
        : this.apiKey ? 'Free-flow traffic' : 'Live traffic unavailable: free-flow speeds',
    };
  }

  // Sampled roads with their factor, for colouring the map (green / orange / red).
  roadsView() {
    if (!this.snapshot) return { samples: this.samples, roads: [] };
    const roads = new Map();
    for (const s of this.snapshot.samples) {
      if (!s.ok) continue;
      const f = trafficFactorFrom(s);
      for (const id of s.roadIds) {
        const r = this.graph.getRoad(id);
        if (r && (!roads.has(id) || roads.get(id).factor < f)) {
          roads.set(id, { id, factor: Math.round(f * 100) / 100, currentSpeed: s.currentSpeed, freeFlowSpeed: s.freeFlowSpeed, sampleId: s.id, name: r.name, geometry: this.graph.roadGeometry(id, r.from) });
        }
      }
    }
    return { samples: this.samples, roads: [...roads.values()] };
  }
}

function midpoint(g) {
  let total = 0;
  const seg = [];
  for (let i = 1; i < g.length; i++) { const d = haversineM(g[i - 1][0], g[i - 1][1], g[i][0], g[i][1]); seg.push(d); total += d; }
  let acc = 0;
  for (let i = 1; i < g.length; i++) {
    if (acc + seg[i - 1] >= total / 2) {
      const f = seg[i - 1] > 0 ? (total / 2 - acc) / seg[i - 1] : 0;
      return [g[i - 1][0] + (g[i][0] - g[i - 1][0]) * f, g[i - 1][1] + (g[i][1] - g[i - 1][1]) * f];
    }
    acc += seg[i - 1];
  }
  return g[0];
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;
