// Station placement as a k-center problem: choose new station junctions so that the WORST response time
// (from the nearest station to any junction) is as small as possible. k-center is NP-hard, so greedy:
//
// 1. Gonzalez farthest-first (the classic greedy k-center, a 2-approximation on symmetric distances):
//    repeatedly add the junction that is currently FARTHEST from every station (one multi-source Dijkstra
//    per pick). Its picks are also a good, spread-out candidate set.
// 2. Best-improvement greedy: for each candidate c, compute its distance row (one Dijkstra from c) and the
//    worst case if a station were added there: max over junctions of min(current, row[c]). Add the
//    candidate with the smallest new worst case (ties: smaller average), repeat for k stations.
// Distances are forward (station -> junction), on the current network; excludeRoadIds simulates closures.
import { dijkstraAll } from './dijkstra.js';

const stats = (d, ids) => {
  let worst = 0, sum = 0, n = 0, unreachable = 0;
  for (const id of ids) {
    const v = d.get(id);
    if (v === undefined) { unreachable++; continue; }
    worst = Math.max(worst, v); sum += v; n++;
  }
  return { worstS: worst, avgS: n ? sum / n : 0, unreachable };
};

// Gonzalez farthest-first: returns the k picks in order and the covering radius before each pick.
export function farthestFirst(graph, existing, k, { excludeRoadIds = null } = {}) {
  const centers = [...existing];
  const picks = [];
  const ids = [...graph.locations.keys()];
  for (let i = 0; i < k; i++) {
    const d = centers.length ? dijkstraAll(graph, centers, { excludeRoadIds }).dist : new Map();
    let far = null, farD = -1;
    for (const id of ids) {
      if (!centers.length) { far = id; break; }           // no station yet: start anywhere (first junction)
      const v = d.get(id);
      if (v !== undefined && (v > farD || (v === farD && id < far))) { far = id; farD = v; }
    }
    if (far === null) break;
    picks.push({ nodeId: far, radiusBeforeS: farD < 0 ? null : farD });
    centers.push(far);
  }
  const final = dijkstraAll(graph, centers, { excludeRoadIds }).dist;
  return { picks, centers, ...stats(final, ids) };
}

// Best-improvement greedy over a candidate set. Returns the chosen stations with before/after statistics
// and every evaluated candidate (for display / tests).
export function greedyKCenter(graph, existing, k, candidates, { excludeRoadIds = null, rowCache = new Map() } = {}) {
  const ids = [...graph.locations.keys()];
  let current = dijkstraAll(graph, existing, { excludeRoadIds }).dist;
  const before = stats(current, ids);
  const row = (c) => {
    if (!rowCache.has(c)) rowCache.set(c, dijkstraAll(graph, c, { excludeRoadIds }).dist);
    return rowCache.get(c);
  };
  const chosen = [];
  let evaluated = [];
  for (let step = 0; step < k; step++) {
    evaluated = [];
    for (const c of candidates) {
      if (existing.includes(c) || chosen.some((x) => x.nodeId === c)) continue;
      const r = row(c);
      let worst = 0, sum = 0, n = 0, unreachable = 0;
      for (const id of ids) {
        const a = current.get(id), b = r.get(id);
        const v = a === undefined ? b : b === undefined ? a : Math.min(a, b);
        if (v === undefined) { unreachable++; continue; }
        worst = Math.max(worst, v); sum += v; n++;
      }
      evaluated.push({ nodeId: c, worstS: worst, avgS: n ? sum / n : 0, unreachable });
    }
    evaluated.sort((x, y) => x.unreachable - y.unreachable || x.worstS - y.worstS || x.avgS - y.avgS || (x.nodeId < y.nodeId ? -1 : 1));
    const best = evaluated[0];
    if (!best) break;
    chosen.push(best);
    const r = row(best.nodeId);
    const merged = new Map(current);
    for (const [id, v] of r) if (!merged.has(id) || v < merged.get(id)) merged.set(id, v);
    current = merged;
  }
  return { before, chosen, after: stats(current, ids), evaluated, distances: current };
}
