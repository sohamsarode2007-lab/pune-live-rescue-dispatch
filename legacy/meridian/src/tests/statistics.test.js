import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation, activateScenario, resetScenario } from '../services/scenarioService.js';
import { assignRequest, completeRequest, createRequest } from '../services/requestService.js';
import { computeMetrics, routeMetrics } from '../services/statisticsService.js';
import { dijkstra, dijkstraAll } from '../algorithms/dijkstra.js';
import { smallGraph } from './helpers.js';

test('metrics of the untouched network are all zero', () => {
  const m = computeMetrics(createSimulation());
  assert.deepEqual([m.affectedLocations, m.blockedRoads, m.highRiskRoads, m.activeRequests, m.completedRequests], [0, 0, 0, 0, 0]);
});

test('flood metrics match the scenario data and the graph', () => {
  const sim = createSimulation();
  activateScenario(sim, 'FLOOD');
  const m = computeMetrics(sim);
  assert.equal(m.affectedLocations, 4);
  assert.equal(m.blockedRoads, 4);
  assert.equal(m.highRiskRoads, 3);
  assert.equal(m.reachableAffected, 3);
  assert.equal(m.unreachableAffected, 1);
  assert.equal(m.reachableAffected + m.unreachableAffected, m.affectedLocations);
  assert.equal(m.activeRequests, 4);
  assert.deepEqual(m.requestsBySeverity, { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 1 });
});

test('request metrics follow status changes; reset returns everything to zero', () => {
  const sim = createSimulation();
  activateScenario(sim, 'FLOOD');
  completeRequest(sim.requests, 'FLOOD-4');
  assignRequest(sim.requests, sim.graph, 'FLOOD-2');
  createRequest(sim.requests, sim.graph, { locationId: 'R2', disasterType: 'OTHER', severity: 'LOW', peopleAffected: 2, waitingTimeScore: 0 });
  const m = computeMetrics(sim);
  assert.deepEqual([m.activeRequests, m.pendingRequests, m.assignedRequests, m.completedRequests], [4, 3, 1, 1]);
  assert.equal(Object.values(m.requestsBySeverity).reduce((a, b) => a + b, 0), m.activeRequests);
  resetScenario(sim);
  assert.deepEqual(computeMetrics(sim), computeMetrics(createSimulation()));
});

test('route metrics: reachable values come from the route; unreachable has no numbers', () => {
  const g = smallGraph();
  const ok = routeMetrics(dijkstra(g, 'A', 'D'));
  assert.deepEqual([ok.status, ok.distanceKm, ok.riskPenalty, ok.cost], ['REACHABLE', 6, 0, 6]);
  g.setRoadStatus('r2', 'BLOCKED'); g.setRoadStatus('r5', 'BLOCKED');
  const bad = routeMetrics(dijkstra(g, 'A', 'D'));
  assert.deepEqual([bad.status, bad.cost], ['UNREACHABLE', null]);
  assert.equal(routeMetrics(null), null);
});

test('dijkstra operation counters are consistent', () => {
  const g = smallGraph();
  const { stats, dist } = dijkstraAll(g, 'A');
  assert.equal(stats.heapInsertions, stats.heapExtractions);      // every inserted entry is eventually extracted
  assert.equal(stats.settled, dist.size);
  assert.equal(stats.heapExtractions, stats.settled + stats.staleSkipped);
});
