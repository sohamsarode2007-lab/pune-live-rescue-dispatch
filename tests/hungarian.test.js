import test from 'node:test';
import assert from 'node:assert/strict';
import { hungarian, greedyAssignment } from '../shared/dispatch/hungarian.js';
import { rng } from './helpers.js';

// Brute force over every one-to-one pairing of the smaller side into the larger side.
// Objective (same as hungarian.js): most feasible pairs first, then least total cost.
function bruteForce(cost) {
  const r = cost.length, c = r ? cost[0].length : 0;
  let best = { assigned: -1, totalCost: Infinity };
  const consider = (pairs) => {
    let assigned = 0, total = 0;
    for (const [i, j] of pairs) if (Number.isFinite(cost[i][j])) { assigned++; total += cost[i][j]; }
    if (assigned > best.assigned || (assigned === best.assigned && total < best.totalCost - 1e-9)) best = { assigned, totalCost: total };
  };
  const small = Math.min(r, c), big = Math.max(r, c);
  const used = new Array(big).fill(false), pick = [];
  const rec = (k) => {
    if (k === small) { consider(pick.map((b, s) => (r <= c ? [s, b] : [b, s]))); return; }
    for (let b = 0; b < big; b++) if (!used[b]) { used[b] = true; pick.push(b); rec(k + 1); pick.pop(); used[b] = false; }
  };
  rec(0);
  if (small === 0) best = { assigned: 0, totalCost: 0 };
  return best;
}

function randomMatrix(r, rows, cols, infProb) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => (r() < infProb ? Infinity : Math.round(r() * 1000) / 10)));
}

function checkValid(cost, res) {
  const cols = new Set();
  let total = 0, assigned = 0;
  res.assignment.forEach((j, i) => {
    if (j < 0) return;
    assert.ok(!cols.has(j), 'a unit is used twice');
    cols.add(j);
    assert.ok(Number.isFinite(cost[i][j]), 'an impossible pair was assigned');
    total += cost[i][j]; assigned++;
  });
  assert.equal(assigned, res.assigned);
  assert.ok(Math.abs(total - res.totalCost) < 1e-6);
}

test('Hungarian equals brute force on random square matrices n = 1..6', () => {
  const r = rng(101);
  for (let n = 1; n <= 6; n++) {
    for (let k = 0; k < 40; k++) {
      const cost = randomMatrix(r, n, n, 0);
      const h = hungarian(cost), b = bruteForce(cost);
      checkValid(cost, h);
      assert.equal(h.assigned, n);
      assert.ok(Math.abs(h.totalCost - b.totalCost) < 1e-6, `n=${n}: ${h.totalCost} vs ${b.totalCost}`);
    }
  }
});

test('Hungarian equals brute force on rectangular matrices: more units than incidents, and fewer', () => {
  const r = rng(202);
  for (let rows = 1; rows <= 6; rows++) for (let cols = 1; cols <= 6; cols++) {
    if (rows === cols) continue;
    for (let k = 0; k < 15; k++) {
      const cost = randomMatrix(r, rows, cols, 0);
      const h = hungarian(cost), b = bruteForce(cost);
      checkValid(cost, h);
      assert.equal(h.assigned, Math.min(rows, cols));
      assert.ok(Math.abs(h.totalCost - b.totalCost) < 1e-6, `${rows}x${cols}`);
    }
  }
});

test('impossible pairings (Infinity, e.g. wrong unit type) are never assigned; feasible count is maximised first', () => {
  const r = rng(303);
  for (let rows = 1; rows <= 6; rows++) for (let cols = 1; cols <= 6; cols++) {
    for (let k = 0; k < 12; k++) {
      const cost = randomMatrix(r, rows, cols, 0.45);
      const h = hungarian(cost), b = bruteForce(cost);
      checkValid(cost, h);
      assert.equal(h.assigned, b.assigned, `${rows}x${cols} feasible count`);
      assert.ok(Math.abs(h.totalCost - b.totalCost) < 1e-6, `${rows}x${cols} cost ${h.totalCost} vs ${b.totalCost}`);
    }
  }
});

test('unit types: a flood row can only take the boat column', () => {
  //            ambulance  fire truck  boat
  const cost = [[100, Infinity, Infinity],     // medical
                [Infinity, Infinity, 300],     // flood
                [Infinity, 50, Infinity]];     // fire
  const h = hungarian(cost);
  assert.deepEqual(h.assignment, [0, 2, 1]);
  assert.equal(h.totalCost, 450);
  // a row with no feasible unit stays unassigned
  const none = hungarian([[Infinity, Infinity], [5, 7]]);
  assert.deepEqual(none.assignment, [-1, 0]);
  assert.equal(none.assigned, 1);
  assert.deepEqual(hungarian([]).assignment, []);
  assert.deepEqual(hungarian([[Infinity]]).assignment, [-1]);
});

test('greedy is valid but can be worse: the classic counter-example', () => {
  // Incident 0 (served first) grabs unit 0, leaving incident 1 with the far unit.
  const cost = [[10, 12], [11, 100]];
  const g = greedyAssignment(cost, [0, 1]);
  const h = hungarian(cost);
  assert.equal(g.totalCost, 110);
  assert.equal(h.totalCost, 23);
});

test('Hungarian is never worse than greedy (300 random cases with impossible pairs)', () => {
  const r = rng(404);
  for (let k = 0; k < 300; k++) {
    const rows = 1 + Math.floor(r() * 8), cols = 1 + Math.floor(r() * 8);
    const cost = randomMatrix(r, rows, cols, 0.3);
    const g = greedyAssignment(cost), h = hungarian(cost);
    checkValid(cost, g);
    assert.ok(h.assigned >= g.assigned);
    if (h.assigned === g.assigned) assert.ok(h.totalCost <= g.totalCost + 1e-6);
  }
});

test('Hungarian handles 60 x 60 quickly', () => {
  const r = rng(505);
  const cost = randomMatrix(r, 60, 60, 0.2);
  const t0 = performance.now();
  const h = hungarian(cost);
  assert.ok(performance.now() - t0 < 200);
  checkValid(cost, h);
});
