// Live dispatch simulation (Phases 2-3).
//
// 1. SOS clustering: a call within 100 m and 5 min of an open incident of the same type is merged into it
//    (geohash cell + 8 neighbours, then haversine). People are summed, the highest severity is kept.
// 2. Priority with aging: pending incidents are ordered by the EmergencyPriorityQueue; the waiting term
//    grows with the simulated clock, so the queue is rebuilt (re-prioritised) on every tick.
// 3. Assignment in batches: whenever there is something to dispatch (new SOS, burst, a unit frees up),
//    pending incidents are matched to free units. Each batch computes BOTH plans on the same snapshot:
//      greedy    = incidents in priority order, each takes its nearest free capable unit (Phase 2 rule)
//      hungarian = optimal assignment minimising total ETA (O(n^3))
//    ETAs come from one reverse Dijkstra per incident; impossible pairs (wrong unit type, unreachable)
//    cost Infinity. If units are short, priority decides WHO is served (top-k per unit type, the same set
//    for both plans); the plan only decides WHICH unit serves whom. Both totals are recorded for the
//    greedy-vs-optimal panel; the dispatcher's mode decides which plan is executed.
// 4. Two-leg routing: unit -> incident -> best hospital (min ETA with free beds; major hospitals for
//    life-threatening cases). Previewed at assignment, chosen for real when the scene is cleared.
//
// Unit lifecycle: AVAILABLE -> EN_ROUTE -> ON_SCENE -> (ambulance: TO_HOSPITAL ->) RETURNING -> AVAILABLE
// Timed transitions are events in an EventQueue (min-heap by simulated time); the SimClock advances
// simulated time and positions are interpolated along each unit's trip.
import { dijkstraAll, buildRoute, buildRouteToTarget } from '../../shared/graph/dijkstra.js';
import { EmergencyPriorityQueue, priorityScore } from '../../shared/dispatch/EmergencyPriorityQueue.js';
import { SEVERITY } from '../../shared/dispatch/requestConstants.js';
import { hungarian, greedyAssignment } from '../../shared/dispatch/hungarian.js';
import { SosClusterer } from '../../shared/dispatch/sosClusterer.js';
import { EventQueue } from '../../shared/sim/EventQueue.js';
import { SimClock } from '../../shared/sim/simClock.js';
import { buildTrip, positionAt, partialToNextJunction, remainingPoints } from '../../shared/sim/trip.js';
import { burstPattern, BURST_SEED } from './burst.js';

export const INCIDENT_TYPES = Object.freeze(['medical', 'fire', 'flood']);
export const SOS_SEVERITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
export const UNIT_FOR = Object.freeze({ medical: 'ambulance', fire: 'fire_truck', flood: 'rescue_boat' });
export const DISPATCH_MODES = Object.freeze(['hungarian', 'greedy']);
// Simulated time spent at the scene (seconds). Demo values, not operational data.
export const SCENE_TIME_S = Object.freeze({ medical: 240, fire: 600, flood: 480 });
export const MAX_PEOPLE = 200;
export const UNIT_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE', EN_ROUTE: 'EN_ROUTE', ON_SCENE: 'ON_SCENE', TO_HOSPITAL: 'TO_HOSPITAL', RETURNING: 'RETURNING',
});
export const INCIDENT_STATUS = Object.freeze({
  PENDING: 'PENDING', EN_ROUTE: 'EN_ROUTE', ON_SCENE: 'ON_SCENE', TRANSPORTING: 'TRANSPORTING', RESOLVED: 'RESOLVED',
});
const MOVING = new Set([UNIT_STATUS.EN_ROUTE, UNIT_STATUS.TO_HOSPITAL, UNIT_STATUS.RETURNING]);
const FREE = new Set([UNIT_STATUS.AVAILABLE, UNIT_STATUS.RETURNING]);
const RETRY_PENDING_S = 30;     // re-try pending incidents this often (roads may have reopened)

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const byId = (a, b) => a.localeCompare(b, 'en', { numeric: true });

