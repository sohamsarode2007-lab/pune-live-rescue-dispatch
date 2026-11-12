import test from 'node:test';
import assert from 'node:assert/strict';
import { dijkstra } from '../algorithms/dijkstra.js';
import { findAlternativeRoute, compareStations } from '../services/routingService.js';
import { buildCityGraph } from '../data/cityData.js';
import { smallGraph } from './helpers.js';

test('excludeRoadIds avoids a road for one run without changing the graph', () => {
  const g = smallGraph();
  const r = dijkstra(g, 'A', 'D', { excludeRoadIds: new Set(['r3']) });
  assert.deepEqual(r.path, ['A', 'B', 'D']);
  assert.equal(g.getRoad('r3').status, 'OPEN');
  assert.deepEqual(dijkstra(g, 'A', 'D').path, ['A', 'C', 'E', 'D']);
});

test('alternative route differs from the primary; null when no alternative exists', () => {
  const g = smallGraph();
  const primary = dijkstra(g, 'A', 'D');
  const alt = findAlternativeRoute(g, 'A', 'D', primary);
  assert.deepEqual(alt.path, ['A', 'B', 'D']);
  g.setRoadStatus('r1', 'BLOCKED');
  const only = dijkstra(g, 'A', 'D');
  assert.equal(findAlternativeRoute(g, 'A', 'D', only), null);
});

test('station comparison recommends the cheapest reachable station', () => {
  const g = buildCityGraph();
  const { results, recommended } = compareStations(g, 'S1');
  const best = results.filter((x) => x.route.reachable).sort((a, b) => a.route.totalCost - b.route.totalCost)[0];
  assert.equal(recommended, best.stationId);
});

test('no station is recommended when the destination is unreachable from all', () => {
  const g = buildCityGraph();
  ['RD35', 'RD36'].forEach((id) => g.setRoadStatus(id, 'BLOCKED'));   // R1's only roads
  const { recommended, results } = compareStations(g, 'R1');
  assert.equal(recommended, null);
  assert.ok(results.every((x) => !x.route.reachable));
});
