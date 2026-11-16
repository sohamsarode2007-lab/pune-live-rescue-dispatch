// Regression tests for dispatch fixes: bed reservation/discharge, no abandoned patients,
// top-k reachability, and units that finish their road instead of teleporting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DispatchService } from '../server/services/dispatchService.js';
import { hasPuneData, loadPune } from './helpers.js';

const skip = !hasPuneData && 'Pune graph not generated';
const DECCAN = { lat: 18.5167, lng: 73.8414 };

async function service() {
  const store = await loadPune();
  store.resetRoads();
  const log = [];
  const svc = new DispatchService(store, { emit: (event, payload, rooms) => log.push({ event, payload, rooms }) });
  return { svc, log, store };
}
const runUntil = (svc, cond, maxSimS = 4 * 3600) => {
  const start = svc.now;
  while (!cond() && svc.now - start < maxSimS) svc.tick(10_000);
  return cond();
};

test('a bed is reserved when the ambulance leaves the scene, kept during the stay, then freed', { skip }, async () => {
  const { svc, log } = await service();
  const inc = svc.createIncident({ ...DECCAN, type: 'medical', severity: 'MEDIUM', people: 1 });
  const unit = svc.units.get(inc.unitId);
  assert.ok(runUntil(svc, () => unit.status === 'TO_HOSPITAL'));
  const h = svc.hospitals.get(unit.hospitalId);
  assert.equal(h.bedsFree, h.bedsCap - 1, 'reserved before arrival');
  assert.ok(log.some((l) => l.event === 'hospital:updated' && l.payload.id === h.id));
  assert.ok(runUntil(svc, () => inc.status === 'RESOLVED'));
  assert.equal(h.bedsFree, h.bedsCap - 1, 'still occupied right after arrival');
  assert.ok(runUntil(svc, () => h.bedsFree === h.bedsCap, 2 * 3600), 'discharged after the stay');
});

test('two ambulances cannot be promised the same last bed', { skip }, async () => {
  const { svc } = await service();
  const target = [...svc.hospitals.values()].find((h) => h.major);
  for (const h of svc.hospitals.values()) h.bedsFree = 0;
  target.bedsFree = 1;
  const a = svc.createIncident({ ...DECCAN, type: 'medical', severity: 'LOW', people: 1 });
  const b = svc.createIncident({ lat: 18.5175, lng: 73.8420, type: 'medical', severity: 'LOW', people: 1 });
  assert.notEqual(a.unitId, b.unitId);
  assert.ok(runUntil(svc, () => a.status === 'RESOLVED' && b.status === 'RESOLVED'));
  assert.equal([a, b].filter((i) => !i.surge).length, 1, 'exactly one patient gets the last bed, the other is a surge admission');
  assert.equal(target.bedsFree, 0, 'never negative');
});

test('a patient is never abandoned when every hospital is full: surge admission', { skip }, async () => {
  const { svc } = await service();
  for (const h of svc.hospitals.values()) h.bedsFree = 0;
  const inc = svc.createIncident({ ...DECCAN, type: 'medical', severity: 'MEDIUM', people: 1 });
  assert.ok(runUntil(svc, () => inc.status === 'RESOLVED'));
  assert.ok(inc.hospitalId, 'delivered to a hospital');
  assert.equal(inc.surge, true);
  assert.equal(svc.hospitals.get(inc.hospitalId).bedsFree, 0, 'no negative beds, no bed taken');
});

test('an unreachable top-priority incident does not starve a reachable one (top-k after reachability)', { skip }, async () => {
  const { svc, store } = await service();
  const [firstAmb, ...others] = [...svc.units.values()].filter((u) => u.type === 'ambulance');
  for (const u of others) u.status = 'ON_SCENE';                 // exactly one free ambulance
  const node = svc.graph.getLocation(firstAmb.homeNodeId);
  // pick a far junction and cut every road around it
  const far = [...svc.graph.locations.values()].find((l) => Math.abs(l.lat - node.lat) > 0.02);
  const around = [...svc.graph.adjacency.get(far.id).map((e) => e.roadId), ...svc.graph.inNeighbors(far.id).map((e) => e.roadId)];
  try {
    for (const id of around) store.setRoadStatus(id, 'BLOCKED');
    const stranded = svc.createIncident({ lat: far.lat, lng: far.lng, type: 'medical', severity: 'HIGH', people: 9 });
    assert.equal(stranded.status, 'PENDING');
    const ok = svc.createIncident({ lat: node.lat, lng: node.lng, type: 'medical', severity: 'LOW', people: 1 });
    assert.equal(ok.status, 'EN_ROUTE', 'the reachable incident gets the free unit');
    const before = svc.comparisons.length;
    svc.tick(40_000);                                            // retry timer fires with only the stranded one pending
    assert.equal(svc.comparisons.length, before, 'retries with nothing assignable add no comparison record');
    assert.ok(svc.comparisons.every((c) => c.pairs.length > 0));
    assert.ok(svc.comparisons[0].pairs.every((p) => 'hungarianUnitId' in p));
  } finally {
    store.resetRoads();
  }
});

test('when an incident becomes unreachable the unit finishes its road instead of teleporting', { skip }, async () => {
  const { svc, store } = await service();
  try {
    const inc = svc.createIncident({ lat: 18.5074, lng: 73.8077, type: 'medical', severity: 'LOW', people: 1 });
    const unit = svc.units.get(inc.unitId);
    svc.tick(10_000);
    const around = [...store.graph.adjacency.get(inc.nodeId).map((e) => e.roadId), ...store.graph.inNeighbors(inc.nodeId).map((e) => e.roadId)];
    for (const id of around) store.setRoadStatus(id, 'BLOCKED');
    const ev = svc.roadsBlocked(around);
    assert.equal(ev[0]?.outcome, 'incident-unreachable');
    assert.equal(unit.status, 'RETURNING', 'free to be re-assigned but still driving');
    assert.ok(unit.trip, 'a trip to the next junction exists');
    const stop = unit.trip.path.at(-1);
    assert.ok(runUntil(svc, () => unit.status === 'AVAILABLE', 3600));
    assert.equal(unit.nodeId, stop, 'waits at the junction it was driving to');
  } finally {
    store.resetRoads();
  }
});