export class DispatchService {
  // store: GraphStore. emit(event, payload, rooms[]) is called for every broadcast.
  constructor(store, { emit = () => {}, speed = 1, mode = 'hungarian' } = {}) {
    this.store = store;
    this.graph = store.graph;
    this.emit = emit;
    this.clock = new SimClock({ speed });
    this.mode = mode;
    this.reset();
  }

  reset() {
    this.clock.reset(0);
    this.events = new EventQueue();
    this.incidents = new Map();
    this.incidentSeq = 0;
    this.clusterer = new SosClusterer();
    this.hospitals = new Map(this.store.facilities.filter((f) => f.kind === 'hospital').map((h) => [h.id, { ...h }]));
    this.units = new Map(this.store.units.map((u) => {
      const home = this.graph.getLocation(u.homeNodeId);
      return [u.id, {
        ...u, status: UNIT_STATUS.AVAILABLE, nodeId: u.homeNodeId, lat: home.lat, lng: home.lng,
        trip: null, tripSeq: 0, incidentId: null, hospitalId: null, phaseEndS: null,
      }];
    }));
    this.roadReports = [];
    this.comparisons = [];
    this.batchSeq = 0;
    this.lastQueueKey = '';
    this.nextRetryS = RETRY_PENDING_S;
    this.burstCount = 0;
  }

  get now() { return this.clock.nowS; }

  setMode(mode) {
    if (!DISPATCH_MODES.includes(mode)) throw new Error('Unknown dispatch mode');
    this.mode = mode;
  }

