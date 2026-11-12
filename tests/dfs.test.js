import test from 'node:test';
import assert from 'node:assert/strict';
import { dfs, findComponents } from '../shared/graph/dfs.js';
import { smallGraph } from './helpers.js';

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
