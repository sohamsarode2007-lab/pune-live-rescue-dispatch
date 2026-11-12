import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../shared/graph/Graph.js';
import { bridgesAndArticulationPoints, stronglyConnectedComponents, trapZones, FACILITY_KINDS } from '../shared/graph/tarjan.js';
import { dijkstraAll, dijkstraMulti } from '../shared/graph/dijkstra.js';
import { randomGraph, rng, hasPuneData, loadPune } from './helpers.js';

// ---------- brute force helpers (undirected, non-blocked roads) ----------
function undirectedPieces(g, { skipRoad = null, skipNode = null } = {}) {
  const adj = new Map([...g.locations.keys()].map((k) => [k, []]));
  for (const r of g.roads.values()) {
    if (r.status === 'BLOCKED' || r.id === skipRoad || r.from === r.to) continue;
    adj.get(r.from).push(r.to); adj.get(r.to).push(r.from);
  }
  const seen = new Set(), pieces = [];
  for (const s of adj.keys()) {
    if (s === skipNode || seen.has(s)) continue;
    const piece = [s]; seen.add(s);
    for (let i = 0; i < piece.length; i++) for (const w of adj.get(piece[i])) if (w !== skipNode && !seen.has(w)) { seen.add(w); piece.push(w); }
    pieces.push(piece);
  }
  return pieces;
}

const facCount = (nodes, facilityNodes) => {
  const f = Object.fromEntries(FACILITY_KINDS.map((k) => [k, 0]));
  for (const id of nodes) for (const [k, n] of Object.entries(facilityNodes.get(id) ?? {})) f[k] += n;
  return f;
};

// Random graph with tree-like appendages (dead ends, chains, a doubled road) so bridges and APs exist.
function treeyGraph(seed) {
  const r = rng(seed);
  const g = randomGraph(seed, 18, 26, { closures: true });
  let k = 0;
  const n0 = g.locations.size;
  for (let i = 0; i < 14; i++) {
    const id = `t${i}`;
    g.addLocation({ id, lat: 18.5 + r() * 0.02, lng: 73.8 + r() * 0.02 });
    const parent = i > 0 && r() < 0.5 ? `t${Math.floor(r() * i)}` : `v${Math.floor(r() * n0)}`;
    g.addRoad({ id: `x${k++}`, from: parent, to: id, lengthM: 50, baseTimeS: 5, oneWay: r() < 0.3 });
  }
  g.addRoad({ id: `x${k++}`, from: 't0', to: g.getRoad('x0').from, lengthM: 50, baseTimeS: 5 });   // a parallel road
  const facilityNodes = new Map();
  for (const id of g.locations.keys()) {
    const x = r();
    if (x < 0.06) facilityNodes.set(id, { hospital: 1 });
    else if (x < 0.1) facilityNodes.set(id, { fire_station: 1 });
  }
  return { g, facilityNodes };
}

test('bridges and articulation points equal brute force (remove each road / junction) on 60 random graphs', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const { g, facilityNodes } = treeyGraph(seed);
    const res = bridgesAndArticulationPoints(g, { facilityNodes });
    const base = undirectedPieces(g);
    const compOf = new Map(); base.forEach((p) => p.forEach((v) => compOf.set(v, p)));

    // bridges
    const want = new Set();
    for (const r of g.roads.values()) {
      if (r.status === 'BLOCKED') continue;
      if (undirectedPieces(g, { skipRoad: r.id }).length > base.length) want.add(r.id);
    }
    assert.deepEqual(new Set(res.bridges.map((b) => b.roadId)), want, `seed ${seed} bridges`);
    for (const b of res.bridges) {                      // cut-off size and facilities vs brute force
      const after = undirectedPieces(g, { skipRoad: b.roadId });
      const sides = after.filter((p) => p.includes(b.from) || p.includes(b.to)).sort((x, y) => x.length - y.length);
      assert.equal(b.cutJunctions, sides[0].length, `seed ${seed} bridge ${b.roadId}`);
      if (sides[0].length !== sides[1].length) assert.deepEqual(b.facilitiesCutOff, facCount(sides[0], facilityNodes));
    }

    // articulation points
    const wantAp = new Set();
    for (const v of g.locations.keys()) {
      const after = undirectedPieces(g, { skipNode: v });
      const before = base.length - (compOf.get(v).length === 1 ? 1 : 0);  // an isolated vertex just disappears
      if (after.length > before) wantAp.add(v);
    }
    assert.deepEqual(new Set(res.articulationPoints.map((a) => a.nodeId)), wantAp, `seed ${seed} articulation points`);
    for (const a of res.articulationPoints) {
      const pieces = undirectedPieces(g, { skipNode: a.nodeId }).filter((p) => compOf.get(a.nodeId).includes(p[0]));
      const sizes = pieces.map((p) => p.length).sort((x, y) => y - x);
      assert.equal(a.pieces, pieces.length);
      assert.equal(a.cutJunctions, sizes.slice(1).reduce((s, x) => s + x, 0), `seed ${seed} AP ${a.nodeId}`);
    }
  }
});