  // ---------- incidents ----------
  #validate({ type, severity, people }) {
    if (!INCIDENT_TYPES.includes(type)) throw new Error('Unknown incident type');
    if (!SOS_SEVERITIES.includes(severity)) throw new Error('Unknown severity');
    if (!Number.isInteger(people) || people < 1 || people > 50) throw new Error('People must be 1-50');
  }

  // Returns the incident the call belongs to (new, or an existing one it was merged into).
  createIncident(call, options) { return this.submitCall(call, options).incident; }

  // Returns { incident, merged } where merged = { distanceM, checked } if the call joined an open incident.
  submitCall(call, { dispatch = true } = {}) {
    this.#validate(call);
    const { lat, lng, type, severity, people, accuracyM = null, source = 'phone', clientId = null } = call;
    const match = this.clusterer.findMatch({ lat, lng, type }, this.now);
    if (match) {
      const inc = this.incidents.get(match.id);
      inc.calls++;
      inc.people = Math.min(MAX_PEOPLE, inc.people + people);
      if (SEVERITY[severity] > SEVERITY[inc.severity]) inc.severity = severity;
      inc.lastCallS = this.now;
      this.#incidentChanged(inc);
      if (inc.status === INCIDENT_STATUS.PENDING) this.#queueChanged(true);
      return { incident: inc, merged: { distanceM: round1(match.distanceM), checked: match.checked } };
    }
    const snap = this.store.nearest(lat, lng);
    const id = `INC-${String(++this.incidentSeq).padStart(3, '0')}`;
    const inc = {
      id, type, severity, people, lat, lng, accuracyM, source, clientId, calls: 1,
      nodeId: snap.nodeId, snapDistanceM: snap.distanceM,
      status: INCIDENT_STATUS.PENDING, unitId: null, hospitalId: null,
      plannedHospitalId: null, plannedHospitalLegS: null,
      createdS: this.now, lastCallS: this.now, assignedS: null, arrivedS: null, resolvedS: null, etaS: null, responseS: null,
      batchId: null,
    };
    this.incidents.set(id, inc);
    inc.geohash = this.clusterer.add(inc);
    this.#incidentChanged(inc);
    if (dispatch) this.dispatchBatch('sos');
    return { incident: inc, merged: null };
  }

  // 8 simultaneous incidents in a fixed seeded pattern, dispatched as ONE batch so greedy and Hungarian
  // can be compared on exactly the same incidents.
  createBurst(seed = BURST_SEED) {
    this.burstCount++;
    const calls = burstPattern(seed, this.store.meta.bbox);
    const created = [], merged = [];
    for (const c of calls) {
      const { incident, merged: m } = this.submitCall({ ...c, source: 'burst' }, { dispatch: false });
      (m ? merged : created).push(incident.id);
    }
    const comparison = this.dispatchBatch('burst');
    return { created, merged, comparison };
  }

  // Pending incidents in service order. Aging: the waiting term = whole simulated minutes waited
  // (capped at 10 by the priority formula), so scores rise as the sim clock runs.
  queue() {
    const q = new EmergencyPriorityQueue();
    for (const inc of this.incidents.values()) {
      if (inc.status !== INCIDENT_STATUS.PENDING) continue;
      q.insert({
        id: inc.id, severity: inc.severity, peopleAffected: inc.people,
        waitingTimeScore: Math.floor((this.now - inc.createdS) / 60),
      });
    }
    return q.toSortedArray().map((r, i) => ({ id: r.id, position: i + 1, score: priorityScore(r), waitedMin: r.waitingTimeScore }));
  }

  // ---------- assignment ----------
  // Where each free unit would start from: its junction (AVAILABLE) or, for a RETURNING unit, the next
  // junction on its way home plus the time to reach it.
  #unitOrigins() {
    const out = [];
    for (const u of this.units.values()) {
      if (!FREE.has(u.status)) continue;
      if (u.status === UNIT_STATUS.AVAILABLE) out.push({ unit: u, originNode: u.nodeId, delayS: 0, prefix: null });
      else {
        const part = partialToNextJunction(u.trip, this.now);
        out.push({ unit: u, originNode: part.junction.nodeId, delayS: Math.max(0, part.junction.time - this.now), prefix: part.prefix });
      }
    }
    return out.sort((a, b) => byId(a.unit.id, b.unit.id));
  }

  // Builds the ETA matrix for the batch and both plans. Pure planning: nothing is changed.
  plan() {
    const queue = this.queue();
    if (queue.length === 0) return null;
    const origins = this.#unitOrigins();
    const freeByType = {};
    origins.forEach((o) => { freeByType[o.unit.type] = (freeByType[o.unit.type] ?? 0) + 1; });
    // Who is served: per unit type, the top-k pending incidents by priority (k = free units of that type).
    const takenByType = {};
    const rows = [];
    for (const q of queue) {
      const inc = this.incidents.get(q.id);
      const t = UNIT_FOR[inc.type];
      if ((takenByType[t] ?? 0) < (freeByType[t] ?? 0)) { takenByType[t] = (takenByType[t] ?? 0) + 1; rows.push(inc); }
    }
    if (rows.length === 0) return null;
    const cols = origins.filter((o) => rows.some((inc) => UNIT_FOR[inc.type] === o.unit.type));
    const revs = rows.map((inc) => dijkstraAll(this.graph, inc.nodeId, { reverse: true }));
    const cost = rows.map((inc, i) => cols.map((o) => {
      if (UNIT_FOR[inc.type] !== o.unit.type || !revs[i].dist.has(o.originNode)) return Infinity;
      return o.delayS + revs[i].dist.get(o.originNode);
    }));
    const greedy = greedyAssignment(cost, rows.map((_, i) => i));   // rows are already in priority order
    const optimal = hungarian(cost);
    return { rows, cols, revs, cost, greedy, optimal };
  }

  // Plans and executes one batch. Returns the comparison record (or null if nothing could be planned).
  dispatchBatch(trigger = 'sos') {
    const p = this.plan();
    if (!p) return null;
    const chosen = this.mode === 'greedy' ? p.greedy : p.optimal;
    const record = {
      id: ++this.batchSeq, atS: round1(this.now), trigger, mode: this.mode, incidents: p.rows.length, units: p.cols.length,
      greedy: { assigned: p.greedy.assigned, totalS: round1(p.greedy.totalCost) },
      hungarian: { assigned: p.optimal.assigned, totalS: round1(p.optimal.totalCost) },
      pairs: [],
    };
    chosen.assignment.forEach((j, i) => {
      if (j < 0) return;
      const inc = p.rows[i], o = p.cols[j];
      const g = p.greedy.assignment[i];
      record.pairs.push({ incidentId: inc.id, unitId: o.unit.id, etaS: round1(p.cost[i][j]), greedyUnitId: g >= 0 ? p.cols[g].unit.id : null, greedyEtaS: g >= 0 ? round1(p.cost[i][g]) : null });
      inc.batchId = record.id;
      this.#assignWith(inc, o, p.revs[i].prev);
    });
    if (record.incidents > 0) {
      this.comparisons.push(record);
      if (this.comparisons.length > 200) this.comparisons.shift();
      this.emit('comparison:updated', { latest: record, totals: this.comparisonTotals() }, ['dispatch']);
    }
    this.#queueChanged(true);
    return record;
  }

  // Sums over every batch: the same incidents, planned both ways.
  comparisonTotals() {
    const t = { batches: 0, multiBatches: 0, greedyS: 0, hungarianS: 0, greedyAssigned: 0, hungarianAssigned: 0 };
    for (const c of this.comparisons) {
      t.batches++;
      if (c.incidents > 1) t.multiBatches++;
      t.greedyS += c.greedy.totalS; t.hungarianS += c.hungarian.totalS;
      t.greedyAssigned += c.greedy.assigned; t.hungarianAssigned += c.hungarian.assigned;
    }
    t.greedyS = round1(t.greedyS); t.hungarianS = round1(t.hungarianS);
    return t;
  }

  #assignWith(inc, origin, revPrev) {
    const { unit, originNode, prefix } = origin;
    const route = buildRouteToTarget(this.graph, originNode, inc.nodeId, revPrev);
    unit.incidentId = inc.id;          // set first, so the unit broadcast also reaches the incident's room
    unit.hospitalId = null;
    this.#startTrip(unit, route, prefix, UNIT_STATUS.EN_ROUTE, { type: 'ARRIVE_SCENE', incidentId: inc.id });
    Object.assign(inc, { status: INCIDENT_STATUS.EN_ROUTE, unitId: unit.id, assignedS: this.now, etaS: unit.trip.endS });
    if (unit.type === 'ambulance') {   // two-leg preview: which hospital the patient would go to now
      const h = this.#chooseHospital(inc);
      inc.plannedHospitalId = h?.hospital.id ?? null;
      inc.plannedHospitalLegS = h ? round1(h.route.totalCost) : null;
    }
    this.#incidentChanged(inc);
  }

  // Best hospital from the scene: lowest cost among hospitals with free beds. For a HIGH
  // (life-threatening) incident, major hospitals are preferred while one is reachable.
  #chooseHospital(inc) {
    const { dist, prev } = dijkstraAll(this.graph, inc.nodeId);
    const withBeds = [...this.hospitals.values()].filter((h) => h.bedsFree > 0 && dist.has(h.nodeId));
    const pool = inc.severity === 'HIGH' && withBeds.some((h) => h.major) ? withBeds.filter((h) => h.major) : withBeds;
    pool.sort((a, b) => dist.get(a.nodeId) - dist.get(b.nodeId) || byId(a.id, b.id));
    const h = pool[0];
    return h ? { hospital: h, route: buildRoute(this.graph, inc.nodeId, h.nodeId, prev) } : null;
  }

  #routeHome(unit) {
    const { prev, dist } = dijkstraAll(this.graph, unit.nodeId, { target: unit.homeNodeId });
    if (!dist.has(unit.homeNodeId)) return null;
    return buildRoute(this.graph, unit.nodeId, unit.homeNodeId, prev);
  }

  #startTrip(unit, route, prefix, status, event) {
    unit.trip = buildTrip(this.graph, route, this.now, prefix);
    unit.status = status;
    unit.tripSeq++;
    unit.phaseEndS = unit.trip.endS;
    this.events.push(unit.trip.endS, { ...event, unitId: unit.id, tripSeq: unit.tripSeq });
    this.#unitChanged(unit);
  }

  #goHome(unit) {
    const route = this.#routeHome(unit);
    unit.incidentId = null;
    if (!route || route.roadIds.length === 0) { this.#becomeAvailable(unit); return; }
    this.#startTrip(unit, route, null, UNIT_STATUS.RETURNING, { type: 'ARRIVE_HOME' });
    this.dispatchBatch('unit-free');     // a returning unit can be re-assigned straight away
  }

  #becomeAvailable(unit) {
    Object.assign(unit, { status: UNIT_STATUS.AVAILABLE, trip: null, incidentId: null, hospitalId: null, phaseEndS: null });
    this.#unitChanged(unit);
    this.dispatchBatch('unit-free');
  }

  #resolve(inc) {
    Object.assign(inc, { status: INCIDENT_STATUS.RESOLVED, resolvedS: this.now });
    this.clusterer.remove(inc.id);
    this.#incidentChanged(inc);
  }

  // ---------- simulation ----------
  #handle(ev) {
    const unit = this.units.get(ev.unitId);
    if (!unit || (ev.tripSeq !== undefined && ev.tripSeq !== unit.tripSeq)) return;   // stale (unit re-assigned)
    const endNode = unit.trip?.path.at(-1);
    if (endNode) {
      const loc = this.graph.getLocation(endNode);
      Object.assign(unit, { nodeId: endNode, lat: loc.lat, lng: loc.lng });
    }
    const inc = unit.incidentId ? this.incidents.get(unit.incidentId) : null;
    switch (ev.type) {
      case 'ARRIVE_SCENE': {
        Object.assign(unit, { status: UNIT_STATUS.ON_SCENE, trip: null, phaseEndS: ev.time + SCENE_TIME_S[inc.type] });
        Object.assign(inc, { status: INCIDENT_STATUS.ON_SCENE, arrivedS: ev.time, responseS: ev.time - inc.createdS });
        this.events.push(unit.phaseEndS, { type: 'SCENE_DONE', unitId: unit.id, tripSeq: unit.tripSeq });
        this.#unitChanged(unit); this.#incidentChanged(inc);
        break;
      }
      case 'SCENE_DONE': {
        const choice = unit.type === 'ambulance' ? this.#chooseHospital(inc) : null;
        if (choice && choice.route.roadIds.length > 0) {
          unit.hospitalId = choice.hospital.id;
          Object.assign(inc, { status: INCIDENT_STATUS.TRANSPORTING, hospitalId: choice.hospital.id });
          this.#incidentChanged(inc);
          this.#startTrip(unit, choice.route, null, UNIT_STATUS.TO_HOSPITAL, { type: 'ARRIVE_HOSPITAL' });
        } else {
          if (choice) { choice.hospital.bedsFree--; inc.hospitalId = choice.hospital.id; }
          this.#resolve(inc);
          this.#goHome(unit);
        }
        break;
      }
      case 'ARRIVE_HOSPITAL': {
        const h = this.hospitals.get(unit.hospitalId);
        if (h) { h.bedsFree = Math.max(0, h.bedsFree - 1); this.emit('hospital:updated', { id: h.id, bedsFree: h.bedsFree }, ['dispatch']); }
        this.#resolve(inc);
        this.#goHome(unit);
        break;
      }
      case 'ARRIVE_HOME':
        this.#becomeAvailable(unit);
        break;
      default:
    }
  }

  // Advance simulated time by realMs, process due events in time order, re-prioritise the queue,
  // broadcast positions.
  tick(realMs) {
    const target = this.clock.nowS + (realMs / 1000) * this.clock.speed;
    while (!this.events.isEmpty() && this.events.peek().time <= target) {
      const ev = this.events.pop();
      this.clock.nowS = Math.max(this.clock.nowS, ev.time);   // handle each event at its own time
      this.#handle(ev);
    }
    this.clock.nowS = target;
    if (this.now >= this.nextRetryS) {                        // e.g. a road reopened: try pending again
      this.nextRetryS = this.now + RETRY_PENDING_S;
      if (this.queue().length) this.dispatchBatch('retry');
    }
    this.#queueChanged(false);                                // aging: re-prioritise, broadcast if changed
    const moving = [];
    for (const u of this.units.values()) {
      if (!MOVING.has(u.status) || !u.trip) continue;
      const p = positionAt(u.trip, this.now);
      u.lat = p.lat; u.lng = p.lng;
      moving.push({ id: u.id, lat: round6(u.lat), lng: round6(u.lng), status: u.status, incidentId: u.incidentId, remainingS: round1(Math.max(0, u.trip.endS - this.now)) });
    }
    this.emit('unit:position', { simTimeS: round1(this.now), speed: this.clock.speed, units: moving }, ['dispatch']);
    for (const m of moving) if (m.incidentId) this.emit('unit:position', { simTimeS: round1(this.now), speed: this.clock.speed, units: [m] }, [`inc:${m.incidentId}`]);
    return moving.length;
  }

  setSpeed(speed) { this.clock.setSpeed(speed); }

  // Crowd road reports are stored now; Phase 5 turns 3 reports from different clients into a closure.
  reportRoad({ lat, lng, clientId }) {
    const snap = this.store.nearest(lat, lng);
    const report = { lat, lng, clientId, nodeId: snap.nodeId, atS: this.now };
    this.roadReports.push(report);
    return report;
  }

  // ---------- views ----------
  unitView(u) {
    return {
      id: u.id, type: u.type, stationId: u.stationId, status: u.status, lat: round6(u.lat), lng: round6(u.lng),
      incidentId: u.incidentId, hospitalId: u.hospitalId, phaseEndS: round1(u.phaseEndS),
      route: u.trip ? remainingPoints(u.trip, this.now) : null,
    };
  }

  incidentView(inc, queue = null) {
    const { clientId, ...rest } = inc;
    const q = inc.status === INCIDENT_STATUS.PENDING ? (queue ?? this.queue()).find((x) => x.id === inc.id) ?? null : null;
    return { ...rest, queue: q };
  }

  snapshot() {
    const queue = this.queue();
    return {
      simTimeS: round1(this.now), speed: this.clock.speed, mode: this.mode,
      units: [...this.units.values()].map((u) => this.unitView(u)),
      incidents: [...this.incidents.values()].map((i) => this.incidentView(i, queue)),
      queue,
      hospitals: [...this.hospitals.values()].map((h) => ({ id: h.id, bedsFree: h.bedsFree })),
      comparisons: this.comparisons.slice(-20),
      comparisonTotals: this.comparisonTotals(),
    };
  }

  #unitChanged(u) {
    const rooms = ['dispatch'];
    if (u.incidentId) rooms.push(`inc:${u.incidentId}`);
    this.emit('unit:updated', this.unitView(u), rooms);
  }

  #incidentChanged(inc) { this.emit('incident:updated', this.incidentView(inc), ['dispatch', `inc:${inc.id}`]); }

  // Broadcasts the queue (and each waiting phone's position) when it changed, or always if forced.
  #queueChanged(force) {
    const queue = this.queue();
    const key = queue.map((q) => `${q.id}:${q.score}`).join('|');
    if (!force && key === this.lastQueueKey) return;
    this.lastQueueKey = key;
    this.emit('queue:updated', queue, ['dispatch']);
    for (const q of queue) this.emit('incident:updated', this.incidentView(this.incidents.get(q.id), queue), [`inc:${q.id}`]);
  }
}
