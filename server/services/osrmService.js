// OSRM public demo server, used ONLY as a comparison baseline ("normal traffic" route). Never shown as ours.
// Usage policy: at most 1 request per second (requests are queued), responses cached in memory (1 h).
// If the server is unreachable the result says so ({ available: false, reason }) instead of throwing.
export const OSRM_URL = 'https://router.project-osrm.org';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

export class OsrmService {
  constructor({ calls, fetchImpl = globalThis.fetch, baseUrl = OSRM_URL, minIntervalMs = 1000, ttlMs = 3600_000, failTtlMs = 30_000, timeoutMs = 8000, now = () => Date.now() } = {}) {
    Object.assign(this, { calls, fetchImpl, baseUrl, minIntervalMs, ttlMs, failTtlMs, timeoutMs, now });
    this.cache = new Map();        // "lat,lng>lat,lng" -> { at, ttl, value }
    this.chain = Promise.resolve();
    this.lastRequestAt = -Infinity;
    this.requestTimes = [];        // for tests / diagnostics
  }

  async route(from, to) {
    const k = `${key(from)}>${key(to)}`;
    const hit = this.cache.get(k);
    if (hit && this.now() - hit.at < hit.ttl) {
      this.calls?.cacheHit('osrm');
      return { ...hit.value, cached: true };
    }
    // Serialise requests so two are never closer than minIntervalMs.
    const run = this.chain.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - this.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = this.now();
      this.requestTimes.push(this.lastRequestAt);
      return this.#fetch(from, to);
    });
    this.chain = run.catch(() => {});
    const value = await run;
    this.cache.set(k, { at: this.now(), ttl: value.available ? this.ttlMs : this.failTtlMs, value });
    return { ...value, cached: false };
  }

  async #fetch(from, to) {
    this.calls?.tryRecord('osrm');
    const url = `${this.baseUrl}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'rescue-dispatch-course-demo', Accept: 'application/json' } });
      if (!res.ok) { this.calls?.error('osrm'); return { available: false, reason: `OSRM answered HTTP ${res.status}` }; }
      const body = await res.json();
      const r = body?.routes?.[0];
      if (body?.code !== 'Ok' || !r) { this.calls?.error('osrm'); return { available: false, reason: `OSRM: ${body?.code ?? 'no route'}` }; }
      return {
        available: true, durationS: r.duration, distanceM: r.distance,
        geometry: (r.geometry?.coordinates ?? []).map(([lng, lat]) => [lat, lng]),
      };
    } catch (e) {
      this.calls?.error('osrm');
      return { available: false, reason: e.name === 'AbortError' ? 'OSRM did not answer in time' : 'OSRM server unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }
}
