import test from 'node:test';
import assert from 'node:assert/strict';
import { MinHeap } from '../shared/graph/MinHeap.js';
import { dijkstra, dijkstraAll, buildRouteToTarget } from '../shared/graph/dijkstra.js';
import { RISK_PENALTY_S } from '../shared/graph/Graph.js';
import { smallGraph, randomGraph, bellmanFord, routeIsValid, hasPuneData, loadPune } from './helpers.js';

const HR = RISK_PENALTY_S.HIGH_RISK;

test('MinHeap extracts in ascending order and handles empty', () => {
  const h = new MinHeap();
  [5, 3, 8, 1, 9, 2, 7].forEach((n) => h.push(n));
  assert.equal(h.peek(), 1);
  const out = [];
  while (!h.isEmpty()) out.push(h.pop());
  assert.deepEqual(out, [1, 2, 3, 5, 7, 8, 9]);
  assert.equal(h.pop(), undefined);
});

test('1. Dijkstra picks the lower-COST route, not the fewest roads', () => {
  const r = dijkstra(smallGraph(), 'A', 'D');
  assert.deepEqual(r.path, ['A', 'C', 'E', 'D']);
  assert.equal(r.totalCost, 6);
  assert.equal(r.totalTimeS, 6);
  assert.equal(r.totalLengthM, 60);
  assert.equal(r.roadCount, 3);
});

test('2. Dijkstra avoids a blocked road', () => {
  const g = smallGraph();
  g.setRoadStatus('r4', 'BLOCKED');
  const r = dijkstra(g, 'A', 'D');
  assert.deepEqual(r.path, ['A', 'B', 'D']);
  assert.ok(!r.roadIds.includes('r4'));
});

test('3. Dijkstra switches to an alternative after a block (route updates with graph)', () => {
  const g = smallGraph();
  const before = dijkstra(g, 'A', 'D');
  g.setRoadStatus('r3', 'BLOCKED');
  const after = dijkstra(g, 'A', 'D');
  assert.deepEqual(after.path, ['A', 'B', 'D']);
  assert.equal(after.totalCost, 10);
  g.setRoadStatus('r3', 'OPEN');
  assert.deepEqual(dijkstra(g, 'A', 'D').path, before.path);
});

test('4. Dijkstra reports unreachable destination (disconnected graph)', () => {
  const g = smallGraph();
  g.setRoadStatus('r2', 'BLOCKED');
  g.setRoadStatus('r5', 'BLOCKED');
  const r = dijkstra(g, 'A', 'D');
  assert.equal(r.reachable, false);
  assert.equal(r.totalCost, null);
  assert.deepEqual(r.path, []);
});

test('5. HIGH_RISK stays traversable and adds its penalty in seconds', () => {
  const g = smallGraph();
  g.setRoadStatus('r3', 'HIGH_RISK');          // A-C now costs 2 + 120
  let r = dijkstra(g, 'A', 'D');
  assert.deepEqual(r.path, ['A', 'B', 'D']);
  g.setRoadStatus('r1', 'BLOCKED');
  r = dijkstra(g, 'A', 'D');                   // only route left uses the HIGH_RISK road
  assert.deepEqual(r.path, ['A', 'C', 'E', 'D']);
  assert.equal(r.totalTimeS, 6);
  assert.equal(r.totalRiskPenaltyS, HR);
  assert.equal(r.totalCost, 6 + HR);
});

test('traffic factor slows a road and can change the route', () => {
  const g = smallGraph();
  g.setTrafficFactor('r4', 4);                 // C-E: 2 s -> 8 s, so A-C-E-D = 12 > A-B-D = 10
  const r = dijkstra(g, 'A', 'D');
  assert.deepEqual(r.path, ['A', 'B', 'D']);
  assert.equal(r.totalCost, 10);
});

test('source equals destination gives a zero-cost route', () => {
  const r = dijkstra(smallGraph(), 'A', 'A');
  assert.deepEqual(r.path, ['A']);
  assert.equal(r.totalCost, 0);
});

test('unknown IDs throw', () => {
  assert.throws(() => dijkstra(smallGraph(), 'A', 'ZZ'));
  assert.throws(() => dijkstra(smallGraph(), 'ZZ', 'A'));
});

test('Dijkstra matches Bellman-Ford on 30 random road graphs (one-way, traffic, closures), every pair', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = randomGraph(seed, 25, 55);
    for (const s of g.locations.keys()) {
      const bf = bellmanFord(g, s);
      const { dist } = dijkstraAll(g, s);
      for (const t of g.locations.keys()) {
        if (bf.get(t) === Infinity) assert.ok(!dist.has(t), `seed ${seed}: ${s}->${t} should be unreachable`);
        else assert.ok(Math.abs(dist.get(t) - bf.get(t)) < 1e-6, `seed ${seed}: ${s}->${t}`);
      }
    }
  }
});

test('early stop at the target gives the same cost as a full run', () => {
  const g = randomGraph(99, 60, 150);
  const full = dijkstraAll(g, 'v0').dist;
  for (const t of g.locations.keys()) {
    const r = dijkstra(g, 'v0', t);
    if (!full.has(t)) assert.equal(r.reachable, false);
    else assert.ok(Math.abs(r.totalCost - full.get(t)) < 1e-9);
  }
});

test('early stop is optional: without a target dijkstraAll settles every reachable vertex', () => {
  const g = randomGraph(31, 60, 150, { closures: false });
  const full = dijkstraAll(g, 'v0');
  const bf = bellmanFord(g, 'v0');
  const reachable = [...bf.values()].filter((d) => d < Infinity).length;
  assert.equal(full.dist.size, reachable);
  assert.equal(full.stats.settled, reachable);
  const stopped = dijkstraAll(g, 'v0', { target: [...full.dist.keys()][3] });
  assert.ok(stopped.stats.settled < full.stats.settled, 'a target makes it stop early');
});

test('full single-source run on the real Pune graph returns a distance to every junction',
  { skip: !hasPuneData && 'Pune graph not generated' }, async () => {
    const { graph } = await loadPune();
    const start = graph.locations.keys().next().value;
    const { dist, stats } = dijkstraAll(graph, start);
    assert.equal(dist.size, graph.locations.size);
    assert.equal(stats.settled, graph.locations.size);
    for (const d of dist.values()) assert.ok(Number.isFinite(d) && d >= 0);
  });

test('reverse Dijkstra: dist(v) equals the forward cost v -> target, and the rebuilt routes are valid', () => {
  for (let seed = 40; seed < 55; seed++) {
    const g = randomGraph(seed, 25, 60);
    const target = 'v3';
    const rev = dijkstraAll(g, target, { reverse: true });
    for (const v of g.locations.keys()) {
      const fwd = dijkstra(g, v, target);
      assert.equal(rev.dist.has(v), fwd.reachable, `seed ${seed} ${v}`);
      if (!fwd.reachable) continue;
      assert.ok(Math.abs(rev.dist.get(v) - fwd.totalCost) < 1e-6);
      const route = buildRouteToTarget(g, v, target, rev.prev);
      assert.ok(routeIsValid(g, route));
      assert.ok(Math.abs(route.totalCost - fwd.totalCost) < 1e-6);
    }
  }
});

test('14. every route uses valid, currently traversable edges in a legal direction', () => {
  for (let seed = 200; seed < 210; seed++) {
    const g = randomGraph(seed, 30, 70);
    for (const t of g.locations.keys()) assert.ok(routeIsValid(g, dijkstra(g, 'v0', t)), `seed ${seed} v0->${t}`);
  }
});
