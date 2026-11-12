// Integration tests for the live dispatch simulation on the real Pune graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DispatchService, UNIT_FOR } from '../server/services/dispatchService.js';
import { astar } from '../shared/graph/astar.js';
import { hasPuneData, loadPune } from './helpers.js';

const skip = !hasPuneData && 'Pune graph not generated';
const KOTHRUD = { lat: 18.5074, lng: 73.8077 };
const DECCAN = { lat: 18.5167, lng: 73.8414 };

async function service() {
  const store = await loadPune();
  store.resetRoads();
  const log = [];
  const svc = new DispatchService(store, { emit: (event, payload, rooms) => log.push({ event, payload, rooms }) });
  return { svc, log, store };
}

function runUntil(svc, cond, maxSimS = 4 * 3600) {
  const start = svc.now;
  while (!cond() && svc.now - start < maxSimS) svc.tick(10_000);   // 10 s steps at 1x
  return cond();
}

test('SOS gets the capable unit with the lowest ETA (checked against A* from every candidate)', { skip }, async () => {
  const { svc } = await service();
  for (const type of ['medical', 'fire', 'flood']) {
    const inc = svc.createIncident({ ...KOTHRUD, type, severity: 'MEDIUM', people: 2 });
    assert.equal(inc.status, 'EN_ROUTE');
    const unit = svc.units.get(inc.unitId);
    assert.equal(unit.type, UNIT_FOR[type]);
    let best = Infinity;
    for (const u of svc.units.values()) {
      if (u.type !== UNIT_FOR[type] || (u.status !== 'AVAILABLE' && u.id !== unit.id)) continue;
      best = Math.min(best, astar(svc.graph, u.homeNodeId, inc.nodeId).totalCost);
    }
    assert.ok(Math.abs(inc.etaS - inc.assignedS - best) < 1e-6, `${type}: eta ${inc.etaS} vs best ${best}`);
  }
});

test('full lifecycle: EN_ROUTE -> ON_SCENE -> TO_HOSPITAL -> RETURNING -> AVAILABLE, bed taken', { skip }, async () => {
  const { svc, log } = await service();
  const inc = svc.createIncident({ ...DECCAN, type: 'medical', severity: 'MEDIUM', people: 1 });
  const unit = svc.units.get(inc.unitId);
  const statuses = [];
  const seen = () => { const s = unit.status; if (statuses.at(-1) !== s) statuses.push(s); };
  seen();
  assert.ok(runUntil(svc, () => { seen(); return inc.status === 'RESOLVED' && unit.status === 'AVAILABLE'; }));
  assert.deepEqual(statuses, ['EN_ROUTE', 'ON_SCENE', 'TO_HOSPITAL', 'RETURNING', 'AVAILABLE']);
  assert.equal(unit.nodeId, unit.homeNodeId);
  assert.ok(inc.responseS > 0 && Math.abs(inc.arrivedS - inc.etaS) < 1e-6, 'arrives exactly at the promised ETA');
  const h = svc.hospitals.get(inc.hospitalId);
  const original = svc.store.facilities.find((f) => f.id === h.id).bedsFree;
  assert.equal(h.bedsFree, original - 1);
  assert.ok(log.some((l) => l.event === 'unit:position' && l.rooms.includes(`inc:${inc.id}`)));
});

test('life-threatening medical incidents go to a major hospital', { skip }, async () => {
  const { svc } = await service();
  const inc = svc.createIncident({ ...KOTHRUD, type: 'medical', severity: 'HIGH', people: 1 });
  assert.ok(runUntil(svc, () => inc.hospitalId !== null));
  assert.equal(svc.hospitals.get(inc.hospitalId).major, true);
});

test('when every capable unit is busy, incidents wait in priority order and are served later', { skip }, async () => {
  const { svc } = await service();
  const trucks = [...svc.units.values()].filter((u) => u.type === 'fire_truck').length;
  const incs = [];
  for (let i = 0; i < trucks; i++) incs.push(svc.createIncident({ ...KOTHRUD, type: 'fire', severity: 'LOW', people: 1 }));
  const low = svc.createIncident({ ...DECCAN, type: 'fire', severity: 'LOW', people: 1 });
  const high = svc.createIncident({ ...DECCAN, type: 'fire', severity: 'HIGH', people: 5 });
  assert.equal(low.status, 'PENDING');
  assert.equal(high.status, 'PENDING');
  assert.deepEqual(svc.queue().map((q) => q.id), [high.id, low.id]);     // higher priority first
  assert.ok(runUntil(svc, () => low.status === 'RESOLVED' && high.status === 'RESOLVED'));
  // the first freed truck takes the higher-priority incident (both may be served at the same instant)
  assert.ok(high.assignedS <= low.assignedS, `high assigned at ${high.assignedS}, low at ${low.assignedS}`);
  const freedAt = Math.min(...incs.map((i) => i.resolvedS));
  assert.ok(high.assignedS >= freedAt - 1e-6, 'waiting incidents are served only once a truck frees up');
});

test('a returning unit can be re-assigned mid-trip; its old arrival event is ignored', { skip }, async () => {
  const { svc } = await service();
  const first = svc.createIncident({ ...KOTHRUD, type: 'flood', severity: 'LOW', people: 1 });
  const boat = svc.units.get(first.unitId);
  assert.ok(runUntil(svc, () => boat.status === 'RETURNING'));
  svc.tick(5_000);
  const others = [...svc.units.values()].filter((u) => u.type === 'rescue_boat' && u.id !== boat.id);
  others.forEach((u) => { u.status = 'ON_SCENE'; });                     // make every other boat busy
  const second = svc.createIncident({ lat: 18.52, lng: 73.83, type: 'flood', severity: 'MEDIUM', people: 3 });
  assert.equal(second.unitId, boat.id);
  assert.equal(boat.status, 'EN_ROUTE');
  assert.ok(runUntil(svc, () => second.status === 'RESOLVED'));
  others.forEach((u) => { u.status = 'AVAILABLE'; });
});

test('invalid SOS input is rejected', { skip }, async () => {
  const { svc } = await service();
  assert.throws(() => svc.createIncident({ ...KOTHRUD, type: 'alien', severity: 'LOW', people: 1 }));
  assert.throws(() => svc.createIncident({ ...KOTHRUD, type: 'fire', severity: 'EXTREME', people: 1 }));
  assert.throws(() => svc.createIncident({ ...KOTHRUD, type: 'fire', severity: 'LOW', people: 0 }));
});
