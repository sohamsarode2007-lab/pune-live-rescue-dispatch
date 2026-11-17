// Phase 5: flood model (synthetic, brute force), flood service on Pune, crowd reports, dynamic rerouting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FloodModel, riverProfile } from '../shared/sim/floodModel.js';
import { FloodService, classifyDischarge, percentile } from '../server/services/floodService.js';
import { CrowdReports } from '../server/services/crowdReports.js';
import { NetworkService } from '../server/services/networkService.js';
import { DispatchService } from '../server/services/dispatchService.js';
import { randomGraph, rng, hasPuneData, loadPune, ROOT } from './helpers.js';

const D = (f) => path.join(ROOT, 'server', 'data', f);
const hasFloodData = hasPuneData && fs.existsSync(D('elevation.json')) && fs.existsSync(D('river.json'));
const skip = !hasFloodData && 'elevation.json / river.json not generated';

// ---------------- synthetic model vs brute force ----------------
function synthetic(seed) {
  const g = randomGraph(seed, 60, 130, { closures: false });
  const r = rng(seed + 1000);
  // a straight river along latitude 18.505, falling west -> east from 540 to 530
  const rivers = [{ name: 'Mutha', lines: [[[18.505, 73.79], [18.505, 73.83]]] }];
  const riverElev = { Mutha: [[540, 530]] };
  const elev = new Map([...g.locations.keys()].map((id) => [id, 530 + Math.floor(r() * 20)]));
  const model = new FloodModel({ graph: g, nodeElev: elev, riverPoints: riverProfile(rivers, riverElev), bufferM: 1500, seedM: 300, hopS: 60 });
  return { g, model };
}

// Brute force: eligible nodes connected (through eligible nodes, undirected, any road) to a seed; hop distances.
function bruteFlood(g, model, level) {
  const ids = model.ids;
  const elig = (v) => model.eligible(v, level);
  const dist = new Map();
  const q = [];
  ids.forEach((id, v) => { if (level > 0 && model.riverDist[v] <= model.opts.seedM && elig(v)) { dist.set(v, 0); q.push(v); } });
  for (let i = 0; i < q.length; i++) {
    const v = q[i];
    for (const r of g.roads.values()) {
      const a = model.index.get(r.from), b = model.index.get(r.to);
      const w = a === v ? b : b === v ? a : -1;
      if (w >= 0 && !dist.has(w) && elig(w)) { dist.set(w, dist.get(v) + 1); q.push(w); }
    }
  }
  return new Map([...dist].map(([v, h]) => [ids[v], h]));
}

test('flood plan equals brute force: eligible junctions connected to the river, BFS hop times', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { g, model } = synthetic(seed);
    for (const level of [0, 2, 5, 9]) {
      const plan = model.plan(level);
      const want = bruteFlood(g, model, level);
      assert.equal(plan.flooded, want.size, `seed ${seed} level ${level}`);
      for (const [id, hops] of want) assert.equal(plan.floodTimeS.get(id), hops * 60, `seed ${seed} ${id}`);
    }
  }
});

test('higher water floods a superset; level 0 floods nothing; low pockets not linked to the river stay dry', () => {
  for (let seed = 30; seed < 40; seed++) {
    const { model } = synthetic(seed);
    assert.equal(model.plan(0).flooded, 0);
    let prev = new Set();
    for (const level of [1, 3, 5, 8, 12]) {
      const now = new Set(model.plan(level).floodTimeS.keys());
      for (const id of prev) assert.ok(now.has(id), `seed ${seed}: ${id} dried up at a higher level`);
      prev = now;
    }
    const p = model.plan(12);
    assert.ok(p.flooded <= p.eligible);
  }
});

test('road statuses grow over time: BLOCKED iff touching a flooded junction; neighbours become HIGH_RISK', () => {
  const { g, model } = synthetic(7);
  const plan = model.plan(8);
  let last = -1;
  for (const t of [0, 60, 120, 240, 1e9]) {
    const { statuses, floodedNow } = model.roadStatuses(plan, t);
    assert.ok(floodedNow >= last); last = floodedNow;
    for (const r of g.roads.values()) {
      const fl = (id) => (plan.floodTimeS.get(id) ?? Infinity) <= t;
      assert.equal(statuses.get(r.id) === 'BLOCKED', fl(r.from) || fl(r.to), `${r.id} at ${t}`);
    }
  }
});

test('GloFAS classification: percentiles of the history decide normal / elevated / flood alert', () => {
  const hist = Array.from({ length: 1000 }, (_, i) => i);      // 0..999
  assert.equal(percentile(hist, 0.9), 899.1);
  assert.equal(classifyDischarge(500, hist).status, 'normal');
  assert.equal(classifyDischarge(950, hist).status, 'elevated');
  assert.equal(classifyDischarge(995, hist).status, 'flood alert');
});

