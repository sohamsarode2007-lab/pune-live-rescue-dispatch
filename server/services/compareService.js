// "Our engine vs OSRM": our traffic-aware A* route next to OSRM's route for the same two junctions.
// OSRM = normal traffic (its own speed profile); ours = live traffic when a snapshot is applied.
// Every comparison where OSRM answered is appended to a JSONL log for the report's average difference.
import fs from 'node:fs';

export class CompareService {
  constructor({ store, osrm, traffic, logFile = null, now = () => Date.now() }) {
    Object.assign(this, { store, osrm, traffic, logFile, now });
    this.entries = [];
    if (logFile && fs.existsSync(logFile)) {
      for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
        try { if (line.trim()) this.entries.push(JSON.parse(line)); } catch { /* skip a broken line */ }
      }
    }
  }

  async compare(from, to) {
    const res = this.store.route(from, to, ['astar']);
    const a = res.results.astar;
    // Both engines get exactly the same start and end: the snapped junctions.
    const start = { lat: res.from.lat, lng: res.from.lng }, end = { lat: res.to.lat, lng: res.to.lng };
    const freeFlowS = a.reachable ? a.roadIds.reduce((s, id) => s + this.store.graph.getRoad(id).baseTimeS, 0) : null;
    const ours = {
      reachable: a.reachable, etaS: a.totalCostS, drivingS: a.totalTimeS, freeFlowS, lengthM: a.totalLengthM,
      geometry: a.geometry, trafficMode: this.traffic?.mode ?? 'free-flow', trafficAt: this.traffic?.snapshot?.fetchedAt ?? null,
    };
    const osrm = await this.osrm.route(start, end);
    const diffPct = osrm.available && ours.reachable && osrm.durationS > 0 ? ((ours.etaS - osrm.durationS) / osrm.durationS) * 100 : null;
    const result = { from: res.from, to: res.to, ours, osrm, diffPct };
    if (diffPct != null && !osrm.cached) this.#log(result);
    return { ...result, summary: this.summary() };
  }

  #log(r) {
    const entry = {
      at: new Date(this.now()).toISOString(), from: r.from.nodeId, to: r.to.nodeId,
      oursS: round1(r.ours.etaS), oursFreeFlowS: round1(r.ours.freeFlowS), osrmS: round1(r.osrm.durationS),
      oursM: Math.round(r.ours.lengthM), osrmM: Math.round(r.osrm.distanceM), diffPct: round1(r.diffPct),
      trafficMode: r.ours.trafficMode, trafficAt: r.ours.trafficAt,
    };
    this.entries.push(entry);
    if (this.logFile) { try { fs.appendFileSync(this.logFile, `${JSON.stringify(entry)}\n`); } catch { /* keep in memory */ } }
  }

  // Average ETA difference over all logged comparisons (split by traffic mode).
  summary() {
    const by = (list) => (list.length ? {
      n: list.length,
      meanDiffPct: round1(list.reduce((s, e) => s + e.diffPct, 0) / list.length),
      meanAbsDiffPct: round1(list.reduce((s, e) => s + Math.abs(e.diffPct), 0) / list.length),
    } : { n: 0 });
    return { all: by(this.entries), live: by(this.entries.filter((e) => e.trafficMode === 'live')), freeFlow: by(this.entries.filter((e) => e.trafficMode !== 'live')) };
  }
}

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
