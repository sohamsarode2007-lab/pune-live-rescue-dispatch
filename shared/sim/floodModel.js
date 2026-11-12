// Simplified Mutha river flood model (NOT a hydrological prediction).
//
// Inputs: junction elevations (SRTM), the river line (OSM) with SRTM elevations, a water level L in metres
// above the river surface (the "Khadakwasla dam release" slider, or the level suggested by GloFAS).
//
// 1. River profile: river points every STEP_M along each line; elevations smoothed to be non-increasing
//    downstream (OSM waterways are drawn in flow direction; SRTM over water is noisy).
// 2. Each junction gets its nearest river point (k-d tree): distance d and local river elevation r.
//    A junction is ELIGIBLE to flood if d <= BUFFER_M and elevation < r + L.
// 3. Spread: multi-source BFS over the road network (undirected, every road, water ignores closures) from
//    eligible junctions next to the river (d <= SEED_M), through eligible junctions only. A junction that
//    is low but not connected to the river through low ground stays dry. BFS hop k floods at k * HOP_S
//    simulated seconds, so the flood grows outward over sim time.
// 4. Road statuses at elapsed time t:
//      BLOCKED   - a road touching a junction flooded by t
//      HIGH_RISK - a road touching a junction that will flood later (water approaching), that is within
//                  FREEBOARD_M of the flood level, or that is next to a flooded junction
// O(V log V) setup (k-d tree queries), O(V + E) per level (BFS), O(E) per status evaluation.
import { KDTree, projectLatLng } from '../spatial/kdtree.js';
import { haversineM } from '../spatial/haversine.js';

// bufferM: how far from the river water can reach; seedM: junctions this close to the river flood first;
// freeboardM: band above the flood level counted as high-risk; hopS: simulated seconds per BFS hop.
// Chosen so a 12 m rise floods ~260 junctions over ~15 simulated minutes (illustrative, not calibrated).
export const FLOOD_DEFAULTS = Object.freeze({ bufferM: 1500, seedM: 100, freeboardM: 1, hopS: 90, stepM: 50 });
export const MAX_LEVEL_M = 12;

