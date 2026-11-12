// Phase 6 on the real Pune graph: shelters, coverage isochrones, station placement, evacuation, demo scenario.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FloodService } from '../server/services/floodService.js';
import { PlanningService, COVER_S } from '../server/services/planningService.js';
import { NetworkService } from '../server/services/networkService.js';
import { DispatchService } from '../server/services/dispatchService.js';
import { ScenarioRunner, monsoonScenario, simStep } from '../server/services/scenario.js';
import { dijkstraAll } from '../shared/graph/dijkstra.js';
import { haversineM } from '../shared/spatial/haversine.js';
import { hasPuneData, loadPune, ROOT } from './helpers.js';

const D = (f) => path.join(ROOT, 'server', 'data', f);
const skip = !(hasPuneData && fs.existsSync(D('elevation.json'))) && 'Pune data not generated';
const json = (f) => JSON.parse(fs.readFileSync(D(f), 'utf8'));

async function setup() {
  const store = await loadPune();
  store.resetRoads();
  const flood = new FloodService({ store, elevation: json('elevation.json'), rivers: json('river.json').rivers });
  return { store, flood, planning: new PlanningService({ store, flood }) };
}

test('shelters: schools / colleges / halls from OSM with simulated capacity by type; counted by Tarjan', { skip }, async () => {
  const { store } = await setup();
  const shelters = store.facilities.filter((f) => f.kind === 'shelter');
  assert.ok(shelters.length > 100, `${shelters.length} shelters`);
  const cap = store.facilitiesMeta.shelters.capacityPerType;
  for (const s of shelters) {
    assert.ok(store.graph.hasLocation(s.nodeId));
    assert.equal(s.capacity, cap[s.shelterType]);
    assert.deepEqual(s.simulated, ['capacity']);
  }
  const net = NetworkService.fromFile(store, D('river.json'));
  assert.ok([...net.facilityNodes.values()].some((m) => m.shelter > 0), 'shelters are facilities for Tarjan / trap zones');
  const spof = net.spof();
  assert.ok(spof.bridges.some((b) => b.facilitiesCutOff.shelter > 0) || spof.articulationPoints.some((a) => a.facilitiesCutOff.shelter > 0));
});

test('coverage: % road length within 8 min equals an independent computation, and shrinks under the flood', { skip }, async () => {
  const { store, flood, planning } = await setup();
  try {
    for (const kind of ['fire', 'ambulance']) {
      const c = planning.coverage(kind);
      const d = dijkstraAll(store.graph, kind === 'fire' ? planning.fireNodes : planning.ambulanceNodes).dist;
      let total = 0, covered = 0;
      for (const r of store.graph.roads.values()) {
        total += r.lengthM;
        const t = Math.min(d.get(r.from) ?? Infinity, r.oneWay ? Infinity : d.get(r.to) ?? Infinity);
        if (t <= COVER_S) covered += r.lengthM;
      }
      assert.ok(Math.abs(c.pct8 - (100 * covered) / total) < 0.051, `${kind}: ${c.pct8}`);
      assert.equal(c.bands.length, store.graph.roads.size);
    }
    const before = planning.coverageSummary(0).fire.pct8;
    flood.setLevel(10, 0);
    let last = before;
    for (const t of [0, 180, 360, 1e6]) {
      flood.tick(t);
      const now = planning.coverageSummary(t).fire.pct8;
      assert.ok(now <= last + 1e-9, 'coverage never grows while the water rises');
      last = now;
    }
    assert.ok(last < before - 2, `fire coverage ${before}% -> ${last}%`);
    const bands = planning.coverage('fire').bands;
    for (const id of flood.applied.keys()) {
      if (store.graph.getRoad(id).status === 'BLOCKED') assert.equal(bands[planning.roadIds.indexOf(id)], '5');
    }
    assert.ok(planning.history.length >= 2);
  } finally {
    store.resetRoads();
  }
});

