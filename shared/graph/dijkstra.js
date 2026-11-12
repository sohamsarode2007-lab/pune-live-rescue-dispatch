import { MinHeap } from './MinHeap.js';

// Dijkstra with adjacency list + binary min-heap (lazy deletion: stale heap entries are skipped).
// Minimises total effective cost = sum(baseTimeS * trafficFactor + riskPenaltyS), in seconds.
// BLOCKED roads are excluded by graph.neighbors(). All traversable weights are >= 0, which Dijkstra requires.
// Time O((V + E) log V).
// options.excludeRoadIds: Set of road IDs to treat as unavailable for this run only (graph is not modified).
// options.target: OPTIONAL early stop as soon as this vertex is settled (its distance is then final).
//   Without a target the run is a full single-source search: dist has every reachable vertex.
// options.reverse: search the reversed graph, so dist(v) = cost of the best route v -> sourceId and
//   prev(v) = { from: next vertex towards sourceId, roadId }. One run gives every vertex's cost TO a target.
export function dijkstraAll(graph, sourceId, options = {}) {
  if (!graph.hasLocation(sourceId)) throw new Error(`Unknown source location: ${sourceId}`);
  const dist = new Map();      // id -> best known effective cost
  const prev = new Map();      // id -> { from, roadId }
  const done = new Set();
  const stats = { heapInsertions: 0, heapExtractions: 0, staleSkipped: 0, relaxations: 0 };
  const heap = new MinHeap((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  dist.set(sourceId, 0);
  heap.push({ id: sourceId, cost: 0 });
  stats.heapInsertions++;

  while (!heap.isEmpty()) {
    const { id: u, cost } = heap.pop();
    stats.heapExtractions++;
    if (done.has(u)) { stats.staleSkipped++; continue; }   // stale entry
    done.add(u);
    if (options.target !== undefined && u === options.target) break;   // optional early exit
    for (const e of (options.reverse ? graph.inNeighbors(u) : graph.neighbors(u))) {
      if (done.has(e.to) || options.excludeRoadIds?.has(e.roadId)) continue;
      const alt = cost + e.cost;
      if (!dist.has(e.to) || alt < dist.get(e.to)) {
        dist.set(e.to, alt);
        prev.set(e.to, { from: u, roadId: e.roadId });
        heap.push({ id: e.to, cost: alt });
        stats.heapInsertions++;
        stats.relaxations++;
      }
    }
  }
  return { source: sourceId, dist, prev, done, stats: { ...stats, settled: done.size } };
}

export function unreachableRoute(sourceId, destId) {
  return {
    reachable: false, source: sourceId, destination: destId, path: [], roadIds: [],
    totalLengthM: null, totalTimeS: null, totalRiskPenaltyS: null, totalCost: null, roadCount: 0,
  };
}

// Walks the predecessor map back from destId and sums each cost component from the current road state.
export function buildRoute(graph, sourceId, destId, prev) {
  const path = [destId];
  const roadIds = [];
  let cur = destId;
  while (cur !== sourceId) {
    const p = prev.get(cur);
    roadIds.unshift(p.roadId);
    path.unshift(p.from);
    cur = p.from;
  }
  let totalLengthM = 0, totalTimeS = 0, totalRiskPenaltyS = 0;
  for (const rid of roadIds) {
    const r = graph.getRoad(rid);
    totalLengthM += r.lengthM;
    totalTimeS += graph.travelTimeS(r);
    totalRiskPenaltyS += r.riskPenaltyS;
  }
  return {
    reachable: true, source: sourceId, destination: destId, path, roadIds,
    totalLengthM, totalTimeS, totalRiskPenaltyS,
    totalCost: totalTimeS + totalRiskPenaltyS,
    roadCount: roadIds.length,
  };
}

// Route v -> targetId from a REVERSE search rooted at targetId (prev(v).from = next vertex towards target).
export function buildRouteToTarget(graph, sourceId, targetId, prevReverse) {
  const path = [sourceId];
  const roadIds = [];
  let cur = sourceId;
  while (cur !== targetId) {
    const p = prevReverse.get(cur);
    roadIds.push(p.roadId);
    path.push(p.from);
    cur = p.from;
  }
  const forwardPrev = new Map(path.slice(1).map((v, i) => [v, { from: path[i], roadId: roadIds[i] }]));
  return buildRoute(graph, sourceId, targetId, forwardPrev);
}

export function dijkstra(graph, sourceId, destId, options = {}) {
  if (!graph.hasLocation(destId)) throw new Error(`Unknown destination location: ${destId}`);
  const { dist, prev, stats } = dijkstraAll(graph, sourceId, { ...options, target: destId });
  const route = dist.has(destId) ? buildRoute(graph, sourceId, destId, prev) : unreachableRoute(sourceId, destId);
  return { ...route, stats };
}
