import { dijkstra } from '../algorithms/dijkstra.js';

// Next-best route: cheapest route that avoids at least one road of the primary route.
// Calculated from the current graph; returns null when none exists.
export function findAlternativeRoute(graph, source, destination, primary) {
  if (!primary?.reachable || primary.roadIds.length === 0) return null;
  let best = null;
  for (const rid of primary.roadIds) {
    const r = dijkstra(graph, source, destination, { excludeRoadIds: new Set([rid]) });
    if (r.reachable && (best === null || r.totalCost < best.totalCost)) best = { ...r, avoidsRoad: rid };
  }
  return best;
}

// Route from every rescue station; recommend the lowest effective cost (ties -> lower station ID).
export function compareStations(graph, destination) {
  const stations = [...graph.locations.values()].filter((l) => l.type === 'Rescue Station');
  const results = stations.map((s) => ({ stationId: s.id, route: dijkstra(graph, s.id, destination) }));
  const reachable = results.filter((r) => r.route.reachable)
    .sort((a, b) => a.route.totalCost - b.route.totalCost || (a.stationId < b.stationId ? -1 : 1));
  return { results, recommended: reachable[0]?.stationId ?? null };
}
