import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowNetwork } from '../shared/flow/edmondsKarp.js';
import { farthestFirst, greedyKCenter } from '../shared/graph/kcenter.js';
import { dijkstraAll } from '../shared/graph/dijkstra.js';
import { Graph } from '../shared/graph/Graph.js';
import { rng } from './helpers.js';

// ---------------- Edmonds-Karp ----------------
test('Edmonds-Karp: CLRS figure 26.6 network has max flow 23 and a min cut of capacity 23', () => {
  const g = new FlowNetwork(6);                 // s=0, v1..v4 = 1..4, t=5
  [[0, 1, 16], [0, 2, 13], [1, 3, 12], [2, 1, 4], [2, 4, 14], [3, 2, 9], [3, 5, 20], [4, 3, 7], [4, 5, 4]]
    .forEach(([u, v, c]) => g.addEdge(u, v, c));
  assert.equal(g.maxFlow(0, 5).flow, 23);
  const cut = g.minCut(0);
  assert.equal(cut.capacity, 23);
  // hand-solved cut: S = {s, v1, v2, v4}, cut edges v1->v3 (12), v4->v3 (7), v4->t (4)
  assert.deepEqual([...cut.inS], [1, 1, 1, 0, 1, 0]);
  for (const e of cut.edges) assert.equal(g.flowOn(e), g.orig[e], 'cut edges are saturated');
});

test('Edmonds-Karp: hand-solved evacuation-like network (two routes, shared bridge, shelter limit)', () => {
  // 0 = super-source, 1 = area A (100 people), 2 = area B (60), 3 = bridge junction, 4 = shelter X (cap 70),
  // 5 = shelter Y (cap 200), 6 = super-sink. Roads: A-3 (80), B-3 (80), 3-X (150), A-Y (30), 3-Y (40).
  const g = new FlowNetwork(7);
  g.addEdge(0, 1, 100); g.addEdge(0, 2, 60);
  g.addEdge(1, 3, 80); g.addEdge(2, 3, 80); g.addEdge(3, 4, 150); g.addEdge(1, 5, 30); g.addEdge(3, 5, 40);
  g.addEdge(4, 6, 70); g.addEdge(5, 6, 200);
  // by hand: shelter X takes 70 via 3; Y gets 30 (A direct) + 40 (via 3) = 70; total 140 of 160
  assert.equal(g.maxFlow(0, 6).flow, 140);
  assert.equal(g.minCut(0).capacity, 140);
});

function bruteMinCut(n, edges, s, t) {
  let best = Infinity;
  for (let mask = 0; mask < 1 << n; mask++) {
    if (!(mask & (1 << s)) || mask & (1 << t)) continue;
    let c = 0;
    for (const [u, v, cap] of edges) if (mask & (1 << u) && !(mask & (1 << v))) c += cap;
    best = Math.min(best, c);
  }
  return best;
}

test('max flow = brute-force minimum cut (all 2^n vertex subsets) on 300 random tiny networks', () => {
  const r = rng(77);
  for (let k = 0; k < 300; k++) {
    const n = 3 + Math.floor(r() * 5);                         // 3..7 vertices
    const edges = [];
    for (let i = 0; i < n * 2; i++) {
      const u = Math.floor(r() * n), v = Math.floor(r() * n);
      if (u !== v) edges.push([u, v, Math.floor(r() * 10)]);
    }
    const g = new FlowNetwork(n);
    edges.forEach(([u, v, c]) => g.addEdge(u, v, c));
    const { flow } = g.maxFlow(0, n - 1);
    assert.equal(flow, bruteMinCut(n, edges, 0, n - 1), `case ${k}`);
    const cut = g.minCut(0);
    assert.equal(cut.capacity, flow, 'our cut is a minimum cut');
    // flow conservation at every inner vertex
    for (let v = 1; v < n - 1; v++) {
      let net = 0;
      for (let e = 0; e < g.to.length; e += 2) { if (g.to[e] === v) net += g.flowOn(e); if (g.from[e] === v) net -= g.flowOn(e); }
      assert.equal(net, 0);
    }
  }
});

// ---------------- k-center ----------------
// Symmetric (two-way) random graph so the 2-approximation bound applies.
function symmetricGraph(seed, n, m) {
  const r = rng(seed);
  const g = new Graph();
  for (let i = 0; i < n; i++) g.addLocation({ id: `v${i}`, lat: 18.5 + r() * 0.02, lng: 73.8 + r() * 0.02 });
  let k = 0;
  for (let i = 1; i < n; i++) g.addRoad({ id: `e${k++}`, from: `v${i}`, to: `v${Math.floor(r() * i)}`, lengthM: 100, baseTimeS: 10 + Math.floor(r() * 90) });
  while (k < m) {
    const a = Math.floor(r() * n), b = Math.floor(r() * n);
    if (a !== b) g.addRoad({ id: `e${k++}`, from: `v${a}`, to: `v${b}`, lengthM: 100, baseTimeS: 10 + Math.floor(r() * 90) });
  }
  return g;
}

const radius = (g, centers) => Math.max(...dijkstraAll(g, centers).dist.values());

test('greedy k-center with every junction as a candidate finds the brute-force best single new station', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const g = symmetricGraph(seed, 25, 40);
    const ids = [...g.locations.keys()];
    const existing = ['v0', 'v3'];
    let best = Infinity;
    for (const c of ids) best = Math.min(best, radius(g, [...existing, c]));
    const r = greedyKCenter(g, existing, 1, ids);
    assert.equal(r.after.worstS, best, `seed ${seed}`);
    assert.ok(r.after.worstS <= r.before.worstS);
  }
});

test('Gonzalez farthest-first is within 2x of the brute-force optimal k-center (k = 2, 3) on symmetric graphs', () => {
  for (let seed = 30; seed < 45; seed++) {
    const g = symmetricGraph(seed, 12, 20);
    const ids = [...g.locations.keys()];
    for (const k of [2, 3]) {
      let opt = Infinity;
      const choose = (start, picked) => {
        if (picked.length === k) { opt = Math.min(opt, radius(g, picked)); return; }
        for (let i = start; i < ids.length; i++) choose(i + 1, [...picked, ids[i]]);
      };
      choose(0, []);
      const ff = farthestFirst(g, [], k);
      assert.ok(ff.worstS <= 2 * opt + 1e-9, `seed ${seed} k=${k}: ${ff.worstS} vs opt ${opt}`);
    }
  }
});

test('farthest-first adds the junction farthest from the existing stations', () => {
  const g = symmetricGraph(5, 20, 30);
  const d = dijkstraAll(g, ['v0']).dist;
  const far = [...d].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  assert.equal(farthestFirst(g, ['v0'], 1).picks[0].nodeId, far[0]);
});
