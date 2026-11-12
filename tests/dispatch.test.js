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
  // spread 400+ m apart, so SOS clustering keeps them as separate incidents
  for (let i = 0; i < trucks; i++) incs.push(svc.createIncident({ lat: KOTHRUD.lat + 0.004 * (i % 5), lng: KOTHRUD.lng + 0.004 * Math.floor(i / 5), type: 'fire', severity: 'LOW', people: 1 }));
  assert.equal(new Set(incs.map((i) => i.id)).size, trucks);
  const low = svc.createIncident({ ...DECCAN, type: 'fire', severity: 'LOW', people: 1 });
  const high = svc.createIncident({ lat: DECCAN.lat + 0.003, lng: DECCAN.lng, type: 'fire', severity: 'HIGH', people: 5 });  // ~330 m away: not merged
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

// ---------------- Phase 3 ----------------
const near = (p, metresNorth) => ({ lat: p.lat + metresNorth / 111195, lng: p.lng });

test('clustering in the service: calls 40 m apart merge (people summed, max severity); other type or >100 m do not', { skip }, async () => {
  const { svc } = await service();
  const a = svc.submitCall({ ...DECCAN, type: 'medical', severity: 'LOW', people: 2 });
  const b = svc.submitCall({ ...near(DECCAN, 40), type: 'medical', severity: 'HIGH', people: 3 });
  assert.equal(a.merged, null);
  assert.equal(b.incident.id, a.incident.id);
  assert.ok(b.merged.distanceM > 35 && b.merged.distanceM < 45);
  assert.equal(a.incident.people, 5);
  assert.equal(a.incident.severity, 'HIGH');
  assert.equal(a.incident.calls, 2);
  assert.equal(svc.submitCall({ ...near(DECCAN, 40), type: 'fire', severity: 'LOW', people: 1 }).merged, null);
  assert.equal(svc.submitCall({ ...near(DECCAN, 150), type: 'medical', severity: 'LOW', people: 1 }).merged, null);
  assert.equal(svc.incidents.size, 3);
});

test('clustering in the service: no merge more than 5 simulated minutes after the first call', { skip }, async () => {
  const { svc } = await service();
  const a = svc.submitCall({ ...DECCAN, type: 'flood', severity: 'LOW', people: 1 });
  svc.tick(301_000);
  const b = svc.submitCall({ ...DECCAN, type: 'flood', severity: 'LOW', people: 1 });
  assert.equal(b.merged, null);
  assert.notEqual(b.incident.id, a.incident.id);
});

test('burst: 8 incidents in one batch; greedy and Hungarian planned on the same incidents; optimal is better', { skip }, async () => {
  const { svc } = await service();
  const { created, merged, comparison: c } = svc.createBurst();
  assert.equal(created.length, 8);
  assert.equal(merged.length, 0);
  assert.equal(c.incidents, 8);
  assert.equal(c.greedy.assigned, 8);
  assert.equal(c.hungarian.assigned, 8);
  assert.ok(c.hungarian.totalS < c.greedy.totalS - 60, `hungarian ${c.hungarian.totalS} vs greedy ${c.greedy.totalS}`);
  // executed plan = Hungarian; each incident's ETA matches the recorded pair, and they sum to the total
  let sum = 0;
  for (const p of c.pairs) {
    const inc = svc.incidents.get(p.incidentId);
    assert.equal(inc.unitId, p.unitId);
    assert.ok(Math.abs(inc.etaS - inc.assignedS - p.etaS) < 0.1);
    assert.equal(svc.units.get(p.unitId).type, { medical: 'ambulance', fire: 'fire_truck', flood: 'rescue_boat' }[inc.type]);
    sum += p.etaS;
  }
  assert.ok(Math.abs(sum - c.hungarian.totalS) < 0.5);
  assert.equal(new Set(c.pairs.map((p) => p.unitId)).size, 8, 'no unit is used twice');
});

test('greedy mode executes the greedy plan of the same batch (identical comparison numbers)', { skip }, async () => {
  const a = await service();
  const hung = a.svc.createBurst().comparison;
  const b = await service();
  b.svc.setMode('greedy');
  const greedy = b.svc.createBurst().comparison;
  assert.deepEqual(greedy.greedy, hung.greedy);
  assert.deepEqual(greedy.hungarian, hung.hungarian);
  for (const p of greedy.pairs) assert.equal(p.unitId, p.greedyUnitId);
  assert.throws(() => b.svc.setMode('random'));
});

test('priority aging: the queue is re-scored as simulated time passes; an old LOW call overtakes a fresh MEDIUM one', { skip }, async () => {
  const { svc, log } = await service();
  for (const u of svc.units.values()) if (u.type === 'ambulance') u.status = 'ON_SCENE';   // no ambulance free
  const old = svc.createIncident({ ...KOTHRUD, type: 'medical', severity: 'LOW', people: 1 });
  assert.equal(svc.queue()[0].score, 5 + 2 + 0);
  log.length = 0;
  svc.tick(8 * 60_000);                                     // 8 simulated minutes
  assert.equal(svc.queue()[0].score, 5 + 2 + 8, 'waiting term grew with the sim clock');
  assert.ok(log.some((l) => l.event === 'queue:updated'), 're-prioritised queue was broadcast');
  const fresh = svc.createIncident({ ...DECCAN, type: 'medical', severity: 'MEDIUM', people: 1 });   // 10 + 2 + 0 = 12 < 15
  assert.deepEqual(svc.queue().map((q) => q.id), [old.id, fresh.id]);
  for (const u of svc.units.values()) if (u.type === 'ambulance') u.status = 'AVAILABLE';
});

test('two-leg routing preview: ambulance assignments name a hospital with free beds (major for life-threatening)', { skip }, async () => {
  const { svc } = await service();
  const inc = svc.createIncident({ ...KOTHRUD, type: 'medical', severity: 'HIGH', people: 1 });
  const h = svc.hospitals.get(inc.plannedHospitalId);
  assert.ok(h && h.bedsFree > 0 && h.major);
  assert.ok(inc.plannedHospitalLegS > 0);
  const fire = svc.createIncident({ ...DECCAN, type: 'fire', severity: 'HIGH', people: 1 });
  assert.equal(fire.plannedHospitalId, null);
});

test('invalid SOS input is rejected', { skip }, async () => {
  const { svc } = await service();
  assert.throws(() => svc.createIncident({ ...KOTHRUD, type: 'alien', severity: 'LOW', people: 1 }));
  assert.throws(() => svc.createIncident({ ...KOTHRUD, type: 'fire', severity: 'EXTREME', people: 1 }));
  assert.throws(() => svc.createIncident({ ...KOTHRUD, type: 'fire', severity: 'LOW', people: 0 }));
});