test('station placement: k-center suggestion lowers the worst case in both scenarios; graph left untouched', { skip }, async () => {
  const { store, flood, planning } = await setup();
  const v = JSON.stringify(store.graph.countRoadsByStatus());
  const p = await planning.computePlacement();
  assert.equal(JSON.stringify(store.graph.countRoadsByStatus()), v, 'temporary scenario statuses were restored');
  for (const k of ['normal', 'flood']) {
    assert.ok(p[k].suggestion.worstS <= p[k].before.worstS, k);
    assert.ok(p[k].suggestion.pct8 >= p[k].before.pct8, k);
    assert.ok(store.graph.hasLocation(p[k].suggestion.nodeId));
  }
  // the flood scenario matches the live flood fully spread
  flood.setLevel(10, 0); flood.tick(1e6);
  try {
    const live = planning.coverageSummary().fire;
    assert.equal(live.worstS, p.flood.before.worstS);
    assert.equal(live.pct8, p.flood.before.pct8);
  } finally {
    store.resetRoads();
  }
});

test('evacuation (Edmonds-Karp): flow <= people, cut = flow, flood evacuates no more than normal, boat-only people counted',
  { skip }, async () => {
    const { store, flood, planning } = await setup();
    const e = await planning.computeEvacuation();
    for (const k of ['normal', 'flood']) {
      const x = e[k];
      assert.ok(x.evacuable <= x.totalPeople);
      assert.equal(x.cutCapacity, x.evacuable, `${k}: max-flow = min-cut`);
      assert.equal(x.cut.roads + x.cut.shelters + x.cut.supply, x.cutCapacity);
      for (const b of x.bottlenecks) assert.ok(store.graph.getRoad(b.roadId));
    }
    assert.ok(e.flood.evacuable <= e.normal.evacuable);
    assert.equal(e.normal.stranded, 0);
    assert.ok(e.flood.stranded > 0, 'some affected junctions have every road under water');
    assert.ok(e.flood.evacuable <= e.flood.totalPeople - e.flood.stranded);
    const blocked = flood.finalStatuses(10).blocked;
    for (const b of e.flood.bottlenecks) assert.ok(!blocked.has(b.roadId), 'bottlenecks are open roads');
  });

// ---------------- demo scenario ----------------
function runScenario(store, steps = 160) {
  store.resetRoads();
  const log = [];
  const dispatch = new DispatchService(store, { emit: (event, p) => { if (event === 'unit:rerouted') log.push(['reroute', p.unitId, p.atS, p.outcome]); } });
  const flood = new FloodService({ store, elevation: json('elevation.json'), rivers: json('river.json').rivers });
  const runner = new ScenarioRunner();
  const def = monsoonScenario(flood.riverPoints, store.meta.bbox, NetworkService.fromFile(store, D('river.json')).crossingDefs);
  dispatch.setSpeed(def.speed);
  runner.start(def, dispatch.now);
  for (let i = 0; i < steps; i++) simStep({ dispatch, flood, runner }, 500);
  const incidents = [...dispatch.incidents.values()].map((x) => [x.id, x.type, x.unitId, x.status, x.createdS, x.assignedS, x.reroutes ?? 0]);
  const result = { incidents, log, flooded: flood.floodedNow, applied: flood.applied.size, level: flood.level, def };
  store.resetRoads();
  return result;
}

test('monsoon demo scenario is deterministic: two runs give identical incidents, assignments, reroutes and flood', { skip }, async () => {
  const store = await loadPune();
  const a = runScenario(store), b = runScenario(store);
  assert.deepEqual(a.incidents, b.incidents);
  assert.deepEqual(a.log, b.log);
  assert.equal(a.flooded, b.flooded);
  assert.equal(a.level, 10, 'the flood rose to 10 m');
  assert.equal(a.incidents.length, 12, 'all 12 seeded calls arrived (none merged)');
  assert.ok(a.flooded > 50);
  assert.equal(a.def.closures.length, 1, 'scripted bridge closure resolved to roads');
  assert.ok(a.log.some(([kind, unit, atS, outcome]) => kind === 'reroute' && outcome === 'rerouted' && atS === 300),
    `the scripted bridge closure reroutes a unit at 300 s: ${JSON.stringify(a.log)}`);
  // calls on both banks, all near the river
  assert.deepEqual(new Set(a.def.calls.map((c) => c.bank)), new Set(['left', 'right']));
  const river = new FloodService({ store, elevation: json('elevation.json'), rivers: json('river.json').rivers }).riverPoints;
  for (const c of a.def.calls) {
    const d = Math.min(...river.map((p) => haversineM(p.lat, p.lng, c.lat, c.lng)));
    assert.ok(d >= 150 && d <= 1100, `call ${c.atS}s is ${Math.round(d)} m from the river`);
  }
});
