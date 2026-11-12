// Network resilience (Phase 6 item 3, done before Phase 5):
//  - single points of failure: Tarjan bridges + articulation points (undirected), with what each cuts off
//  - trap zones: Tarjan SCC on the directed graph after closures
//  - river crossings: OSM bridge=* roads whose shape crosses the Mutha / Mula-Mutha, ranked by how much
//    response time worsens if that crossing alone is lost (multi-source Dijkstra from every station)
// Results are cached per graph version; closures and traffic changes trigger a (debounced) recompute.
import fs from 'node:fs';
import { bridgesAndArticulationPoints, trapZones } from '../../shared/graph/tarjan.js';
import { dijkstraMulti } from '../../shared/graph/dijkstra.js';
import { projectLatLng } from '../../shared/spatial/kdtree.js';
import { haversineM } from '../../shared/spatial/haversine.js';

export const CROSSING_RIVER = /mutha/i;        // Mutha and Mula-Mutha (the Mula alone is the bbox's north edge)
export const HOSPITAL_ACCESS_S = 8 * 60;       // "hospital access within 8 min"
const GROUP_M = 150;                           // intersection points closer than this are one physical crossing
const RECOMPUTE_DEBOUNCE_MS = 1500;
const r1 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 10) / 10);

// Proper segment intersection in a plane (touching counts).
function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    const t = d1 / (d1 - d2);
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }
  return null;
}

export function findRiverCrossings(graph, rivers, riverPattern = CROSSING_RIVER) {
  const ref = 18.52;
  const P = ([lat, lng]) => { const p = projectLatLng(lat, lng, ref); return [p.x, p.y]; };
  const lines = rivers.filter((r) => riverPattern.test(r.name)).flatMap((r) => r.lines.map((l) => ({ river: r.name, pts: l.map(P), raw: l })));
  const hits = [];
  for (const road of graph.roads.values()) {
    if (!road.bridge) continue;
    const g = graph.roadGeometry(road.id, road.from).map(P);
    let hit = null;
    for (let i = 0; i + 1 < g.length && !hit; i++) {
      for (const line of lines) {
        for (let j = 0; j + 1 < line.pts.length; j++) {
          const x = segmentsIntersect(g[i], g[i + 1], line.pts[j], line.pts[j + 1]);
          if (x) {
            // back to lat/lng by interpolating the river segment
            const [la, lb] = [line.raw[j], line.raw[j + 1]];
            const t = Math.hypot(x[0] - line.pts[j][0], x[1] - line.pts[j][1]) / (Math.hypot(line.pts[j + 1][0] - line.pts[j][0], line.pts[j + 1][1] - line.pts[j][1]) || 1);
            hit = { roadId: road.id, river: line.river, lat: la[0] + t * (lb[0] - la[0]), lng: la[1] + t * (lb[1] - la[1]) };
            break;
          }
        }
        if (hit) break;
      }
    }
    if (hit) hits.push(hit);
  }
  // group hits of one physical bridge (two carriageways, or a bridge split at a junction)
  const groups = [];
  for (const h of hits.sort((a, b) => a.lat - b.lat || a.lng - b.lng)) {
    const g = groups.find((x) => x.river === h.river && x.hits.some((y) => haversineM(y.lat, y.lng, h.lat, h.lng) <= GROUP_M));
    if (g) g.hits.push(h); else groups.push({ river: h.river, hits: [h] });
  }
  return groups.map((g) => {
    const roadIds = g.hits.map((h) => h.roadId).sort();
    const names = roadIds.map((id) => graph.getRoad(id).name).filter(Boolean);
    const counts = new Map(); names.forEach((n) => counts.set(n, (counts.get(n) ?? 0) + 1));
    const name = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'Unnamed bridge';
    return {
      river: g.river, name, roadIds,
      lat: g.hits.reduce((s, h) => s + h.lat, 0) / g.hits.length,
      lng: g.hits.reduce((s, h) => s + h.lng, 0) / g.hits.length,
    };
  }).sort((a, b) => a.lng - b.lng).map((c, i) => ({ id: `X${i + 1}`, ...c }));
}

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

