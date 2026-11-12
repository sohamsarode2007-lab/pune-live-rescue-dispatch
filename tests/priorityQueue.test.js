import test from 'node:test';
import assert from 'node:assert/strict';
import { EmergencyPriorityQueue, priorityScore, compareRequestPriority } from '../shared/dispatch/EmergencyPriorityQueue.js';

const req = (id, severity, peopleAffected, waitingTimeScore, status = 'PENDING') =>
  ({ id, locationId: 'n1', disasterType: 'FLOOD', severity, peopleAffected, waitingTimeScore, status });

// The dispatcher builds the queue from PENDING requests only (Phase 3 wires this into the server).
const queueOf = (reqs) => {
  const q = new EmergencyPriorityQueue();
  reqs.filter((r) => r.status === 'PENDING').forEach((r) => q.insert(r));
  return q;
};

test('priority formula: 5*severity + 2*min(people,10) + min(waiting,10)', () => {
  assert.equal(priorityScore(req('a', 'CRITICAL', 12, 7)), 20 + 20 + 7);
  assert.equal(priorityScore(req('b', 'LOW', 1, 0)), 5 + 2 + 0);
  assert.equal(priorityScore(req('c', 'HIGH', 3, 4)), 15 + 6 + 4);
});

test('people and waiting contributions are capped at 10', () => {
  assert.equal(priorityScore(req('a', 'MEDIUM', 500, 900)), 10 + 20 + 10);
  assert.equal(priorityScore(req('a', 'MEDIUM', 10, 10)), priorityScore(req('b', 'MEDIUM', 11, 11)));
});

test('8. queue selects the highest-scoring pending request', () => {
  const q = queueOf([req('low', 'LOW', 2, 1), req('crit', 'CRITICAL', 8, 5), req('high', 'HIGH', 4, 3)]);
  // high: 15+8+3 = 26 < crit: 20+16+5 = 41
  assert.equal(q.peek().id, 'crit');
  assert.deepEqual(q.toSortedArray().map((r) => r.id), ['crit', 'high', 'low']);
});

test('9. ties: longer waiting time first, then request ID, deterministically', () => {
  const A = req('A', 'MEDIUM', 5, 6);   // 10 + 10 + 6 = 26
  const B = req('B', 'HIGH', 2, 7);     // 15 + 4 + 7 = 26, waited longer
  const C = req('C', 'MEDIUM', 5, 6);   // identical to A, later ID
  assert.equal(priorityScore(A), priorityScore(B));
  assert.ok(compareRequestPriority(B, A) < 0);
  assert.ok(compareRequestPriority(A, C) < 0);
  // result must not depend on insertion order
  for (const order of [[A, B, C], [C, B, A], [B, C, A], [A, C, B]]) {
    const q = new EmergencyPriorityQueue();
    order.forEach((r) => q.insert(r));
    assert.deepEqual(q.toSortedArray().map((r) => r.id), ['B', 'A', 'C']);
  }
});

test('natural ID ordering: REQ-2 comes before REQ-10 on a full tie', () => {
  const x = req('REQ-10', 'LOW', 1, 0), y = req('REQ-2', 'LOW', 1, 0);
  assert.ok(compareRequestPriority(y, x) < 0);
});

test('extractMax matches a sort by the same comparator on 200 pseudo-random requests; heap property holds', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const sev = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  const all = Array.from({ length: 200 }, (_, i) => req(`R${i}`, sev[rnd(4)], 1 + rnd(15), rnd(14)));
  const q = new EmergencyPriorityQueue();
  all.forEach((r) => q.insert(r));
  const h = q.heapArray();
  for (let i = 1; i < h.length; i++) assert.ok(compareRequestPriority(h[(i - 1) >> 1], h[i]) <= 0, 'parent must outrank child');
  const out = [];
  while (!q.isEmpty()) out.push(q.extractMax().id);
  assert.deepEqual(out, [...all].sort(compareRequestPriority).map((r) => r.id));
});

test('empty queue: peek/extractMax return undefined; toSortedArray does not drain the queue', () => {
  const q = new EmergencyPriorityQueue();
  assert.equal(q.peek(), undefined);
  assert.equal(q.extractMax(), undefined);
  q.insert(req('a', 'LOW', 1, 1)); q.insert(req('b', 'HIGH', 1, 1));
  q.toSortedArray();
  assert.equal(q.size, 2);
});

test('completed and assigned requests are never selected as pending', () => {
  const all = [req('r1', 'CRITICAL', 10, 10), req('r2', 'HIGH', 5, 5), req('r3', 'LOW', 1, 1)];
  assert.equal(queueOf(all).peek().id, 'r1');
  all[0].status = 'ASSIGNED';
  assert.equal(queueOf(all).peek().id, 'r2');
  all[1].status = 'COMPLETED';
  assert.equal(queueOf(all).peek().id, 'r3');
  all[2].status = 'COMPLETED';
  assert.equal(queueOf(all).peek(), undefined);
  assert.deepEqual(queueOf(all).toSortedArray(), []);
});

test('score can outweigh severity: HIGH with many people and long wait beats CRITICAL with few', () => {
  const q = queueOf([req('crit', 'CRITICAL', 1, 0), req('high', 'HIGH', 10, 10)]);  // 22 vs 45
  assert.equal(q.peek().id, 'high');
});
