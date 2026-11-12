import test from 'node:test';
import assert from 'node:assert/strict';
import { bfs } from '../shared/graph/bfs.js';
import { smallGraph } from './helpers.js';

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

test('BFS rejects unknown start', () => {
  assert.throws(() => bfs(smallGraph(), 'ZZ'));
});