export class NetworkService {
  constructor({ store, units = store.units, rivers = [], onChange = () => {} }) {
    this.store = store;
    this.graph = store.graph;
    this.onChange = onChange;
    this.rivers = rivers;
    this.facilityNodes = new Map();
    for (const f of store.facilities) {
      const m = this.facilityNodes.get(f.nodeId) ?? {};
      m[f.kind] = (m[f.kind] ?? 0) + 1;
      this.facilityNodes.set(f.nodeId, m);
    }
    this.facilityByNode = new Map();
    for (const f of store.facilities) this.facilityByNode.set(f.nodeId, [...(this.facilityByNode.get(f.nodeId) ?? []), f]);
    // Response time sources: every unit base (47), and the fire stations alone (fire trucks + rescue boats).
    // With 47 bases on both banks almost every junction's nearest base is on its own side, so losing one
    // bridge barely changes the all-bases figure; the fire-station figure is what ranks the crossings.
    this.stationNodes = [...new Set(units.map((u) => u.homeNodeId))];
    this.fireNodes = [...new Set(store.facilities.filter((f) => f.kind === 'fire_station').map((f) => f.nodeId))];
    // Hospital access is measured to MAJOR hospitals (where life-threatening cases go): with 189 hospitals
    // (many small clinics) every junction is within 8 min of some hospital.
    this.hospitalNodes = [...new Set(store.facilities.filter((f) => f.kind === 'hospital' && f.major).map((f) => f.nodeId))];
    this.crossingDefs = findRiverCrossings(this.graph, rivers);
    this.cache = { spof: null, scc: null };
    this.crossingState = { status: 'idle', version: -1, ranking: [], baseline: null };
    this.timer = null;
  }

  static fromFile(store, riverFile, opts = {}) {
    const rivers = riverFile && fs.existsSync(riverFile) ? JSON.parse(fs.readFileSync(riverFile, 'utf8')).rivers : [];
    return new NetworkService({ store, rivers, ...opts });
  }

  // ---------- Tarjan ----------
  spof() {
    if (this.cache.spof?.version === this.graph.version) return this.cache.spof.value;
    const t0 = performance.now();
    const r = bridgesAndArticulationPoints(this.graph, { facilityNodes: this.facilityNodes });
    const loc = (id) => this.graph.getLocation(id);
    const bridges = r.bridges.map((b) => {
      const road = this.graph.getRoad(b.roadId);
      return { ...b, name: road.name, highway: road.highway, osmBridge: road.bridge, geometry: this.graph.roadGeometry(b.roadId, road.from) };
    }).sort((a, b) => b.cutJunctions - a.cutJunctions);
    const aps = r.articulationPoints.map((a) => ({ ...a, lat: loc(a.nodeId).lat, lng: loc(a.nodeId).lng })).sort((a, b) => b.cutJunctions - a.cutJunctions);
    const value = {
      bridges, articulationPoints: aps, components: r.components,
      counts: {
        bridges: bridges.length, criticalBridges: bridges.filter((b) => b.critical).length,
        articulationPoints: aps.length, criticalArticulationPoints: aps.filter((a) => a.critical).length,
      },
      ms: Math.round(performance.now() - t0),
    };
    this.cache.spof = { version: this.graph.version, value };
    return value;
  }

  scc() {
    if (this.cache.scc?.version === this.graph.version) return this.cache.scc.value;
    const t0 = performance.now();
    const r = trapZones(this.graph, { facilityNodes: this.facilityNodes });
    const zones = r.zones.map((z) => ({
      ...z,
      facilityList: z.nodeIds.flatMap((id) => (this.facilityByNode.get(id) ?? []).map((f) => ({ id: f.id, name: f.name, kind: f.kind }))),
      points: z.nodeIds.slice(0, 400).map((id) => { const l = this.graph.getLocation(id); return [l.lat, l.lng]; }),
      nodeIds: undefined,
    }));
    const value = { components: r.components, mainSize: r.mainSize ?? this.graph.locations.size, zones, ms: Math.round(performance.now() - t0) };
    this.cache.scc = { version: this.graph.version, value };
    return value;
  }

