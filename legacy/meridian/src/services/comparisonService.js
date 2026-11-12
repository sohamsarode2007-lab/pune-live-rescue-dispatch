import { dijkstra } from '../algorithms/dijkstra.js';

// Save the current route result (and the penalties of its roads) for later comparison.
export function saveBaseline(graph, source, destination) {
  const route = dijkstra(graph, source, destination);
  return {
    source, destination, route,
    roadPenalties: Object.fromEntries(route.roadIds.map((id) => [id, graph.getRoad(id).riskPenalty])),
  };
}

// Compare the saved baseline with a fresh calculation on the current graph.
export function compareToBaseline(graph, baseline) {
  const before = baseline.route;
  const after = dijkstra(graph, baseline.source, baseline.destination);
  const both = before.reachable && after.reachable;

  // Causes: roads of the baseline route that are now blocked or carry a higher penalty.
  const closedRoads = before.roadIds.filter((id) => graph.getRoad(id).status === 'BLOCKED');
  const riskRoads = before.roadIds.filter((id) => {
    const r = graph.getRoad(id);
    return r.status !== 'BLOCKED' && r.riskPenalty > baseline.roadPenalties[id];
  });

  return {
    before, after,
    routeChanged: before.path.join('>') !== after.path.join('>'),
    distanceChange: both ? after.totalDistanceKm - before.totalDistanceKm : null,
    costChange: both ? after.totalCost - before.totalCost : null,
    status: after.reachable ? 'REACHABLE' : 'UNREACHABLE',
    closedRoads, riskRoads,
  };
}
