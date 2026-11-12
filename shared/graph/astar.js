import { MinHeap } from './MinHeap.js';
import { buildRoute, unreachableRoute } from './dijkstra.js';
import { haversineM } from '../spatial/haversine.js';

// A* search: Dijkstra ordered by f(v) = g(v) + h(v), where
//   g(v) = best known cost (seconds) from the source,
//   h(v) = straight-line (haversine) distance from v to the target / V_MAX.
//
// Why h is admissible AND consistent (so the first time the target is settled its cost is optimal):
//   V_MAX = max over all roads of haversine(from, to) / baseTimeS.
//   For any traversable road u->v:  cost(u,v) >= baseTimeS >= haversine(u,v) / V_MAX
//   (trafficFactor >= 1 and riskPenaltyS >= 0). By the triangle inequality of great-circle distance,
//   h(u) <= haversine(u,v)/V_MAX + h(v) <= cost(u,v) + h(v).
// V_MAX is derived from the data rather than assumed, so it holds even if a road's tagged speed is odd.
// Worst case O((V + E) log V), same as Dijkstra; in practice it settles far fewer vertices.

export function maxHeuristicSpeedMps(graph) {
  if (graph._maxSpeedMps != null) return graph._maxSpeedMps;
  let v = 0;
  for (const r of graph.roads.values()) {
    const a = graph.getLocation(r.from), b = graph.getLocation(r.to);
    const d = haversineM(a.lat, a.lng, b.lat, b.lng);
    if (d === 0) continue;
    if (r.baseTimeS <= 0) { v = Infinity; break; }        // zero-time road: only h = 0 is safe
    v = Math.max(v, d / r.baseTimeS);
  }
  graph._maxSpeedMps = v;
  return v;
}

export function astar(graph, sourceId, destId, options = {}) {
  if (!graph.hasLocation(sourceId)) throw new Error(`Unknown source location: ${sourceId}`);
  if (!graph.hasLocation(destId)) throw new Error(`Unknown destination location: ${destId}`);
  const target = graph.getLocation(destId);
  const vmax = maxHeuristicSpeedMps(graph);
  const h = (id) => {
    if (!(vmax > 0) || vmax === Infinity) return 0;
    const p = graph.getLocation(id);
    return haversineM(p.lat, p.lng, target.lat, target.lng) / vmax;
  };

  const g = new Map([[sourceId, 0]]);
  const prev = new Map();
  const done = new Set();
  const stats = { heapInsertions: 1, heapExtractions: 0, staleSkipped: 0, relaxations: 0 };
  // Ties on f are broken by larger g (closer to the target), then by ID for determinism.
  const heap = new MinHeap((a, b) => a.f - b.f || b.g - a.g || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  heap.push({ id: sourceId, g: 0, f: h(sourceId) });

  while (!heap.isEmpty()) {
    const { id: u, g: gu } = heap.pop();
    stats.heapExtractions++;
    if (done.has(u)) { stats.staleSkipped++; continue; }
    done.add(u);
    if (u === destId) break;
    for (const e of graph.neighbors(u)) {
      if (done.has(e.to) || options.excludeRoadIds?.has(e.roadId)) continue;
      const alt = gu + e.cost;
      if (!g.has(e.to) || alt < g.get(e.to)) {
        g.set(e.to, alt);
        prev.set(e.to, { from: u, roadId: e.roadId });
        heap.push({ id: e.to, g: alt, f: alt + h(e.to) });
        stats.heapInsertions++;
        stats.relaxations++;
      }
    }
  }
  stats.settled = done.size;
  const route = done.has(destId) ? buildRoute(graph, sourceId, destId, prev) : unreachableRoute(sourceId, destId);
  return { ...route, stats };
}
