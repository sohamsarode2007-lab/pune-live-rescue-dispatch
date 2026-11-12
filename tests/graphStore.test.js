// Checks on the generated real-Pune data and the server-side graph store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineM, polylineLengthM } from '../shared/spatial/haversine.js';
import { graphFromJson, routeGeometry } from '../server/services/graphStore.js';
import { astar } from '../shared/graph/astar.js';
import { bfs } from '../shared/graph/bfs.js';
import { hasPuneData, loadPune, routeIsValid } from './helpers.js';

const skip = !hasPuneData && 'server/data/pune-central.graph.json not generated';

test('graphFromJson: baseTimeS = lengthM / speed, one-way respected, geometry kept', () => {
  const g = graphFromJson({
    nodes: [{ id: '1', lat: 18.5, lng: 73.8 }, { id: '2', lat: 18.501, lng: 73.8 }],
    edges: [{ id: 'e0', from: '1', to: '2', lengthM: 360, highway: 'primary', maxspeedKmh: 36, oneway: true, name: 'X', geometry: [[18.5, 73.8], [18.501, 73.8]] }],
  });
  const r = g.getRoad('e0');
  assert.equal(r.baseTimeS, 36);                       // 360 m at 10 m/s
  assert.equal(g.neighbors('1').length, 1);
  assert.equal(g.neighbors('2').length, 0);            // cannot drive against a one-way street
});

test('Pune graph: sane size, all IDs valid, bbox respected, strongly connected', { skip }, async () => {
  const { graph, meta } = await loadPune();
  assert.ok(graph.locations.size > 3000, `${graph.locations.size} junctions`);
  assert.ok(graph.roads.size > graph.locations.size);
  const { north, south, east, west } = meta.bbox;
  for (const l of graph.locations.values()) {
    assert.ok(l.lat > south - 0.01 && l.lat < north + 0.01 && l.lng > west - 0.01 && l.lng < east + 0.01, l.id);
  }
  // Strong connectivity: BFS forward from one junction reaches all; same on the reversed graph.
  const start = graph.locations.keys().next().value;
  assert.equal(bfs(graph, start).reachable.size, graph.locations.size);
  const rev = new Map([...graph.locations.keys()].map((k) => [k, []]));
  for (const [u, edges] of graph.adjacency) for (const e of edges) rev.get(e.to).push(u);
  const seen = new Set([start]); const q = [start];
  for (let i = 0; i < q.length; i++) for (const v of rev.get(q[i])) if (!seen.has(v)) { seen.add(v); q.push(v); }
  assert.equal(seen.size, graph.locations.size);
});

test('Pune graph: every road is plausible (length >= straight line, geometry ends on its junctions, speed set)', { skip }, async () => {
  const { graph } = await loadPune();
  let oneWay = 0;
  for (const r of graph.roads.values()) {
    const a = graph.getLocation(r.from), b = graph.getLocation(r.to);
    assert.ok(r.lengthM + 1 >= haversineM(a.lat, a.lng, b.lat, b.lng), `${r.id} shorter than straight line`);
    assert.ok(haversineM(a.lat, a.lng, r.geometry[0][0], r.geometry[0][1]) < 2, `${r.id} geometry start`);
    assert.ok(haversineM(b.lat, b.lng, r.geometry.at(-1)[0], r.geometry.at(-1)[1]) < 2, `${r.id} geometry end`);
    assert.ok(Math.abs(polylineLengthM(r.geometry) - r.lengthM) < Math.max(3, r.lengthM * 0.02), `${r.id} geometry length`);
    assert.ok(r.maxspeedKmh >= 5 && r.maxspeedKmh <= 120 && r.baseTimeS > 0);
    if (r.oneWay) oneWay++;
  }
  assert.ok(oneWay > 0, 'central Pune has one-way streets');
});

test('Pune routing: one-way streets are never driven backwards; route geometry is continuous', { skip }, async () => {
  const store = await loadPune();
  const { graph } = store;
  const ow = [...graph.roads.values()].filter((r) => r.oneWay).slice(0, 50);
  for (const road of ow) {
    const back = astar(graph, road.to, road.from);
    assert.ok(routeIsValid(graph, back));
    assert.ok(!back.roadIds.includes(road.id), `${road.id} driven against its one-way direction`);
    const geom = routeGeometry(graph, back);
    for (let i = 1; i < geom.length; i++) assert.ok(haversineM(geom[i - 1][0], geom[i - 1][1], geom[i][0], geom[i][1]) < 2000);
    const first = graph.getLocation(road.to), last = graph.getLocation(road.from);
    assert.ok(haversineM(geom[0][0], geom[0][1], first.lat, first.lng) < 2);
    assert.ok(haversineM(geom.at(-1)[0], geom.at(-1)[1], last.lat, last.lng) < 2);
  }
});

test('GraphStore.route: snaps GPS points, A* and Dijkstra agree, blocking a used road reroutes', { skip }, async () => {
  const store = await loadPune();
  const from = { lat: 18.5074, lng: 73.8077 };   // Kothrud
  const to = { lat: 18.5308, lng: 73.8475 };     // Shivajinagar
  const res = store.route(from, to);
  assert.ok(res.from.distanceM < 300 && res.to.distanceM < 300);
  const { astar: a, dijkstra: d } = res.results;
  assert.ok(a.reachable && d.reachable);
  assert.ok(Math.abs(a.totalCostS - d.totalCostS) < 1e-6);
  assert.ok(a.settled <= d.settled);
  assert.ok(a.totalLengthM > 3000 && a.totalLengthM < 12000, `${a.totalLengthM} m`);
  const used = a.roadIds[Math.floor(a.roadIds.length / 2)];
  try {
    store.setRoadStatus(used, 'BLOCKED');
    const again = store.route(from, to).results.astar;
    assert.ok(!again.roadIds.includes(used));
    assert.ok(again.totalCostS >= a.totalCostS - 1e-9);
    assert.equal(store.closedRoads().length, 1);
  } finally {
    store.resetRoads();
  }
});

test('facilities: real OSM facilities snapped to existing junctions; simulated values flagged', { skip }, async () => {
  const { graph, facilities, units } = await loadPune();
  assert.ok(facilities.some((f) => f.kind === 'hospital'));
  assert.ok(facilities.some((f) => f.kind === 'fire_station'));
  for (const f of facilities) {
    assert.ok(graph.hasLocation(f.nodeId), `${f.id} snapped to unknown node`);
    if (f.kind === 'hospital') assert.ok(f.simulated.includes('bedsFree') && f.bedsFree >= 0);
  }
  const ids = new Set(facilities.map((f) => f.id));
  for (const u of units) {
    assert.ok(u.simulated && ids.has(u.stationId) && graph.hasLocation(u.homeNodeId));
    assert.ok(['ambulance', 'fire_truck', 'rescue_boat'].includes(u.type));
  }
  assert.equal(new Set(units.map((u) => u.id)).size, units.length);
});
