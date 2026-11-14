// Planning tools (PLAN.md Phase 6 items 1, 2, 4).
//
// 1. Coverage isochrones: multi-source Dijkstra from the fire stations (and separately from every ambulance
//    base) on the CURRENT network; every road gets a response-time band (<5, 5-8, 8-12, >12 min,
//    unreachable, closed) and we report the % of road length reached within 8 min. Recomputed whenever
//    roads close or reopen (the flood), so coverage visibly shrinks as the water rises.
// 2. New station placement: greedy k-center (Gonzalez farthest-first candidates + best-improvement pick) for
//    "normal" (every road open) and for "10 m flood" (roads the fully spread 10 m flood would block).
// 3. Evacuation feasibility: Edmonds-Karp max flow from the flood-affected junctions (people) over the road
//    network (capacity by road type, HIGH_RISK at 50 %) to shelters (capacity) -> how many people can be
//    evacuated, and the min-cut bottleneck roads. Normal vs 10 m flood.
import { dijkstraAll } from '../../shared/graph/dijkstra.js';
import { farthestFirst, greedyKCenter } from '../../shared/graph/kcenter.js';
import { FlowNetwork } from '../../shared/flow/edmondsKarp.js';

export const BANDS = Object.freeze([
  { key: 0, label: '< 5 min', maxS: 300, color: '#22c55e' },
  { key: 1, label: '5–8 min', maxS: 480, color: '#a3e635' },
  { key: 2, label: '8–12 min', maxS: 720, color: '#f59e0b' },
  { key: 3, label: '> 12 min', maxS: Infinity, color: '#ef4444' },
  { key: 4, label: 'unreachable', color: '#7c3aed' },
  { key: 5, label: 'closed', color: '#475569' },
]);
export const COVER_S = 480;

// PLAN.md capacities (vehicles / hour) by road type; HIGH_RISK roads at 50 %.
export const VEHICLES_PER_HOUR = Object.freeze({
  motorway: 2000, motorway_link: 2000, trunk: 2000, trunk_link: 2000,
  primary: 1200, primary_link: 1200, secondary: 1200, secondary_link: 1200,
  tertiary: 400, tertiary_link: 400, residential: 400, unclassified: 400, living_street: 400, service: 400, road: 400,
});
// Assumptions to turn vehicles/hour into people (documented, simulated):
export const PEOPLE_PER_VEHICLE = 4;          // evacuees per vehicle
export const EVACUATION_WINDOW_H = 1;         // one hour of evacuation
// People to move per affected junction: central Pune's riverside wards hold roughly 30,000-40,000 people
// per km2 with ~120-200 junctions per km2, i.e. ~200-300 people per junction (simulated estimate).
export const PEOPLE_PER_JUNCTION = 250;
export const EVAC_LEVEL_M = 10;
export const PLACEMENT_CANDIDATES = 120;

const r1 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 10) / 10);
const peopleCapacity = (road) => Math.round((VEHICLES_PER_HOUR[road.highway] ?? 400) * PEOPLE_PER_VEHICLE * EVACUATION_WINDOW_H * (road.status === 'HIGH_RISK' ? 0.5 : 1));

export class PlanningService {
  constructor({ store, flood }) {
    this.store = store;
    this.graph = store.graph;
    this.flood = flood;
    this.fireNodes = [...new Set(store.facilities.filter((f) => f.kind === 'fire_station').map((f) => f.nodeId))];
    this.ambulanceNodes = [...new Set(store.units.filter((u) => u.type === 'ambulance').map((u) => u.homeNodeId))];
    this.roadIds = [...this.graph.roads.keys()];
    this.totalLengthM = this.roadIds.reduce((s, id) => s + this.graph.getRoad(id).lengthM, 0);
    this.cache = new Map();
    this.history = [];
    this.placementResult = null;
    this.evacuationResult = null;
  }

