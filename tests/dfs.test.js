import test from 'node:test';
import assert from 'node:assert/strict';
import { dfs, findComponents } from '../shared/graph/dfs.js';
import { smallGraph, randomGraph, hasPuneData, loadPune } from './helpers.js';

// Reference: the textbook recursive DFS (fine for small graphs).
function recursiveOrder(g, s) {
  const seen = new Set(), order = [];
  const visit = (u) => { seen.add(u); order.push(u); for (const e of g.neighbors(u)) if (!seen.has(e.to)) visit(e.to); };
  visit(s);
  return order;
}

test('iterative DFS visits in exactly the same order as recursive DFS (40 random graphs)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const g = randomGraph(seed, 30, 70);
    for (const s of ['v0', 'v7', 'v19']) assert.deepEqual(dfs(g, s).order, recursiveOrder(g, s), `seed ${seed} from ${s}`);
  }
});

test('DFS tree: every non-start vertex has a parent joined by a traversable road, depth = parent depth + 1', () => {
  const g = randomGraph(9, 50, 120);
  const r = dfs(g, 'v0');
  for (const v of r.order.slice(1)) {
    const p = r.parent.get(v);
    assert.ok(g.neighbors(p.from).some((e) => e.to === v && e.roadId === p.roadId));
    assert.equal(r.depth.get(v), r.depth.get(p.from) + 1);
  }
});

test('DFS on the real Pune graph reaches every junction without overflowing the stack',
  { skip: !hasPuneData && 'Pune graph not generated' }, async () => {
    const { graph } = await loadPune();
    const r = dfs(graph, graph.locations.keys().next().value);
    assert.equal(r.reachable.size, graph.locations.size);
    assert.ok(r.maxStack > 500, `deep search: max stack ${r.maxStack}`);
  });

test('DFS goes deep before wide', () => {
  assert.deepEqual(dfs(smallGraph(), 'A').order, ['A', 'B', 'D', 'E', 'C']);
});

test('DFS does not traverse blocked roads', () => {
  const g = smallGraph();
  g.setRoadStatus('r2', 'BLOCKED');
  g.setRoadStatus('r5', 'BLOCKED');
  const res = dfs(g, 'A');
  assert.ok(!res.reachable.has('D'));
  assert.deepEqual([...res.reachable].sort(), ['A', 'B', 'C', 'E']);
});

test('findComponents shows disconnected areas', () => {
  const g = smallGraph();
  g.setRoadStatus('r2', 'BLOCKED');
  g.setRoadStatus('r5', 'BLOCKED');
  const comps = findComponents(g).map((c) => c.sort().join(''));
  assert.deepEqual(comps.sort(), ['ABCE', 'D']);
});