// Densified, smoothed river points [{ lat, lng, elev, river }].
export function riverProfile(rivers, riverElev, { pattern = /mutha/i, stepM = FLOOD_DEFAULTS.stepM } = {}) {
  const out = [];
  for (const r of rivers) {
    if (!pattern.test(r.name)) continue;
    r.lines.forEach((line, li) => {
      const elev = (riverElev?.[r.name]?.[li] ?? []).slice();
      // fill gaps from the previous known value, then enforce "never higher than upstream"
      let last = elev.find((e) => e != null) ?? 0;
      for (let i = 0; i < line.length; i++) { if (elev[i] == null) elev[i] = last; last = elev[i]; }
      for (let i = 1; i < line.length; i++) elev[i] = Math.min(elev[i], elev[i - 1]);
      for (let i = 0; i < line.length; i++) {
        out.push({ lat: line[i][0], lng: line[i][1], elev: elev[i], river: r.name });
        if (i + 1 < line.length) {
          const d = haversineM(line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
          const n = Math.floor(d / stepM);
          for (let k = 1; k <= n; k++) {
            const f = k / (n + 1);
            out.push({ lat: line[i][0] + f * (line[i + 1][0] - line[i][0]), lng: line[i][1] + f * (line[i + 1][1] - line[i][1]), elev: elev[i] + f * (elev[i + 1] - elev[i]), river: r.name });
          }
        }
      }
    });
  }
  return out;
}

export class FloodModel {
  // nodeElev: Map(nodeId -> metres). riverPoints: from riverProfile().
  constructor({ graph, nodeElev, riverPoints, ...opts }) {
    this.graph = graph;
    this.opts = { ...FLOOD_DEFAULTS, ...opts };
    this.ids = [...graph.locations.keys()];
    this.index = new Map(this.ids.map((id, i) => [id, i]));
    let sum = 0;
    for (const l of graph.locations.values()) sum += l.lat;
    const ref = sum / Math.max(1, graph.locations.size);
    const tree = new KDTree(riverPoints.map((p, i) => ({ ...projectLatLng(p.lat, p.lng, ref), i })));
    this.elev = new Float64Array(this.ids.length);
    this.riverDist = new Float64Array(this.ids.length).fill(Infinity);
    this.riverElev = new Float64Array(this.ids.length);
    this.ids.forEach((id, v) => {
      const loc = graph.getLocation(id);
      this.elev[v] = nodeElev.get(id) ?? Infinity;
      if (!riverPoints.length) return;
      const p = projectLatLng(loc.lat, loc.lng, ref);
      const hit = tree.nearest(p.x, p.y);
      this.riverDist[v] = hit.dist;
      this.riverElev[v] = riverPoints[hit.point.i].elev;
    });
    // undirected neighbours over every road (water does not care about one-way signs or closures)
    this.nbr = this.ids.map(() => []);
    this.roadsAt = this.ids.map(() => []);
    for (const r of graph.roads.values()) {
      const a = this.index.get(r.from), b = this.index.get(r.to);
      this.nbr[a].push(b); this.nbr[b].push(a);
      this.roadsAt[a].push(r.id); this.roadsAt[b].push(r.id);
    }
  }

  eligible(v, level) { return this.riverDist[v] <= this.opts.bufferM && this.elev[v] < this.riverElev[v] + level; }

  // Flood plan for water level `level` (m above the river): floodTimeS per flooded junction (BFS hop *
  // hopS), plus junctions at risk (within the freeboard band). level <= 0 means no flood.
  plan(level) {
    const n = this.ids.length;
    const hop = new Int32Array(n).fill(-1);
    const queue = [];
    if (level > 0) {
      for (let v = 0; v < n; v++) if (this.riverDist[v] <= this.opts.seedM && this.eligible(v, level)) { hop[v] = 0; queue.push(v); }
      for (let h = 0; h < queue.length; h++) {
        const v = queue[h];
        for (const w of this.nbr[v]) if (hop[w] === -1 && this.eligible(w, level)) { hop[w] = hop[v] + 1; queue.push(w); }
      }
    }
    const floodTimeS = new Map();
    let maxHop = 0;
    for (const v of queue) { floodTimeS.set(this.ids[v], hop[v] * this.opts.hopS); maxHop = Math.max(maxHop, hop[v]); }
    const risk = new Set();
    if (level > 0) {
      for (let v = 0; v < n; v++) {
        if (hop[v] === -1 && this.riverDist[v] <= this.opts.bufferM && this.elev[v] < this.riverElev[v] + level + this.opts.freeboardM) risk.add(this.ids[v]);
      }
    }
    const eligibleCount = level > 0 ? this.ids.filter((_, v) => this.eligible(v, level)).length : 0;
    return { level, floodTimeS, risk, eligible: eligibleCount, flooded: floodTimeS.size, durationS: maxHop * this.opts.hopS };
  }

  // Desired status of every affected road at `elapsedS` seconds after the level was set.
  roadStatuses(plan, elapsedS) {
    const out = new Map();
    const floodedNow = new Set();
    for (const [id, t] of plan.floodTimeS) if (t <= elapsedS) floodedNow.add(id);
    const mark = (id, s) => { if (out.get(id) !== 'BLOCKED') out.set(id, s); };
    for (const id of floodedNow) for (const r of this.roadsAt[this.index.get(id)]) out.set(r, 'BLOCKED');
    const riskNodes = new Set(plan.risk);
    for (const [id, t] of plan.floodTimeS) if (t > elapsedS) riskNodes.add(id);              // water approaching
    for (const id of floodedNow) for (const w of this.nbr[this.index.get(id)]) if (!floodedNow.has(this.ids[w])) riskNodes.add(this.ids[w]);
    for (const id of riskNodes) for (const r of this.roadsAt[this.index.get(id)]) mark(r, 'HIGH_RISK');
    return { statuses: out, floodedNow: floodedNow.size };
  }
}