  // ---------- 1. coverage ----------
  // Band per road (string, one char per road in this.roadIds order) + summary. excludeRoadIds: extra closures.
  #coverage(sources, excludeRoadIds = null) {
    const d = dijkstraAll(this.graph, sources, { excludeRoadIds }).dist;
    let covered = 0, sum = 0, n = 0, worst = 0;
    const lengthByBand = [0, 0, 0, 0, 0, 0];
    const chars = new Array(this.roadIds.length);
    this.roadIds.forEach((id, i) => {
      const r = this.graph.getRoad(id);
      let band;
      if (r.status === 'BLOCKED' || excludeRoadIds?.has(id)) band = 5;
      else {
        const a = d.get(r.from), b = r.oneWay ? undefined : d.get(r.to);
        const t = a === undefined ? b : b === undefined ? a : Math.min(a, b);   // reached when its entry is reached
        band = t === undefined ? 4 : t < 300 ? 0 : t < COVER_S ? 1 : t < 720 ? 2 : 3;
        if (t !== undefined && t <= COVER_S) covered += r.lengthM;
      }
      lengthByBand[band] += r.lengthM;
      chars[i] = String(band);
    });
    for (const v of d.values()) { sum += v; n++; worst = Math.max(worst, v); }
    return {
      bands: chars.join(''),
      pct8: r1((100 * covered) / this.totalLengthM), avgS: r1(n ? sum / n : 0), worstS: r1(worst),
      unreachableJunctions: this.graph.locations.size - d.size,
      kmByBand: lengthByBand.map((m) => r1(m / 1000)),
    };
  }

  coverage(kind = 'fire') {
    const key = `cov:${kind}:${this.graph.version}`;
    if (!this.cache.has(key)) {
      this.cache.set(key, this.#coverage(kind === 'fire' ? this.fireNodes : this.ambulanceNodes));
      if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(key);
  }

  // Summary for both source sets; appended to the history (for the "coverage shrinking" chart).
  coverageSummary(simS = null) {
    const fire = this.coverage('fire'), amb = this.coverage('ambulance');
    const s = {
      version: this.graph.version,
      fire: { pct8: fire.pct8, avgS: fire.avgS, worstS: fire.worstS, unreachableJunctions: fire.unreachableJunctions, stations: this.fireNodes.length },
      ambulance: { pct8: amb.pct8, avgS: amb.avgS, worstS: amb.worstS, unreachableJunctions: amb.unreachableJunctions, stations: this.ambulanceNodes.length },
    };
    if (simS != null) {
      const last = this.history.at(-1);
      if (!last || last.fire !== s.fire.pct8 || last.ambulance !== s.ambulance.pct8) this.history.push({ simS: r1(simS), fire: s.fire.pct8, ambulance: s.ambulance.pct8 });
      if (this.history.length > 200) this.history.shift();
    }
    return { ...s, history: this.history };
  }

  clearHistory() { this.history = []; }

  // Road geometries in roadIds order, sent once so coverage updates are just a band string.
  geometry() {
    return { ids: this.roadIds, lines: this.roadIds.map((id) => this.graph.roadGeometry(id, this.graph.getRoad(id).from).map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5])) };
  }

  // Runs fn with the road statuses of a scenario applied to the graph (every other road OPEN), then puts
  // every status back exactly. Synchronous on purpose: nothing else can run while the graph is changed.
  // graph.version is restored too: the net change is nothing, and a bumped version would make every other
  // analysis think the network changed (e.g. the crossing ranking, running concurrently at startup, would
  // abandon its run). fn must not cache anything by graph.version (#placementNow doesn't).
  #withStatuses({ blocked = new Set(), highRisk = new Set() }, fn) {
    const version = this.graph.version;
    const saved = [];
    for (const r of this.graph.roads.values()) {
      const want = blocked.has(r.id) ? 'BLOCKED' : highRisk.has(r.id) ? 'HIGH_RISK' : 'OPEN';
      if (r.status !== want) { saved.push([r.id, r.status, r.riskLevel]); this.graph.setRoadStatus(r.id, want); }
    }
    try { return fn(); } finally {
      for (const [id, s, lvl] of saved) this.graph.setRoadStatus(id, s, lvl);
      this.graph.version = version;
    }
  }

  // ---------- 2. station placement ----------
  #placementFor(scenario) {
    return this.#withStatuses(scenario, () => this.#placementNow());
  }

  #placementNow() {
    const ids = [...this.graph.locations.keys()];
    // candidates: Gonzalez farthest-first picks (spread over the worst-served areas) + the worst-served junctions
    const ff = farthestFirst(this.graph, this.fireNodes, Math.round(PLACEMENT_CANDIDATES * 2 / 3));
    const d = dijkstraAll(this.graph, this.fireNodes).dist;
    const worst = ids.filter((id) => d.has(id)).sort((a, b) => d.get(b) - d.get(a)).slice(0, PLACEMENT_CANDIDATES - ff.picks.length);
    const candidates = [...new Set([...ff.picks.map((p) => p.nodeId), ...worst])];
    const g = greedyKCenter(this.graph, this.fireNodes, 1, candidates);
    const pick = g.chosen[0];
    const covBefore = this.#coverage(this.fireNodes);
    const covAfter = this.#coverage([...this.fireNodes, pick.nodeId]);
    const loc = this.graph.getLocation(pick.nodeId);
    // a road name for the label: this junction's roads, else its neighbours' roads (2 hops)
    const named = (id) => this.graph.adjacency.get(id).map((e) => this.graph.getRoad(e.roadId)).find((r) => r.name);
    const road = named(pick.nodeId) ?? this.graph.adjacency.get(pick.nodeId).map((e) => named(e.to)).find(Boolean);
    const gonzalez = ff.picks[0];
    return {
      candidates: candidates.length,
      before: { worstS: r1(g.before.worstS), avgS: r1(g.before.avgS), pct8: covBefore.pct8, unreachable: g.before.unreachable },
      suggestion: { nodeId: pick.nodeId, lat: loc.lat, lng: loc.lng, near: road?.name ?? null, worstS: r1(pick.worstS), avgS: r1(pick.avgS), pct8: covAfter.pct8 },
      farthestJunction: { nodeId: gonzalez.nodeId, responseS: r1(gonzalez.radiusBeforeS), lat: this.graph.getLocation(gonzalez.nodeId).lat, lng: this.graph.getLocation(gonzalez.nodeId).lng },
    };
  }

  // "Normal" = every road open; "10 m flood" = the road statuses of the fully spread 10 m flood (BLOCKED and
  // HIGH_RISK with its penalty), exactly as the live flood would set them. Computed in the background
  // (~2 x 120 Dijkstra runs, a few seconds), then cached.
  async computePlacement() {
    const t0 = performance.now();
    const normal = this.#placementFor({});
    await new Promise((r) => setImmediate(r));
    const f = this.flood?.model ? this.flood.finalStatuses(EVAC_LEVEL_M) : { blocked: new Set(), highRisk: new Set() };
    const flood = this.#placementFor(f);
    this.placementResult = {
      normal, flood: { ...flood, level: EVAC_LEVEL_M, closedRoads: f.blocked.size, highRiskRoads: f.highRisk.size },
      sameSuggestion: normal.suggestion.nodeId === flood.suggestion.nodeId, ms: Math.round(performance.now() - t0),
    };
    return this.placementResult;
  }

  // ---------- 3. evacuation (Edmonds-Karp) ----------
  // scenario: { blocked: Set(roadId), highRisk: Set(roadId) } closures to assume on top of the open network.
  evacuate({ blocked = new Set(), highRisk = new Set() } = {}, affected) {
    const t0 = performance.now();
    const ids = [...this.graph.locations.keys()];
    const index = new Map(ids.map((id, i) => [id, i]));
    const S = ids.length, T = ids.length + 1;
    const net = new FlowNetwork(ids.length + 2);
    let totalPeople = 0, stranded = 0;
    const isOpen = (r) => !blocked.has(r.id);
    const roadsAt = (id) => [...this.graph.adjacency.get(id), ...this.graph.inNeighbors(id)].map((e) => this.graph.getRoad(e.roadId));
    for (const id of affected) {
      net.addEdge(S, index.get(id), PEOPLE_PER_JUNCTION, { kind: 'supply', nodeId: id });
      totalPeople += PEOPLE_PER_JUNCTION;
      if (!roadsAt(id).some(isOpen)) stranded += PEOPLE_PER_JUNCTION;   // every road there is under water: boats only
    }
    for (const r of this.graph.roads.values()) {
      if (!isOpen(r)) continue;
      // scenario roads are judged by the scenario (open / high-risk), not by the live status
      const cap = Math.round(peopleCapacity({ highway: r.highway, status: highRisk.has(r.id) ? 'HIGH_RISK' : 'OPEN' }));
      net.addEdge(index.get(r.from), index.get(r.to), cap, { kind: 'road', roadId: r.id });
      if (!r.oneWay) net.addEdge(index.get(r.to), index.get(r.from), cap, { kind: 'road', roadId: r.id });
    }
    const shelters = this.store.facilities.filter((f) => f.kind === 'shelter' && !affected.has(f.nodeId));
    const capAt = new Map();
    for (const s of shelters) capAt.set(s.nodeId, (capAt.get(s.nodeId) ?? 0) + s.capacity);
    for (const [nodeId, cap] of capAt) net.addEdge(index.get(nodeId), T, cap, { kind: 'shelter', nodeId });
    const { flow, augmentations } = net.maxFlow(S, T);
    const cut = net.minCut(S);
    const byRoad = new Map();
    let shelterCut = 0, supplyCut = 0;
    for (const e of cut.edges) {
      const l = net.label[e];
      if (l?.kind === 'road') byRoad.set(l.roadId, (byRoad.get(l.roadId) ?? 0) + net.orig[e]);
      else if (l?.kind === 'shelter') shelterCut += net.orig[e];
      else if (l?.kind === 'supply') supplyCut += net.orig[e];
    }
    const bottlenecks = [...byRoad].map(([roadId, capacity]) => {
      const r = this.graph.getRoad(roadId);
      return { roadId, name: r.name || 'Unnamed road', highway: r.highway, capacity, geometry: this.graph.roadGeometry(roadId, r.from) };
    }).sort((a, b) => b.capacity - a.capacity);
    return {
      totalPeople, evacuable: flow, pct: r1((100 * flow) / totalPeople), stranded,
      cutCapacity: cut.capacity, cut: { roads: bottlenecks.reduce((s, b) => s + b.capacity, 0), shelters: shelterCut, supply: supplyCut },
      bottlenecks, shelters: shelters.length, shelterCapacity: [...capAt.values()].reduce((a, b) => a + b, 0),
      augmentations, ms: Math.round(performance.now() - t0),
    };
  }

  // Normal vs 10 m flood, for the same affected area (junctions the 10 m flood floods or puts at risk).
  async computeEvacuation() {
    if (!this.flood?.model) return null;
    const f = this.flood.finalStatuses(EVAC_LEVEL_M);
    const affected = new Set([...f.flooded, ...f.risk]);
    const normal = this.evacuate({}, affected);
    await new Promise((r) => setImmediate(r));
    const flooded = this.evacuate({ blocked: f.blocked, highRisk: f.highRisk }, affected);
    this.evacuationResult = {
      level: EVAC_LEVEL_M, affectedJunctions: affected.size,
      affectedPoints: [...affected].map((id) => { const l = this.graph.getLocation(id); return [l.lat, l.lng]; }),
      assumptions: { peoplePerJunction: PEOPLE_PER_JUNCTION, peoplePerVehicle: PEOPLE_PER_VEHICLE, windowH: EVACUATION_WINDOW_H, vehiclesPerHour: VEHICLES_PER_HOUR, highRiskFactor: 0.5 },
      normal, flood: flooded,
    };
    return this.evacuationResult;
  }
}
