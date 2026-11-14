// Phase 5: flood state on the live road network.
//
// - Water level (m above the Mutha surface): set by the dispatcher's "Khadakwasla dam release" slider, or
//   suggested by the Open-Meteo Flood API (GloFAS river discharge, free, no key) compared with its own
//   1984-onward history: normal (< p90) -> 0 m, elevated (p90-p99) -> 4 m, flood alert (>= p99) -> 8 m.
//   GloFAS is a coarse (~5 km) global model and does NOT see Khadakwasla dam releases, hence the slider.
// - The FloodModel turns the level into a BFS flood plan; tick() applies road statuses as sim time passes,
//   only to roads the flood itself changed (manual or crowd closures are never reopened by a receding flood).
import fs from 'node:fs';
import { FloodModel, riverProfile, MAX_LEVEL_M } from '../../shared/sim/floodModel.js';

export const GLOFAS_POINT = Object.freeze({ lat: 18.5296, lng: 73.8619, label: 'Mutha at the Sangam (Mula-Mutha confluence)' });
export const LEVEL_FOR = Object.freeze({ normal: 0, elevated: 4, 'flood alert': 8 });
const API = 'https://flood-api.open-meteo.com/v1/flood';
const CURRENT_TTL_MS = 6 * 3600 * 1000;
const TIMEOUT_MS = 15000;

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function classifyDischarge(currentMax, history) {
  const s = history.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const p90 = percentile(s, 0.9), p99 = percentile(s, 0.99);
  const status = currentMax >= p99 ? 'flood alert' : currentMax >= p90 ? 'elevated' : 'normal';
  return { status, p50: percentile(s, 0.5), p90, p99, years: s.length / 365.25 };
}

export class FloodService {
  constructor({
    store, elevation, rivers, calls = null, fetchImpl = globalThis.fetch, historyFile = null, currentFile = null,
    currentBaselineFile = null, point = GLOFAS_POINT, now = () => Date.now(), modelOptions = {}, apiUrl = API,
  }) {
    Object.assign(this, { store, graph: store.graph, calls, fetchImpl, historyFile, currentFile, currentBaselineFile, point, now, apiUrl });
    this.available = Boolean(elevation && rivers?.length);
    this.riverPoints = this.available ? riverProfile(rivers, elevation.rivers) : [];
    this.model = this.available
      ? new FloodModel({ graph: this.graph, nodeElev: new Map(Object.entries(elevation.nodes)), riverPoints: this.riverPoints, ...modelOptions })
      : null;
    this.level = 0;
    this.levelSource = 'none';
    this.startS = 0;
    this.plan = this.model ? this.model.plan(0) : null;
    this.applied = new Map();        // roadId -> status the FLOOD set (only these are reverted on recede)
    this.floodedNow = 0;
    this.glofas = this.#loadCurrent();
  }

  // ---------- level ----------
  setLevel(level, simNowS, source = 'manual') {
    if (!this.model) throw new Error('Flood model unavailable (run scripts/build_elevation.py)');
    const l = Math.max(0, Math.min(MAX_LEVEL_M, Number(level)));
    if (!Number.isFinite(l)) throw new Error('Invalid level');
    // Flood times are kept ABSOLUTE (sim seconds). When the water rises in steps, a junction already under
    // water stays under water (earliest time wins) and the new BFS continues from now; when it falls,
    // junctions not in the new plan recede.
    const rel = this.model.plan(l);
    const merged = new Map();
    for (const [id, t] of rel.floodTimeS) {
      const prev = this.plan?.floodTimeS.get(id);
      merged.set(id, prev !== undefined ? Math.min(prev, simNowS + t) : simNowS + t);
    }
    this.level = l;
    this.levelSource = source;
    this.levelSetAtS = simNowS;
    this.startS = 0;
    this.plan = { ...rel, floodTimeS: merged };
    return this.status();
  }

  // The sim clock restarted at simS (sim reset): replan the current level from scratch at that time. The
  // roads the flood owns stay owned, so tick() reopens / recloses them correctly as the water spreads again.
  restartAt(simS) {
    if (!this.model || this.level <= 0) return;
    const { level, levelSource } = this;
    this.plan = this.model.plan(0);
    this.setLevel(level, simS, levelSource);
  }

  // Back to a dry river (used by sim reset and the demo scenario).
  reset() {
    if (!this.model) return;
    this.plan = this.model.plan(0);
    this.level = 0; this.levelSource = 'none'; this.levelSetAtS = 0; this.startS = 0; this.floodedNow = 0;
    this.applied.clear();
  }

  // Road statuses once a level has fully spread (for planning: placement and evacuation under a flood).
  finalStatuses(level) {
    if (!this.model) return { blocked: new Set(), highRisk: new Set(), flooded: new Set(), risk: new Set() };
    const plan = this.model.plan(level);
    const { statuses } = this.model.roadStatuses(plan, Infinity);
    const blocked = new Set(), highRisk = new Set();
    for (const [id, s] of statuses) (s === 'BLOCKED' ? blocked : highRisk).add(id);
    return { blocked, highRisk, flooded: new Set(plan.floodTimeS.keys()), risk: plan.risk };
  }