test('a doubled road is never a bridge; a lone road to a dead end is', () => {
  const g = new Graph();
  ['a', 'b', 'c'].forEach((id, i) => g.addLocation({ id, lat: 18.5, lng: 73.8 + i / 1000 }));
  g.addRoad({ id: 'r1', from: 'a', to: 'b', lengthM: 1, baseTimeS: 1 });
  g.addRoad({ id: 'r2', from: 'a', to: 'b', lengthM: 1, baseTimeS: 1 });
  g.addRoad({ id: 'r3', from: 'b', to: 'c', lengthM: 1, baseTimeS: 1, oneWay: true });   // one-way counts as a physical link
  const r = bridgesAndArticulationPoints(g, { facilityNodes: new Map([['c', { hospital: 1 }]]) });
  assert.deepEqual(r.bridges.map((b) => b.roadId), ['r3']);
  assert.deepEqual(r.articulationPoints.map((a) => a.nodeId), ['b']);
  assert.equal(r.bridges[0].cutJunctions, 1);
  assert.equal(r.bridges[0].facilitiesCutOff.hospital, 1, 'the hospital is on the cut-off side');
  assert.equal(r.bridges[0].critical, true, 'cutting off a facility makes it critical');
  g.setRoadStatus('r3', 'BLOCKED');
  assert.equal(bridgesAndArticulationPoints(g).bridges.length, 0, 'closed roads are ignored');
});

test('SCC equals brute-force mutual reachability on 40 random directed graphs', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const g = randomGraph(seed, 22, 40);
    const { componentOf, components } = stronglyConnectedComponents(g);
    const reach = new Map();
    for (const s of g.locations.keys()) {
      const seen = new Set([s]), q = [s];
      for (let i = 0; i < q.length; i++) for (const e of g.neighbors(q[i])) if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
      reach.set(s, seen);
    }
    for (const u of g.locations.keys()) for (const v of g.locations.keys()) {
      const mutual = reach.get(u).has(v) && reach.get(v).has(u);
      assert.equal(componentOf(u) === componentOf(v), mutual, `seed ${seed} ${u},${v}`);
    }
    assert.equal(components.reduce((s, c) => s + c.length, 0), g.locations.size);
  }
});

test('trap zones: a one-way entry with no exit is a trap; the reverse is no-entry; a cut-off area is isolated', () => {
  const g = new Graph();
  ['m1', 'm2', 'm3', 't1', 't2'].forEach((id, i) => g.addLocation({ id, lat: 18.5, lng: 73.8 + i / 1000 }));
  for (const [id, a, b] of [['a', 'm1', 'm2'], ['b', 'm2', 'm3'], ['c', 'm3', 'm1']]) g.addRoad({ id, from: a, to: b, lengthM: 1, baseTimeS: 1 });
  g.addRoad({ id: 'in', from: 'm1', to: 't1', lengthM: 1, baseTimeS: 1, oneWay: true });
  g.addRoad({ id: 'out', from: 't2', to: 'm2', lengthM: 1, baseTimeS: 1, oneWay: true });
  g.addRoad({ id: 'tt', from: 't1', to: 't2', lengthM: 1, baseTimeS: 1 });
  assert.equal(trapZones(g).zones.length, 0, 'one SCC while every road is open');
  g.setRoadStatus('out', 'BLOCKED');
  let z = trapZones(g, { facilityNodes: new Map([['t2', { hospital: 1 }]]) });
  assert.equal(z.zones.length, 1);
  assert.equal(z.zones[0].kind, 'trap');
  assert.equal(z.zones[0].junctions, 2);
  assert.equal(z.zones[0].facilities.hospital, 1);
  g.setRoadStatus('out', 'OPEN'); g.setRoadStatus('in', 'BLOCKED');
  assert.equal(trapZones(g).zones[0].kind, 'no-entry');
  g.setRoadStatus('out', 'BLOCKED');
  assert.equal(trapZones(g).zones[0].kind, 'isolated');
});

test('multi-source Dijkstra equals the minimum over single-source runs (forward and reverse)', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const g = randomGraph(seed, 30, 70);
    const sources = ['v0', 'v5', 'v11'];
    for (const reverse of [false, true]) {
      const multi = dijkstraMulti(g, sources, { reverse }).dist;
      const singles = sources.map((s) => dijkstraAll(g, s, { reverse }).dist);
      for (const v of g.locations.keys()) {
        const best = Math.min(...singles.map((d) => d.get(v) ?? Infinity));
        assert.equal(multi.has(v), best < Infinity);
        if (best < Infinity) assert.ok(Math.abs(multi.get(v) - best) < 1e-9);
      }
    }
  }
});

test('real Pune graph: iterative Tarjan runs deep without overflow; one SCC with every road open',
  { skip: !hasPuneData && 'Pune graph not generated' }, async () => {
    const { graph } = await loadPune();
    const r = bridgesAndArticulationPoints(graph);
    assert.equal(r.components, 1);
    assert.ok(r.maxStack > 500, `DFS depth ${r.maxStack}`);
    assert.ok(r.bridges.length > 100, `${r.bridges.length} bridges`);
    assert.ok(r.bridges.filter((b) => !b.critical).length > r.bridges.filter((b) => b.critical).length, 'most bridges are trivial dead ends');
    assert.equal(stronglyConnectedComponents(graph).components.length, 1);
  });
