import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '../data/disasterScenarios.js';
import { buildCityGraph, roads } from '../data/cityData.js';
import { createSimulation, activateScenario, resetScenario, getAffectedReachability } from '../services/scenarioService.js';
import { saveBaseline, compareToBaseline } from '../services/comparisonService.js';
import { dijkstra } from '../algorithms/dijkstra.js';
import { routeIsValid } from './helpers.js';

const snapshot = (g) => JSON.stringify({
  roads: [...g.roads.values()].map((r) => [r.id, r.status, r.riskLevel, r.riskPenalty]),
  locs: [...g.locations.values()].map((l) => [l.id, l.affected]),
});

test('scenario data only references existing roads and locations', () => {
  const g = buildCityGraph();
  for (const sc of Object.values(SCENARIOS)) {
    sc.roadChanges.forEach((c) => assert.ok(g.getRoad(c.roadId), `${sc.id}: ${c.roadId}`));
    sc.affectedLocations.forEach((id) => assert.ok(g.hasLocation(id)));
    sc.requests.forEach((r) => assert.ok(g.hasLocation(r.locationId)));
    assert.equal(new Set(sc.requests.map((r) => r.id)).size, sc.requests.length);
  }
});

test('flood changes the underlying graph, not just the display', () => {
  const sim = createSimulation();
  assert.equal(sim.graph.countRoadsByStatus().BLOCKED, 0);
  activateScenario(sim, 'FLOOD');
  const c = sim.graph.countRoadsByStatus();
  assert.equal(c.BLOCKED, 4);
  assert.equal(c.HIGH_RISK, 3);
  assert.equal(c.OPEN, roads.length - 7);
  assert.ok(sim.graph.getLocation('R1').affected);
});

test('flood: reports which affected locations stay reachable and which do not', () => {
  const sim = createSimulation();
  activateScenario(sim, 'FLOOD');
  const { reachable, unreachable } = getAffectedReachability(sim.graph);
  assert.deepEqual(unreachable, ['R1']);                 // both of R1's roads are blocked
  assert.deepEqual(reachable.sort(), ['H2', 'N13', 'N9']);
});

test('fire: incident site stays reachable and an alternative route exists', async () => {
  const { findAlternativeRoute } = await import('../services/routingService.js');
  const sim = createSimulation();
  activateScenario(sim, 'FIRE');
  const primary = dijkstra(sim.graph, 'RS1', 'C1');
  assert.ok(primary.reachable);
  assert.ok(primary.totalRiskPenalty > 0);               // approach roads are high-risk
  const alt = findAlternativeRoute(sim.graph, 'RS1', 'C1', primary);
  assert.ok(alt && alt.reachable);
  assert.notDeepEqual(alt.path, primary.path);
  assert.ok(alt.totalCost >= primary.totalCost);
  assert.ok(!alt.roadIds.includes(alt.avoidsRoad));
  assert.ok(routeIsValid(sim.graph, alt));
});

test('11. activating a scenario twice does not duplicate requests', () => {
  const sim = createSimulation();
  activateScenario(sim, 'FLOOD');
  const n = sim.requests.size;
  const again = activateScenario(sim, 'FLOOD');
  assert.equal(again.changed, false);
  assert.equal(sim.requests.size, n);
  assert.equal(n, SCENARIOS.FLOOD.requests.length);
});

test('switching scenario replaces graph changes and generated requests', () => {
  const sim = createSimulation();
  activateScenario(sim, 'FLOOD');
  activateScenario(sim, 'FIRE');
  assert.equal(sim.graph.getRoad('RD35').status, 'OPEN');        // flood damage gone
  assert.equal(sim.graph.getRoad('RD16').status, 'BLOCKED');     // fire damage present
  assert.ok(!sim.graph.getLocation('R1').affected);
  assert.deepEqual(sim.requests.list().map((r) => r.id), SCENARIOS.FIRE.requests.map((r) => r.id));
});

test('10. reset restores the original graph, requests and state', () => {
  const sim = createSimulation();
  const original = snapshot(sim.graph);
  sim.baseline = saveBaseline(sim.graph, 'RS1', 'H2');
  activateScenario(sim, 'FLOOD');
  sim.graph.setRoadStatus('RD1', 'BLOCKED');            // manual edit on top
  assert.notEqual(snapshot(sim.graph), original);
  resetScenario(sim);
  assert.equal(snapshot(sim.graph), original);
  assert.equal(sim.requests.size, 0);
  assert.equal(sim.activeScenario, null);
  assert.equal(sim.baseline, null);
});

test('comparison: baseline vs flood shows new route, deltas and causes', () => {
  const sim = createSimulation();
  const baseline = saveBaseline(sim.graph, 'RS1', 'H2');
  assert.ok(baseline.route.reachable);
  activateScenario(sim, 'FLOOD');
  const cmp = compareToBaseline(sim.graph, baseline);
  assert.equal(cmp.status, 'REACHABLE');
  assert.ok(cmp.routeChanged);
  assert.ok(cmp.costChange > 0 && cmp.distanceChange > 0);
  assert.ok(cmp.closedRoads.length > 0);
  cmp.closedRoads.forEach((id) => assert.equal(sim.graph.getRoad(id).status, 'BLOCKED'));
  assert.ok(routeIsValid(sim.graph, cmp.after));
  assert.equal(cmp.after.totalCost, dijkstra(sim.graph, 'RS1', 'H2').totalCost);   // calculated, not stored
});

test('comparison: unreachable after disaster is reported as UNREACHABLE', () => {
  const sim = createSimulation();
  const baseline = saveBaseline(sim.graph, 'RS1', 'R1');
  activateScenario(sim, 'FLOOD');
  const cmp = compareToBaseline(sim.graph, baseline);
  assert.equal(cmp.status, 'UNREACHABLE');
  assert.equal(cmp.after.reachable, false);
  assert.equal(cmp.costChange, null);
  assert.ok(cmp.closedRoads.length > 0);
});

test('12. route results update after graph changes (manual edit, then reopen)', () => {
  const sim = createSimulation();
  const a = dijkstra(sim.graph, 'RS2', 'H1');
  sim.graph.setRoadStatus(a.roadIds[0], 'BLOCKED');
  const b = dijkstra(sim.graph, 'RS2', 'H1');
  assert.ok(!b.roadIds.includes(a.roadIds[0]));
  sim.graph.setRoadStatus(a.roadIds[0], 'OPEN');
  assert.deepEqual(dijkstra(sim.graph, 'RS2', 'H1').path, a.path);
});