  // Applies the statuses due at simNowS. Returns { blocked: [...], highRisk: [...], reopened: [...] }.
  tick(simNowS) {
    const changes = { blocked: [], highRisk: [], reopened: [] };
    if (!this.model) return changes;
    const { statuses, floodedNow } = this.model.roadStatuses(this.plan, simNowS - this.startS);
    this.floodedNow = floodedNow;
    for (const [id, want] of statuses) {
      const road = this.graph.getRoad(id);
      const mine = this.applied.get(id);
      if (mine === undefined && road.status !== 'OPEN') continue;              // closed by someone else: leave it
      if (mine !== undefined && road.status !== mine) { this.applied.delete(id); continue; }   // overridden meanwhile
      if (road.status === want) continue;
      this.store.setRoadStatus(id, want, 'flood');
      this.applied.set(id, want);
      (want === 'BLOCKED' ? changes.blocked : changes.highRisk).push(id);
    }
    for (const [id, mine] of this.applied) {
      if (statuses.has(id)) continue;
      if (this.graph.getRoad(id).status === mine) { this.store.setRoadStatus(id, 'OPEN', 'flood'); changes.reopened.push(id); }
      this.applied.delete(id);
    }
    return changes;
  }

  // A dispatcher changed this road by hand: the flood no longer owns it.
  forget(roadId) { this.applied.delete(roadId); }

  status() {
    const p = this.plan;
    let blocked = 0, risk = 0;
    for (const s of this.applied.values()) (s === 'BLOCKED' ? blocked++ : risk++);
    return {
      available: Boolean(this.model), level: this.level, levelSource: this.levelSource, maxLevel: MAX_LEVEL_M,
      predictedFlooded: p?.flooded ?? 0, eligible: p?.eligible ?? 0, floodedNow: this.floodedNow,
      spreadS: p?.durationS ?? 0, startS: this.startS, blockedRoads: blocked, highRiskRoads: risk,
      glofas: this.glofas, levelFor: LEVEL_FOR,
      note: 'Simplified model (SRTM elevation + OSM river + BFS spread), not a hydrological prediction.',
    };
  }

  // Junctions flooded at simNowS, for the map.
  floodedPoints(simNowS) {
    if (!this.plan) return [];
    const out = [];
    for (const [id, t] of this.plan.floodTimeS) if (t <= simNowS - this.startS) { const l = this.graph.getLocation(id); out.push([l.lat, l.lng]); }
    return out;
  }

  // ---------- GloFAS (Open-Meteo Flood API) ----------
  // The runtime copy (currentFile, git-ignored, rewritten by every successful refresh) wins; otherwise the
  // committed baseline (currentBaselineFile, never written) is the offline fallback.
  #loadCurrent() {
    for (const file of [this.currentFile, this.currentBaselineFile]) {
      try { if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* try the next */ }
    }
    return null;
  }

  async #get(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      this.calls?.tryRecord('openmeteo');
      const res = await this.fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'rescue-dispatch-course-demo' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      this.calls?.error('openmeteo');
      throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
    } finally { clearTimeout(t); }
  }

  async #history() {
    if (this.historyFile && fs.existsSync(this.historyFile)) {
      try { return JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch { /* refetch */ }
    }
    const end = new Date(this.now() - 400 * 86400000).toISOString().slice(0, 10);     // the archive lags; stop a year back
    const body = await this.#get(`${this.apiUrl}?latitude=${this.point.lat}&longitude=${this.point.lng}&daily=river_discharge&start_date=1984-01-01&end_date=${end}`);
    const values = body?.daily?.river_discharge ?? [];
    if (values.length < 365) throw new Error('history too short');
    const h = { fetchedAt: new Date(this.now()).toISOString(), from: body.daily.time[0], to: body.daily.time.at(-1), cell: { lat: body.latitude, lng: body.longitude }, values };
    if (this.historyFile) { try { fs.writeFileSync(this.historyFile, JSON.stringify(h)); } catch { /* memory only */ } }
    return h;
  }

  // Fetches today's discharge (past 3 + next 7 days), compares with the history, suggests a level.
  // Cached on disk for 6 h. If the API is unreachable the last result is kept and the slider still works.
  async refreshGlofas({ force = false } = {}) {
    if (!force && this.glofas?.fetchedAt && this.now() - Date.parse(this.glofas.fetchedAt) < CURRENT_TTL_MS) return this.glofas;
    try {
      const history = await this.#history();
      const body = await this.#get(`${this.apiUrl}?latitude=${this.point.lat}&longitude=${this.point.lng}&daily=river_discharge&past_days=3&forecast_days=7`);
      const days = (body?.daily?.time ?? []).map((t, i) => ({ date: t, m3s: body.daily.river_discharge[i] })).filter((d) => Number.isFinite(d.m3s));
      if (!days.length) throw new Error('no discharge values');
      const peak = days.reduce((a, b) => (b.m3s > a.m3s ? b : a));
      const c = classifyDischarge(peak.m3s, history.values);
      this.glofas = {
        ok: true, fetchedAt: new Date(this.now()).toISOString(), point: this.point, cell: { lat: body.latitude, lng: body.longitude },
        days, peak, ...c, suggestedLevel: LEVEL_FOR[c.status], historyFrom: history.from, historyTo: history.to,
        caveat: 'GloFAS is a coarse (~5 km) global model; it does not capture Khadakwasla dam releases, so the manual slider can override it.',
      };
      if (this.currentFile) { try { fs.writeFileSync(this.currentFile, JSON.stringify(this.glofas)); } catch { /* memory only */ } }
    } catch (e) {
      this.glofas = { ...(this.glofas ?? {}), ok: false, error: `Open-Meteo Flood API unavailable (${e.message}).${this.glofas?.fetchedAt ? ' Showing the last saved result.' : ''}`, triedAt: new Date(this.now()).toISOString() };
    }
    return this.glofas;
  }

  // Startup: take GloFAS's suggested level as the initial slider value (the slider can override it).
  applyGlofasSuggestion(simNowS) {
    if (this.glofas?.suggestedLevel != null && this.model) this.setLevel(this.glofas.suggestedLevel, simNowS, 'glofas');
  }
}
