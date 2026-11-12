// Crowd road reports (Phase 5): "this road is flooded" from SOS phones.
// A road is closed only after QUORUM reports from DIFFERENT clients within WINDOW_MS (wall-clock time,
// because people report in real time whatever the simulation speed). One client counts once per road.
// Each report is snapped to the nearest road with nearest-edge matching (k-d tree over road shapes).
// Storage: Map(roadId -> Map(clientId -> time)): O(1) average per report, old entries pruned on access.
import { EdgeIndex } from '../../shared/spatial/edgeMatcher.js';

export const QUORUM = 3;
export const WINDOW_MS = 15 * 60 * 1000;
export const SNAP_M = 40;

export class CrowdReports {
  constructor({ store, now = () => Date.now(), quorum = QUORUM, windowMs = WINDOW_MS, snapM = SNAP_M }) {
    Object.assign(this, { store, graph: store.graph, now, quorum, windowMs, snapM });
    this.edges = new EdgeIndex(this.graph);
    this.byRoad = new Map();
  }

  #prune(roadId) {
    const m = this.byRoad.get(roadId);
    if (!m) return new Map();
    const t = this.now();
    for (const [c, at] of m) if (t - at > this.windowMs) m.delete(c);
    if (!m.size) this.byRoad.delete(roadId);
    return m;
  }

  // Returns { ok, roadId, name, count, needed, blocked, newlyBlocked } or { ok: false, error }.
  report({ lat, lng, clientId }) {
    if (!clientId) return { ok: false, error: 'NO_CLIENT' };
    const hit = this.edges.nearestEdge(lat, lng, this.snapM);
    if (!hit) return { ok: false, error: 'NO_ROAD_NEARBY' };
    const road = this.graph.getRoad(hit.roadId);
    const m = this.#prune(hit.roadId);
    m.set(clientId, this.now());                          // a repeat from the same phone only refreshes its time
    this.byRoad.set(hit.roadId, m);
    let newlyBlocked = false;
    if (m.size >= this.quorum && road.status !== 'BLOCKED') {
      this.store.setRoadStatus(road.id, 'BLOCKED', 'crowd');
      newlyBlocked = true;
    }
    return {
      ok: true, roadId: road.id, name: road.name || 'Unnamed road', distanceM: Math.round(hit.distanceM),
      count: Math.min(m.size, this.quorum), needed: this.quorum, blocked: road.status === 'BLOCKED', newlyBlocked,
    };
  }

  // Roads with reports still inside the window (for the dispatcher).
  pending() {
    const out = [];
    for (const id of [...this.byRoad.keys()]) {
      const m = this.#prune(id);
      if (!m.size) continue;
      const r = this.graph.getRoad(id);
      out.push({ roadId: id, name: r.name || 'Unnamed road', reports: m.size, needed: this.quorum, blocked: r.status === 'BLOCKED', geometry: this.graph.roadGeometry(id, r.from) });
    }
    return out.sort((a, b) => b.reports - a.reports);
  }

  clear() { this.byRoad.clear(); }
}
