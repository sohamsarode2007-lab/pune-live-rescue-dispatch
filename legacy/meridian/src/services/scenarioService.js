import { buildCityGraph } from '../data/cityData.js';
import { SCENARIOS } from '../data/disasterScenarios.js';
import { RequestStore, makeRequest } from './requestService.js';
import { bfs } from '../algorithms/bfs.js';

// A simulation bundles all mutable state so reset can restore everything at once.
export function createSimulation() {
  return { graph: buildCityGraph(), requests: new RequestStore(), activeScenario: null, baseline: null, lastChanges: [] };
}

// Activating a scenario updates the underlying graph (not just map colours).
// Same scenario twice -> no-op. Different scenario -> graph is reset, its generated requests are replaced.
export function activateScenario(sim, scenarioId) {
  const sc = SCENARIOS[scenarioId];
  if (!sc) throw new Error(`Unknown scenario: ${scenarioId}`);
  if (sim.activeScenario === scenarioId) return { changed: false, changes: [] };

  sim.graph.reset();
  sim.requests.removeWhere((r) => r.origin !== 'MANUAL');

  const changes = [];
  for (const { roadId, status } of sc.roadChanges) {
    const before = sim.graph.getRoad(roadId).status;
    sim.graph.setRoadStatus(roadId, status);
    changes.push({ roadId, before, after: status });
  }
  sc.affectedLocations.forEach((id) => sim.graph.setLocationAffected(id, true));
  for (const r of sc.requests) {
    if (!sim.requests.has(r.id)) sim.requests.add(makeRequest({ ...r, disasterType: scenarioId, origin: scenarioId }));
  }
  sim.activeScenario = scenarioId;
  sim.lastChanges = changes;
  return { changed: true, changes };
}

// Restores original roads, affected flags, requests, scenario and saved baseline.
export function resetScenario(sim) {
  sim.graph.reset();
  sim.requests.clear();
  sim.activeScenario = null;
  sim.baseline = null;
  sim.lastChanges = [];
}

// An affected location is "reachable" if at least one rescue station can reach it over open/high-risk roads.
export function getAffectedReachability(graph) {
  const stations = [...graph.locations.values()].filter((l) => l.type === 'Rescue Station');
  const reachableSet = new Set();
  stations.forEach((s) => bfs(graph, s.id).reachable.forEach((id) => reachableSet.add(id)));
  const affected = [...graph.locations.values()].filter((l) => l.affected);
  return {
    reachable: affected.filter((l) => reachableSet.has(l.id)).map((l) => l.id),
    unreachable: affected.filter((l) => !reachableSet.has(l.id)).map((l) => l.id),
  };
}
