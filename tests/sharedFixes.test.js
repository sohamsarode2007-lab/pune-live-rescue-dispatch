// Regression tests for shared-library edge cases found in the audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../shared/graph/Graph.js';
import { farthestFirst } from '../shared/graph/kcenter.js';
import { trapZones, bridgesAndArticulationPoints } from '../shared/graph/tarjan.js';
import { dijkstraAll, buildRoute, buildRouteToTarget } from '../shared/graph/dijkstra.js';
import { bfs } from '../shared/graph/bfs.js';
import { EventQueue } from '../shared/sim/EventQueue.js';
import { FlowNetwork } from '../shared/flow/edmondsKarp.js';

const build = (nodes, roads) => {
  const g = new Graph();
  nodes.forEach((id, i) => g.addLocation({ id, lat: 18.5 + i * 0.001, lng: 73.8 }));
  for (const [id, from, to, o] of roads) g.addRoad({ id, from, to, lengthM: 100, baseTimeS: 10, ...(o ?? {}) });
  return g;
};

test('EventQueue: scheduled time/seq cannot be overwritten by the payload', () => {
  const q = new EventQueue(); q.push(100, { type: 'T', time: 5, seq: 999 });
  const e = q.pop(); assert.equal(e.time, 100); assert.notEqual(e.seq, 999);
});

test('farthestFirst never picks the same junction twice and serves cut-off areas first', () => {
  const g = build(['S1', 'A', 'U1', 'U2'], [['r1', 'S1', 'A'], ['r2', 'U1', 'U2']]);
  const { centers } = farthestFirst(g, ['S1'], 2);
  assert.equal(new Set(centers).size, centers.length);
  assert.ok(['U1', 'U2'].includes(centers[1]), 'the unreachable pocket gets the first new station');
});

test('trapZones: in a chain main -> A -> sink, A is a trap too', () => {
  const g = build(['M1', 'M2', 'M3', 'M4', 'A1', 'A2', 'B1', 'B2'], [
    ['m1', 'M1', 'M2'], ['m2', 'M2', 'M3'], ['m3', 'M3', 'M4'], ['a', 'A1', 'A2'], ['b', 'B1', 'B2'],
    ['ma', 'M4', 'A1', { oneWay: true }], ['ab', 'A2', 'B1', { oneWay: true }]]);
  const kinds = Object.fromEntries(trapZones(g).zones.map((z) => [z.nodeIds.slice().sort()[0], z.kind]));
  assert.equal(kinds.A1, 'trap');
  assert.equal(kinds.B1, 'trap');
});

test('articulation componentOf uses the index map and answers per junction', () => {
  const g = build(['A', 'B', 'C'], [['r1', 'A', 'B'], ['r2', 'B', 'C']]);
  const r = bridgesAndArticulationPoints(g);
  assert.equal(r.componentOf('A'), r.componentOf('C'));
});

test('buildRoute: multi-source arrays work, unreachable targets return reachable:false, no throw', () => {
  const g = build(['A', 'B', 'C', 'D'], [['r1', 'A', 'B'], ['r2', 'B', 'C']]);
  const { prev } = dijkstraAll(g, ['A', 'C']);
  assert.deepEqual(buildRoute(g, ['A', 'C'], 'B', prev).roadIds.length, 1);
  assert.equal(buildRoute(g, ['A', 'C'], 'D', prev).reachable, false);
  const rev = dijkstraAll(g, 'D', { reverse: true });
  assert.equal(buildRouteToTarget(g, 'A', 'D', rev.prev).reachable, false);
  const ok = buildRoute(g, 'A', 'C', dijkstraAll(g, 'A').prev);
  assert.deepEqual(ok.path, ['A', 'B', 'C']); assert.equal(ok.source, 'A');
});

test('bfs honours excludeRoadIds like every other search', () => {
  const g = build(['A', 'B'], [['r', 'A', 'B']]);
  assert.ok(bfs(g, 'A').reachable.has('B'));
  assert.ok(!bfs(g, 'A', { excludeRoadIds: new Set(['r']) }).reachable.has('B'));
});

test('Graph: reset restores initial affected flags, setLocationAffected bumps version, geometry is copied', () => {
  const g = new Graph();
  g.addLocation({ id: 'A', lat: 18.5, lng: 73.8, affected: true }); g.addLocation({ id: 'B', lat: 18.51, lng: 73.8 });
  g.addRoad({ id: 'r', from: 'A', to: 'B', lengthM: 100, baseTimeS: 10, geometry: [[1, 1], [2, 2]] });
  g.setLocationAffected('A', false);
  const v = g.version; g.setLocationAffected('B', true); assert.ok(g.version > v);
  g.reset(); assert.equal(g.getLocation('A').affected, true); assert.equal(g.getLocation('B').affected, false);
  g.roadGeometry('r', 'A').push([9, 9]); assert.equal(g.getRoad('r').geometry.length, 2);
});

test('FlowNetwork rejects out-of-range vertices and non-finite capacity; reset() restores capacities', () => {
  const f = new FlowNetwork(3); f.addEdge(0, 1, 5); f.addEdge(1, 2, 3);
  assert.throws(() => f.maxFlow(0, 7)); assert.throws(() => f.addEdge(0, 9, 1)); assert.throws(() => f.addEdge(0, 1, Infinity));
  assert.equal(f.maxFlow(0, 2).flow, 3);
  f.reset(); assert.equal(f.maxFlow(0, 2).flow, 3, 'same answer after reset');
});