  // ---------- crossing importance ----------
  // One multi-source Dijkstra per measure: forward from the sources (response time), reverse to the
  // major hospitals (time to hospital).
  #measure(excludeRoadIds = null) {
    return {
      fire: dijkstraMulti(this.graph, this.fireNodes, { excludeRoadIds }).dist,
      all: dijkstraMulti(this.graph, this.stationNodes, { excludeRoadIds }).dist,
      hosp: dijkstraMulti(this.graph, this.hospitalNodes, { reverse: true, excludeRoadIds }).dist,
    };
  }

  // Compare a measure with the baseline over the junctions that count (not the bridge deck itself).
  static #delta(d0map, d1map, nodes) {
    let sum0 = 0, sum1 = 0, both = 0, worst0 = 0, worst1 = 0, maxJunction = 0, lost = 0;
    for (const v of nodes) {
      const d0 = d0map.get(v), d1 = d1map.get(v);
      if (d0 !== undefined) worst0 = Math.max(worst0, d0);
      if (d1 !== undefined) worst1 = Math.max(worst1, d1);
      if (d0 !== undefined && d1 !== undefined) { sum0 += d0; sum1 += d1; both++; maxJunction = Math.max(maxJunction, d1 - d0); }
      else if (d0 !== undefined) lost++;
    }
    return { avgIncreaseS: r1(both ? (sum1 - sum0) / both : 0), worstIncreaseS: r1(worst1 - worst0), maxJunctionIncreaseS: r1(maxJunction), newlyUnreachable: lost };
  }

  // Baseline + every crossing removed alone. Yields to the event loop between crossings (~60 ms each).
  async rankCrossings() {
    const version = this.graph.version;
    this.crossingState = { ...this.crossingState, status: 'computing' };
    const t0 = performance.now();
    const base = this.#measure();
    const all = [...this.graph.locations.keys()];
    const stats = (m) => { const v = [...m.values()]; return { avgS: r1(avg(v)), worstS: r1(Math.max(...v)), reachable: m.size }; };
    const baseline = {
      fire: stats(base.fire), all: stats(base.all), junctions: all.length,
      majorHospitalWithin8: all.filter((v) => (base.hosp.get(v) ?? Infinity) <= HOSPITAL_ACCESS_S).length,
      fireStations: this.fireNodes.length, stations: this.stationNodes.length, majorHospitals: this.hospitalNodes.length,
    };
    const ranking = [];
    for (const c of this.crossingDefs) {
      await new Promise((r) => setImmediate(r));
      if (this.graph.version !== version) return this.#schedule();     // network changed meanwhile: start again
      const ex = new Set(c.roadIds);
      // junctions whose every road belongs to this crossing are ON the bridge: not counted
      const onDeck = new Set(c.roadIds.flatMap((id) => { const r = this.graph.getRoad(id); return [r.from, r.to]; })
        .filter((v) => this.graph.adjacency.get(v).every((e) => ex.has(e.roadId)) && this.graph.inNeighbors(v).every((e) => ex.has(e.roadId))));
      const nodes = all.filter((v) => !onDeck.has(v));
      const m = this.#measure(ex);
      let lost8 = 0;
      for (const v of nodes) if ((base.hosp.get(v) ?? Infinity) <= HOSPITAL_ACCESS_S && (m.hosp.get(v) ?? Infinity) > HOSPITAL_ACCESS_S) lost8++;
      const fire = NetworkService.#delta(base.fire, m.fire, nodes);
      const allBases = NetworkService.#delta(base.all, m.all, nodes);
      ranking.push({
        ...c, closed: c.roadIds.every((id) => this.graph.getRoad(id).status === 'BLOCKED'),
        fire, allBases, lostMajorHospitalWithin8: lost8,
        // headline figures (fire stations: where fire trucks and rescue boats are based)
        avgIncreaseS: fire.avgIncreaseS, worstIncreaseS: fire.worstIncreaseS,
      });
    }
    ranking.sort((a, b) => b.fire.avgIncreaseS - a.fire.avgIncreaseS || b.fire.worstIncreaseS - a.fire.worstIncreaseS
      || b.lostMajorHospitalWithin8 - a.lostMajorHospitalWithin8 || a.id.localeCompare(b.id));
    ranking.forEach((c, i) => { c.rank = i + 1; });
    this.crossingState = { status: 'ready', version, ranking, baseline, ms: Math.round(performance.now() - t0) };
    this.onChange({ type: 'crossings', summary: this.summary() });
    return this.crossingState;
  }

  #schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.rankCrossings().catch((e) => console.error('crossing ranking failed:', e)); }, RECOMPUTE_DEBOUNCE_MS);
    return null;
  }

  // Call after any closure / reopening / traffic change: trap zones are recomputed now, the crossing
  // ranking shortly after (debounced, because a flood closes many roads in one go).
  roadsChanged() {
    this.onChange({ type: 'scc', summary: this.summary() });
    this.#schedule();
  }

  crossings() { return this.crossingState; }

  summary() {
    const scc = this.scc();
    return {
      version: this.graph.version,
      trapZones: scc.zones.map(({ points, ...z }) => z),
      sccComponents: scc.components,
      crossings: { status: this.crossingState.status, stale: this.crossingState.version !== this.graph.version, count: this.crossingDefs.length },
    };
  }
}
