// Counts calls to external services per UTC day and enforces daily caps (persisted to disk, so a server
// restart cannot reset the TomTom budget). PLAN.md: TomTom max 200 calls/day.
import fs from 'node:fs';

export const DAILY_CAPS = Object.freeze({ tomtom: 200 });

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export class ExternalCalls {
  constructor({ file = null, now = () => Date.now(), caps = DAILY_CAPS, onChange = () => {} } = {}) {
    this.file = file;
    this.now = now;
    this.caps = caps;
    this.onChange = onChange;
    this.state = { date: utcDay(now()), counts: {}, cacheHits: {}, errors: {} };
    if (file && fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.date === this.state.date) this.state = { ...this.state, ...saved };
      } catch { /* corrupt file: start from zero for today */ }
    }
  }

  #rollover() {
    const d = utcDay(this.now());
    if (d !== this.state.date) this.state = { date: d, counts: {}, cacheHits: {}, errors: {} };
  }

  #save() {
    if (this.file) {
      try { fs.writeFileSync(this.file, JSON.stringify(this.state)); } catch { /* read-only disk: keep in memory */ }
    }
    this.onChange(this.view());
  }

  count(provider) { this.#rollover(); return this.state.counts[provider] ?? 0; }
  cap(provider) { return this.caps[provider] ?? Infinity; }
  remaining(provider) { return Math.max(0, this.cap(provider) - this.count(provider)); }

  // Reserves one call. Returns false (and records nothing) if today's cap is reached.
  tryRecord(provider) {
    this.#rollover();
    if (this.remaining(provider) <= 0) return false;
    this.state.counts[provider] = this.count(provider) + 1;
    this.#save();
    return true;
  }

  cacheHit(provider) { this.#rollover(); this.state.cacheHits[provider] = (this.state.cacheHits[provider] ?? 0) + 1; this.#save(); }
  error(provider) { this.#rollover(); this.state.errors[provider] = (this.state.errors[provider] ?? 0) + 1; this.#save(); }

  view() {
    this.#rollover();
    const out = { date: this.state.date };
    for (const p of new Set(['tomtom', 'osrm', ...Object.keys(this.state.counts)])) {
      out[p] = { calls: this.count(p), cap: Number.isFinite(this.cap(p)) ? this.cap(p) : null, cacheHits: this.state.cacheHits[p] ?? 0, errors: this.state.errors[p] ?? 0 };
    }
    return out;
  }
}
