import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCityGraph } from '../data/cityData.js';
import { RequestStore, createRequest, assignRequest, completeRequest, requestStats } from '../services/requestService.js';
import { createSimulation, activateScenario, resetScenario } from '../services/scenarioService.js';

const good = { locationId: 'R2', disasterType: 'FIRE', severity: 'HIGH', peopleAffected: 4, waitingTimeScore: 2 };

test('createRequest: valid input gives unique sequential IDs, PENDING and no station', () => {
  const g = buildCityGraph(), s = new RequestStore();
  const a = createRequest(s, g, good), b = createRequest(s, g, good);
  assert.deepEqual([a.request.id, b.request.id], ['REQ-001', 'REQ-002']);
  assert.equal(a.request.status, 'PENDING');
  assert.equal(a.request.assignedStation, null);
});

test('createRequest rejects invalid input and stores nothing', () => {
  const g = buildCityGraph(), s = new RequestStore();
  const bad = [
    { ...good, locationId: 'NOPE' }, { ...good, severity: 'EXTREME' }, { ...good, disasterType: 'ALIEN' },
    { ...good, peopleAffected: 0 }, { ...good, peopleAffected: 2.5 }, { ...good, peopleAffected: NaN },
    { ...good, waitingTimeScore: -1 }, { ...good, waitingTimeScore: 'x' },
  ];
  bad.forEach((f) => { const r = createRequest(s, g, f); assert.equal(r.ok, false); assert.ok(r.error); });
  assert.equal(s.size, 0);
});

test('13. request lookup by ID returns the right record', () => {
  const g = buildCityGraph(), s = new RequestStore();
  createRequest(s, g, good);
  createRequest(s, g, { ...good, locationId: 'H1', severity: 'LOW' });
  assert.equal(s.get('REQ-002').locationId, 'H1');
  assert.equal(s.get('REQ-999'), undefined);
});

test('assign: recommended station is the cheapest reachable one; request becomes ASSIGNED', () => {
  const g = buildCityGraph(), s = new RequestStore();
  const { request } = createRequest(s, g, { ...good, locationId: 'S1' });
  const res = assignRequest(s, g, request.id);
  assert.ok(res.ok);
  assert.equal(request.status, 'ASSIGNED');
  assert.equal(request.assignedStation, res.stationId);
  assert.ok(res.route.reachable);
});

test('assign: explicit station is honoured; non-station and unknown request are rejected', () => {
  const g = buildCityGraph(), s = new RequestStore();
  const { request } = createRequest(s, g, good);
  assert.equal(assignRequest(s, g, request.id, 'H1').ok, false);
  assert.equal(assignRequest(s, g, 'nope').ok, false);
  assert.equal(request.status, 'PENDING');
  assert.equal(assignRequest(s, g, request.id, 'RS2').stationId, 'RS2');
});

test('assign: unreachable from every station -> not assigned, clear message', () => {
  const g = buildCityGraph(), s = new RequestStore();
  ['RD35', 'RD36'].forEach((id) => g.setRoadStatus(id, 'BLOCKED'));   // isolates R1
  const { request } = createRequest(s, g, { ...good, locationId: 'R1' });
  const res = assignRequest(s, g, request.id);
  assert.equal(res.ok, false);
  assert.match(res.error, /No route is currently available/);
  assert.equal(request.status, 'PENDING');
  assert.equal(request.assignedStation, null);
  assert.equal(assignRequest(s, g, request.id, 'RS1').ok, false);
});

test('one assignment per request; completed requests cannot be reassigned or completed again', () => {
  const g = buildCityGraph(), s = new RequestStore();
  const { request } = createRequest(s, g, good);
  assert.ok(assignRequest(s, g, request.id).ok);
  assert.equal(assignRequest(s, g, request.id).ok, false);
  assert.ok(completeRequest(s, request.id).ok);
  assert.equal(completeRequest(s, request.id).ok, false);
  assert.equal(assignRequest(s, g, request.id).ok, false);
  assert.equal(completeRequest(s, 'nope').ok, false);
});

test('stats: active, pending, assigned, completed and per-severity counts match the store', () => {
  const sim = createSimulation();
  activateScenario(sim, 'FLOOD');                          // 4 requests: 1 CRITICAL, 2 HIGH, 1 MEDIUM
  assignRequest(sim.requests, sim.graph, 'FLOOD-2');
  completeRequest(sim.requests, 'FLOOD-3');
  const st = requestStats(sim.requests);
  assert.deepEqual([st.total, st.pending, st.assigned, st.completed, st.active], [4, 2, 1, 1, 3]);
  assert.deepEqual(st.bySeverity, { LOW: 0, MEDIUM: 1, HIGH: 1, CRITICAL: 1 });   // completed one excluded
});

test('manual requests survive a scenario switch; reset clears everything and restarts numbering', () => {
  const sim = createSimulation();
  createRequest(sim.requests, sim.graph, good);
  activateScenario(sim, 'FLOOD');
  activateScenario(sim, 'FIRE');
  const ids = sim.requests.list().map((r) => r.id);
  assert.ok(ids.includes('REQ-001'));
  assert.ok(ids.includes('FIRE-1') && !ids.includes('FLOOD-1'));
  resetScenario(sim);
  assert.equal(sim.requests.size, 0);
  assert.equal(createRequest(sim.requests, sim.graph, good).request.id, 'REQ-001');
});

test('11. repeated activation never accumulates duplicate requests', () => {
  const sim = createSimulation();
  for (let i = 0; i < 3; i++) activateScenario(sim, 'FIRE');
  assert.equal(sim.requests.size, 3);
  assert.equal(new Set(sim.requests.list().map((r) => r.id)).size, 3);
});
