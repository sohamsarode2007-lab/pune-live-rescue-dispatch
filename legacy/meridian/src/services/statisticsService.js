import { getAffectedReachability } from './scenarioService.js';
import { requestStats } from './requestService.js';

// Every number is derived from the current simulation state; nothing is estimated or invented.
export function computeMetrics(sim) {
  const g = sim.graph;
  const roads = g.countRoadsByStatus();
  const aff = getAffectedReachability(g);
  const rq = requestStats(sim.requests);
  return {
    affectedLocations: [...g.locations.values()].filter((l) => l.affected).length,
    blockedRoads: roads.BLOCKED,
    highRiskRoads: roads.HIGH_RISK,
    reachableAffected: aff.reachable.length,
    unreachableAffected: aff.unreachable.length,
    activeRequests: rq.active,
    pendingRequests: rq.pending,
    assignedRequests: rq.assigned,
    completedRequests: rq.completed,
    requestsBySeverity: rq.bySeverity,
  };
}

export function routeMetrics(route) {
  if (!route) return null;
  if (!route.reachable) return { status: 'UNREACHABLE', distanceKm: null, cost: null, riskPenalty: null };
  return { status: 'REACHABLE', distanceKm: route.totalDistanceKm, cost: route.totalCost, riskPenalty: route.totalRiskPenalty };
}