// ---------------- Pune ----------------
function loadData() {
  return { elevation: JSON.parse(fs.readFileSync(D('elevation.json'), 'utf8')), rivers: JSON.parse(fs.readFileSync(D('river.json'), 'utf8')).rivers };
}

function fakeOpenMeteo({ current = 50, down = false } = {}) {
  const log = [];
  const fetchImpl = async (url) => {
    log.push(url);
    if (down) throw new Error('ENOTFOUND');
    const u = new URL(url);
    if (u.searchParams.get('start_date')) {
      return { ok: true, json: async () => ({ latitude: 18.53, longitude: 73.86, daily: { time: Array.from({ length: 2000 }, (_, i) => `d${i}`), river_discharge: Array.from({ length: 2000 }, (_, i) => i % 100) } }) };
    }
    return { ok: true, json: async () => ({ latitude: 18.53, longitude: 73.86, daily: { time: ['a', 'b', 'c'], river_discharge: [current / 2, current, current / 3] } }) };
  };
  return { fetchImpl, log };
}

test('GloFAS via a fake Open-Meteo: suggested level, cached on disk, outage keeps the last result', { skip }, async () => {
  const store = await loadPune();
  const { elevation, rivers } = loadData();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flood-'));
  const files = { historyFile: path.join(dir, 'h.json'), currentFile: path.join(dir, 'c.json') };
  const alert = fakeOpenMeteo({ current: 99.5 });
  const f = new FloodService({ store, elevation, rivers, fetchImpl: alert.fetchImpl, ...files });
  const g = await f.refreshGlofas();
  assert.equal(g.ok, true);
  assert.equal(g.status, 'flood alert');
  assert.equal(g.suggestedLevel, 8);
  assert.match(g.caveat, /does not capture Khadakwasla/);
  assert.equal(alert.log.length, 2);
  await f.refreshGlofas();
  assert.equal(alert.log.length, 2, 'cached for 6 h');
  const down = fakeOpenMeteo({ down: true });
  const f2 = new FloodService({ store, elevation, rivers, fetchImpl: down.fetchImpl, ...files });
  assert.equal(f2.glofas.status, 'flood alert', 'last result loaded from disk');
  const g2 = await f2.refreshGlofas({ force: true });
  assert.equal(g2.ok, false);
  assert.match(g2.error, /unavailable/);
  assert.equal(g2.status, 'flood alert', 'previous figures kept');
});

test('flood on Pune: spreads over sim time, recedes completely, never reopens a manual closure', { skip }, async () => {
  const store = await loadPune();
  store.resetRoads();
  const { elevation, rivers } = loadData();
  const f = new FloodService({ store, elevation, rivers });
  const manual = [...store.graph.roads.values()].find((r) => r.highway === 'primary').id;
  try {
    store.setRoadStatus(manual, 'BLOCKED', 'manual');
    f.setLevel(10, 0);
    const counts = [];
    for (const t of [0, 90, 180, 360, 3600]) { f.tick(t); counts.push(f.status().blockedRoads); }
    for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1], `blocked roads never shrink while rising: ${counts}`);
    assert.ok(counts.at(-1) > counts[0], `flood grows: ${counts}`);
    assert.ok(counts.at(-1) > 100);
    for (const [id, s] of f.applied) assert.equal(store.graph.getRoad(id).status, s);
    f.setLevel(0, 3600);
    const back = f.tick(3601);
    assert.ok(back.reopened.length > 100);
    assert.equal(f.applied.size, 0);
    assert.equal(store.graph.getRoad(manual).status, 'BLOCKED', 'manual closure untouched');
    assert.deepEqual(store.graph.countRoadsByStatus(), { OPEN: store.graph.roads.size - 1, HIGH_RISK: 0, BLOCKED: 1 });
  } finally {
    store.resetRoads();
  }
});

test('the flood updates the crossing ranking and the trap-zone (SCC) analysis', { skip }, async () => {
  const store = await loadPune();
  store.resetRoads();
  const { elevation, rivers } = loadData();
  const net = NetworkService.fromFile(store, D('river.json'));
  const f = new FloodService({ store, elevation, rivers });
  try {
    const before = await net.rankCrossings();
    assert.ok(before.ranking.every((c) => !c.closed));
    const v0 = store.graph.version;
    f.setLevel(12, 0); f.tick(1e6);
    assert.ok(store.graph.version > v0);
    const after = await net.rankCrossings();
    assert.equal(after.version, store.graph.version, 'ranking recomputed for the flooded network');
    assert.ok(after.ranking.some((c) => c.closed), 'low bridges are under water');
    assert.ok(after.baseline.fire.avgS > before.baseline.fire.avgS, 'response times get worse');
    const scc = net.scc();
    assert.equal(scc.zones.length + scc.trivialZones, scc.components - 1, 'every non-main SCC is a listed or a counted zone');
    assert.ok(scc.trivialZones > 0, 'flooded single junctions are counted, not listed');
  } finally {
    store.resetRoads();
  }
});

