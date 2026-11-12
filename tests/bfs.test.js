import test from 'node:test';
import assert from 'node:assert/strict';
import { bfs } from '../shared/graph/bfs.js';
import { smallGraph, randomGraph } from './helpers.js';

test('BFS visits in level order from the start', () => {
  const g = smallGraph();
  assert.deepEqual(bfs(g, 'A').order, ['A', 'B', 'C', 'D', 'E']);
});

test('BFS does not traverse blocked roads and reports disconnected areas', () => {
  const g = smallGraph();
  g.setRoadStatus('r1', 'BLOCKED');
  g.setRoadStatus('r3', 'BLOCKED');
  const res = bfs(g, 'A');
  assert.deepEqual(res.order, ['A']);
  assert.ok(!res.reachable.has('D'));
  // with only r1 blocked, D is still reached via C-E
  g.setRoadStatus('r3', 'OPEN');
  assert.ok(bfs(g, 'A').reachable.has('D'));
});

test('BFS depth = fewest roads from the start (vs Bellman-Ford with every road costing 1)', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const g = randomGraph(seed, 30, 70);
    const r = bfs(g, 'v0');
    const d = new Map([...g.locations.keys()].map((k) => [k, Infinity]));
    d.set('v0', 0);
    for (let i = 0; i < g.locations.size; i++)
      for (const u of g.locations.keys()) for (const e of g.neighbors(u)) if (d.get(u) + 1 < d.get(e.to)) d.set(e.to, d.get(u) + 1);
    for (const [v, hops] of d) {
      if (hops === Infinity) assert.ok(!r.reachable.has(v));
      else assert.equal(r.depth.get(v), hops, `seed ${seed} ${v}`);
    }
  }
});

test('BFS rejects unknown start', () => {
  assert.throws(() => bfs(smallGraph(), 'ZZ'));
});
