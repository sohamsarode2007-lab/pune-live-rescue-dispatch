// Network resilience on the real Pune graph: river crossings, crossing importance, trap zones.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { NetworkService } from '../server/services/networkService.js';
import { dijkstraMulti } from '../shared/graph/dijkstra.js';
import { hasPuneData, loadPune, ROOT } from './helpers.js';

const skip = !hasPuneData && 'Pune graph not generated';
const RIVER = path.join(ROOT, 'server', 'data', 'river.json');
let shared = null;
async function net() {
  const store = await loadPune();
  store.resetRoads();
  if (!shared) shared = NetworkService.fromFile(store, RIVER);
  return { store, net: shared };
}

test('Mutha crossings are found from OSM bridge tags + geometry, with real names', { skip }, async () => {
  const { net: n, store } = await net();
  assert.ok(n.crossingDefs.length >= 5, `${n.crossingDefs.length} crossings`);
  for (const c of n.crossingDefs) {
    assert.match(c.river, /mutha/i);
    for (const id of c.roadIds) assert.equal(store.graph.getRoad(id).bridge, true);
  }
  const names = n.crossingDefs.map((c) => c.name).join(' | ');
  assert.match(names, /Sambhaji Bridge/);
  assert.match(names, /Shivaji Bridge/);
});

test('crossing importance equals a brute-force recomputation with the crossing actually closed; ranking leaves the graph untouched',
  { skip }, async () => {
    const { net: n, store } = await net();
    const g = store.graph;
    const before = g.version;
    const r = await n.rankCrossings();
    assert.equal(g.version, before, 'ranking uses excluded roads, it never closes anything');
    assert.equal(r.ranking.length, n.crossingDefs.length);
    for (let i = 1; i < r.ranking.length; i++) assert.ok(r.ranking[i - 1].fire.avgIncreaseS >= r.ranking[i].fire.avgIncreaseS);
    for (const c of r.ranking) assert.ok(c.fire.avgIncreaseS >= 0 && c.allBases.avgIncreaseS >= 0, 'losing roads never helps');

    const top = r.ranking[0];
    const base = dijkstraMulti(g, n.fireNodes).dist;
    try {
      for (const id of top.roadIds) g.setRoadStatus(id, 'BLOCKED');
      const after = dijkstraMulti(g, n.fireNodes).dist;
      let s0 = 0, s1 = 0, k = 0;
      for (const v of g.locations.keys()) if (base.has(v) && after.has(v)) { s0 += base.get(v); s1 += after.get(v); k++; }
      assert.ok(Math.abs((s1 - s0) / k - top.fire.avgIncreaseS) < 0.06, `${(s1 - s0) / k} vs ${top.fire.avgIncreaseS}`);
    } finally {
      for (const id of top.roadIds) g.setRoadStatus(id, 'OPEN');
    }
  });

test('closing a critical Tarjan bridge creates an isolated zone of exactly the predicted size; reopening clears it',
  { skip }, async () => {
    const { net: n, store } = await net();
    const spof = n.spof();
    assert.ok(spof.counts.criticalBridges > 0 && spof.counts.criticalBridges < spof.counts.bridges);
    const b = spof.bridges.find((x) => x.critical);
    assert.equal(n.scc().zones.length, 0);
    try {
      store.setRoadStatus(b.roadId, 'BLOCKED');
      const zones = n.scc().zones;
      assert.ok(zones.length >= 1);
      assert.equal(zones[0].kind, 'isolated');
      assert.equal(zones[0].junctions, b.cutJunctions);
    } finally {
      store.setRoadStatus(b.roadId, 'OPEN');
    }
    assert.equal(n.scc().zones.length, 0);
  });