// ---------------- crowd reports ----------------
test('crowd reports: a road closes only after 3 DIFFERENT phones within 15 minutes', { skip }, async () => {
  const store = await loadPune();
  store.resetRoads();
  let now = 0;
  const crowd = new CrowdReports({ store, now: () => now });
  const road = [...store.graph.roads.values()].find((r) => r.highway === 'secondary' && r.lengthM > 200);
  const g = store.graph.roadGeometry(road.id, road.from);
  const p = { lat: g[Math.floor(g.length / 2)][0], lng: g[Math.floor(g.length / 2)][1] };
  try {
    assert.equal(crowd.report({ ...p, clientId: 'a' }).roadId, road.id);
    assert.equal(crowd.report({ ...p, clientId: 'a' }).count, 1, 'same phone counts once');
    now = 120_000;
    assert.equal(crowd.report({ ...p, clientId: 'b' }).blocked, false);
    now = 16 * 60_000;                                        // phone a's report has expired
    let r = crowd.report({ ...p, clientId: 'c' });
    assert.equal(r.count, 2);
    assert.equal(store.graph.getRoad(road.id).status, 'OPEN');
    now += 1000;
    r = crowd.report({ ...p, clientId: 'd' });
    assert.equal(r.newlyBlocked, true);
    assert.equal(store.graph.getRoad(road.id).status, 'BLOCKED');
    assert.equal(store.closureSource.get(road.id), 'crowd');
    assert.equal(crowd.report({ lat: 18.0, lng: 73.0, clientId: 'x' }).ok, false, 'nowhere near a road');
  } finally {
    store.resetRoads();
  }
});

// ---------------- dynamic rerouting ----------------
test('rerouting: a closure ahead of a moving unit re-plans from its next junction; unreachable incidents go back to the queue',
  { skip }, async () => {
    const store = await loadPune();
    store.resetRoads();
    const log = [];
    const svc = new DispatchService(store, { emit: (event, payload) => log.push({ event, payload }) });
    try {
      const inc = svc.createIncident({ lat: 18.5308, lng: 73.8475, type: 'fire', severity: 'HIGH', people: 2 });
      const unit = svc.units.get(inc.unitId);
      svc.tick(20_000);
      const ahead = unit.trip.roadIds.slice(-3, -2);              // a road near the end of its route
      const oldEta = inc.etaS;
      for (const id of ahead) store.setRoadStatus(id, 'BLOCKED');
      const ev = svc.roadsBlocked(ahead);
      assert.equal(ev.length, 1);
      assert.equal(ev[0].outcome, 'rerouted');
      assert.ok(!unit.trip.roadIds.includes(ahead[0]), 'new route avoids the closed road');
      assert.ok(inc.etaS >= oldEta - 1e-6);
      assert.equal(inc.etaS, unit.trip.endS);
      assert.ok(log.some((l) => l.event === 'unit:rerouted'));
      while (inc.status === 'EN_ROUTE') svc.tick(10_000);
      assert.ok(Math.abs(inc.arrivedS - inc.etaS) < 1e-6, 'arrives at the re-planned ETA');

      // close every road into a second incident: its unit cannot get there -> back to PENDING
      const inc2 = svc.createIncident({ lat: 18.5074, lng: 73.8077, type: 'medical', severity: 'LOW', people: 1 });
      svc.tick(10_000);
      const around = [...store.graph.adjacency.get(inc2.nodeId).map((e) => e.roadId), ...store.graph.inNeighbors(inc2.nodeId).map((e) => e.roadId)];
      for (const id of around) store.setRoadStatus(id, 'BLOCKED');
      const ev2 = svc.roadsBlocked(around);
      assert.equal(ev2[0]?.outcome, 'incident-unreachable');
      assert.equal(inc2.status, 'PENDING');
      assert.equal(inc2.unitId, null);
    } finally {
      store.resetRoads();
    }
  });

test('lowering the water level: water that had not arrived yet follows the lower level\'s timetable', { skip }, async () => {
  const store = await loadPune();
  const { elevation, rivers } = loadData();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flood-'));
  const f = new FloodService({ store, elevation, rivers, historyFile: path.join(dir, 'h.json'), currentFile: path.join(dir, 'c.json') });
  f.setLevel(10, 0, 'manual');
  f.setLevel(4, 100, 'manual');
  const rel = f.model.plan(4).floodTimeS;
  let future = 0;
  for (const [id, t] of f.plan.floodTimeS) if (t > 100) { future++; assert.equal(t, 100 + rel.get(id)); }
  assert.ok(future > 0);
});
