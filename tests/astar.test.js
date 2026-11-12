import test from 'node:test';
import assert from 'node:assert/strict';
import { astar, maxHeuristicSpeedMps } from '../shared/graph/astar.js';
import { dijkstra } from '../shared/graph/dijkstra.js';
import { haversineM } from '../shared/spatial/haversine.js';
import { smallGraph, randomGraph, bellmanFord, routeIsValid, rng, hasPuneData, loadPune } from './helpers.js';

test('A* finds the same optimal route as Dijkstra on the diamond, incl. blocks and penalties', () => {
  const g = smallGraph();
  assert.deepEqual(astar(g, 'A', 'D').path, ['A', 'C', 'E', 'D']);
  g.setRoadStatus('r3', 'HIGH_RISK');
  assert.equal(astar(g, 'A', 'D').totalCost, dijkstra(g, 'A', 'D').totalCost);
  g.setRoadStatus('r1', 'BLOCKED');
  g.setRoadStatus('r3', 'BLOCKED');
  assert.equal(astar(g, 'A', 'D').reachable, false);
  assert.deepEqual(astar(g, 'A', 'A').path, ['A']);
  assert.throws(() => astar(g, 'A', 'nope'));
});

test('A* cost equals Bellman-Ford on 30 random road graphs, every pair', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = randomGraph(seed, 25, 55);
    for (const s of g.locations.keys()) {
      const bf = bellmanFord(g, s);
      for (const t of g.locations.keys()) {
        const r = astar(g, s, t);
        if (bf.get(t) === Infinity) assert.equal(r.reachable, false, `seed ${seed}: ${s}->${t}`);
        else {
          assert.ok(Math.abs(r.totalCost - bf.get(t)) < 1e-6, `seed ${seed}: ${s}->${t} ${r.totalCost} vs ${bf.get(t)}`);
          assert.ok(routeIsValid(g, r));
        }
      }
    }
  }
});

test('heuristic is consistent on every road: h(u) <= cost(u,v) + h(v)', () => {
  const g = randomGraph(7, 80, 200);
  const vmax = maxHeuristicSpeedMps(g);
  const t = g.getLocation('v0');
  const h = (id) => { const p = g.getLocation(id); return haversineM(p.lat, p.lng, t.lat, t.lng) / vmax; };
  for (const u of g.locations.keys()) for (const e of g.neighbors(u)) assert.ok(h(u) <= e.cost + h(e.to) + 1e-9);
});

test('A* cost equals Dijkstra cost on 500 random pairs of the real Pune graph, settling fewer nodes',
  { skip: !hasPuneData && 'server/data/pune-central.graph.json not generated' }, async () => {
    const { graph } = await loadPune();
    const ids = [...graph.locations.keys()];
    const r = rng(500);
    let settledA = 0, settledD = 0, reachable = 0;
    for (let i = 0; i < 500; i++) {
      const s = ids[Math.floor(r() * ids.length)], t = ids[Math.floor(r() * ids.length)];
      const a = astar(graph, s, t), d = dijkstra(graph, s, t);
      assert.equal(a.reachable, d.reachable, `${s}->${t}`);
      if (!a.reachable) continue;
      reachable++;
      assert.ok(Math.abs(a.totalCost - d.totalCost) < 1e-6, `${s}->${t}: A* ${a.totalCost} vs Dijkstra ${d.totalCost}`);
      settledA += a.stats.settled;
      settledD += d.stats.settled;
    }
    assert.equal(reachable, 500, 'graph is one strongly connected component, so every pair is reachable');
    assert.ok(settledA < settledD, `A* settled ${settledA}, Dijkstra ${settledD}`);
  });

test('A* stays optimal on the Pune graph after closures and traffic',
  { skip: !hasPuneData && 'Pune graph not generated' }, async () => {
    const { graph } = await loadPune();
    const r = rng(77);
    const roads = [...graph.roads.keys()];
    try {
      for (let i = 0; i < 300; i++) graph.setRoadStatus(roads[Math.floor(r() * roads.length)], r() < 0.5 ? 'BLOCKED' : 'HIGH_RISK');
      for (let i = 0; i < 1500; i++) graph.setTrafficFactor(roads[Math.floor(r() * roads.length)], 1 + 3 * r());
      const ids = [...graph.locations.keys()];
      for (let i = 0; i < 100; i++) {
        const s = ids[Math.floor(r() * ids.length)], t = ids[Math.floor(r() * ids.length)];
        const a = astar(graph, s, t), d = dijkstra(graph, s, t);
        assert.equal(a.reachable, d.reachable);
        if (a.reachable) assert.ok(Math.abs(a.totalCost - d.totalCost) < 1e-6);
      }
    } finally {
      graph.reset();
    }
  });
