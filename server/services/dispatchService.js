// Live dispatch simulation (Phase 2).
//
// Incidents arrive from SOS phones (or the dispatcher's test button). Each is snapped to the nearest
// junction (k-d tree) and given the closest AVAILABLE or RETURNING unit of the right type:
//   medical -> ambulance, fire -> fire truck, flood -> rescue boat (boats travel by road on a trailer).
// "Closest" = lowest ETA from ONE reverse Dijkstra run rooted at the incident, which gives every
// junction's cost TO the incident at once. If no suitable unit is free, the incident waits in the
// EmergencyPriorityQueue and is served as soon as a unit frees up (Phase 3 replaces this greedy rule
// with clustering, aging and the Hungarian algorithm).
//
// Unit lifecycle: AVAILABLE -> EN_ROUTE -> ON_SCENE -> (ambulance: TO_HOSPITAL ->) RETURNING -> AVAILABLE
// Timed transitions are events in an EventQueue (min-heap by simulated time); the SimClock advances
// simulated time and positions are interpolated along each unit's trip.
import { dijkstraAll, buildRoute, buildRouteToTarget } from '../../shared/graph/dijkstra.js';
import { EmergencyPriorityQueue, priorityScore } from '../../shared/dispatch/EmergencyPriorityQueue.js';
import { EventQueue } from '../../shared/sim/EventQueue.js';
import { SimClock } from '../../shared/sim/simClock.js';
import { buildTrip, positionAt, partialToNextJunction, remainingPoints } from '../../shared/sim/trip.js';

export const INCIDENT_TYPES = Object.freeze(['medical', 'fire', 'flood']);
export const SOS_SEVERITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
export const UNIT_FOR = Object.freeze({ medical: 'ambulance', fire: 'fire_truck', flood: 'rescue_boat' });
// Simulated time spent at the scene (seconds). Demo values, not operational data.
export const SCENE_TIME_S = Object.freeze({ medical: 240, fire: 600, flood: 480 });
export const UNIT_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE', EN_ROUTE: 'EN_ROUTE', ON_SCENE: 'ON_SCENE', TO_HOSPITAL: 'TO_HOSPITAL', RETURNING: 'RETURNING',
});
export const INCIDENT_STATUS = Object.freeze({
  PENDING: 'PENDING', EN_ROUTE: 'EN_ROUTE', ON_SCENE: 'ON_SCENE', TRANSPORTING: 'TRANSPORTING', RESOLVED: 'RESOLVED',
});
const MOVING = new Set([UNIT_STATUS.EN_ROUTE, UNIT_STATUS.TO_HOSPITAL, UNIT_STATUS.RETURNING]);

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

export class DispatchService {
  // store: GraphStore. emit(event, payload, rooms[]) is called for every broadcast.
  constructor(store, { emit = () => {}, speed = 1 } = {}) {
    this.store = store;
    this.graph = store.graph;
    this.emit = emit;
    this.clock = new SimClock({ speed });
    this.reset();
  }

  reset() {
    this.clock.reset(0);
    this.events = new EventQueue();
    this.incidents = new Map();
    this.incidentSeq = 0;
    this.hospitals = new Map(this.store.facilities.filter((f) => f.kind === 'hospital').map((h) => [h.id, { ...h }]));
    this.units = new Map(this.store.units.map((u) => {
      const home = this.graph.getLocation(u.homeNodeId);
      return [u.id, {
        ...u, status: UNIT_STATUS.AVAILABLE, nodeId: u.homeNodeId, lat: home.lat, lng: home.lng,
        trip: null, tripSeq: 0, incidentId: null, hospitalId: null, phaseEndS: null,
      }];
    }));
    this.roadReports = [];
  }

  get now() { return this.clock.nowS; }

  // ---------- incidents ----------
  createIncident({ lat, lng, type, severity, people, accuracyM = null, source = 'phone', clientId = null }) {
    if (!INCIDENT_TYPES.includes(type)) throw new Error('Unknown incident type');
    if (!SOS_SEVERITIES.includes(severity)) throw new Error('Unknown severity');
    if (!Number.isInteger(people) || people < 1 || people > 50) throw new Error('People must be 1-50');
    const snap = this.store.nearest(lat, lng);
    const id = `INC-${String(++this.incidentSeq).padStart(3, '0')}`;
    const inc = {
      id, type, severity, people, lat, lng, accuracyM, source, clientId,
      nodeId: snap.nodeId, snapDistanceM: snap.distanceM,
      status: INCIDENT_STATUS.PENDING, unitId: null, hospitalId: null,
      createdS: this.now, assignedS: null, arrivedS: null, resolvedS: null, etaS: null, responseS: null,
    };
    this.incidents.set(id, inc);
    this.#assign(inc);
    if (inc.status === INCIDENT_STATUS.PENDING) this.#incidentChanged(inc);
    this.#queueChanged();
    return inc;
  }

  // Pending incidents in service order (EmergencyPriorityQueue; waiting time in simulated minutes).
  queue() {
    const q = new EmergencyPriorityQueue();
    for (const inc of this.incidents.values()) {
      if (inc.status !== INCIDENT_STATUS.PENDING) continue;
      q.insert({
        id: inc.id, severity: inc.severity, peopleAffected: inc.people,
        waitingTimeScore: Math.floor((this.now - inc.createdS) / 60),
      });
    }
    return q.toSortedArray().map((r, i) => ({ id: r.id, position: i + 1, score: priorityScore(r) }));
  }

  // ---------- assignment ----------
  // Cost to the incident from every junction (one reverse Dijkstra), then the best capable unit.
  #candidates(inc) {
    const rev = dijkstraAll(this.graph, inc.nodeId, { reverse: true });
    const wanted = UNIT_FOR[inc.type];
    const out = [];
    for (const u of this.units.values()) {
      if (u.type !== wanted) continue;
      let originNode, delayS = 0, prefix = null;
      if (u.status === UNIT_STATUS.AVAILABLE) originNode = u.nodeId;
      else if (u.status === UNIT_STATUS.RETURNING) {
        const part = partialToNextJunction(u.trip, this.now);   // finish the current road first
        originNode = part.junction.nodeId;
        delayS = Math.max(0, part.junction.time - this.now);
        prefix = part.prefix;
      } else continue;
      if (!rev.dist.has(originNode)) continue;                  // cannot reach the incident
      out.push({ unit: u, originNode, prefix, etaS: delayS + rev.dist.get(originNode) });
    }
    out.sort((a, b) => a.etaS - b.etaS || a.unit.id.localeCompare(b.unit.id, 'en', { numeric: true }));
    return { best: out[0] ?? null, rev };
  }

  #assign(inc) {
    const { best, rev } = this.#candidates(inc);
    if (!best) return false;
    const { unit, originNode, prefix } = best;
    const route = buildRouteToTarget(this.graph, originNode, inc.nodeId, rev.prev);
    unit.incidentId = inc.id;          // set first, so the unit broadcast also reaches the incident's room
    unit.hospitalId = null;
    this.#startTrip(unit, route, prefix, UNIT_STATUS.EN_ROUTE, { type: 'ARRIVE_SCENE', incidentId: inc.id });
    Object.assign(inc, { status: INCIDENT_STATUS.EN_ROUTE, unitId: unit.id, assignedS: this.now, etaS: unit.trip.endS });
    this.#incidentChanged(inc);
    return true;
  }

  // Serve waiting incidents in priority order with whatever units are free now.
  #dispatchPending() {
    let changed = false;
    for (const { id } of this.queue()) {
      const inc = this.incidents.get(id);
      if (this.#assign(inc)) changed = true;
    }
    if (changed) this.#queueChanged();
  }

  // Best hospital from the scene: lowest cost among hospitals with free beds. For a HIGH
  // (life-threatening) incident, major hospitals are preferred if one is reachable.
  #chooseHospital(inc) {
    const { dist, prev } = dijkstraAll(this.graph, inc.nodeId);
    const withBeds = [...this.hospitals.values()].filter((h) => h.bedsFree > 0 && dist.has(h.nodeId));
    const pool = inc.severity === 'HIGH' && withBeds.some((h) => h.major) ? withBeds.filter((h) => h.major) : withBeds;
    pool.sort((a, b) => dist.get(a.nodeId) - dist.get(b.nodeId) || a.id.localeCompare(b.id));
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
    this.#dispatchPending();     // a returning unit can be re-assigned straight away
  }

  #becomeAvailable(unit) {
    Object.assign(unit, { status: UNIT_STATUS.AVAILABLE, trip: null, incidentId: null, hospitalId: null, phaseEndS: null });
    this.#unitChanged(unit);
    this.#dispatchPending();
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
          Object.assign(inc, { status: INCIDENT_STATUS.RESOLVED, resolvedS: this.now });
          this.#incidentChanged(inc);
          this.#goHome(unit);
        }
        break;
      }
      case 'ARRIVE_HOSPITAL': {
        const h = this.hospitals.get(unit.hospitalId);
        if (h) { h.bedsFree = Math.max(0, h.bedsFree - 1); this.emit('hospital:updated', { id: h.id, bedsFree: h.bedsFree }, ['dispatch']); }
        Object.assign(inc, { status: INCIDENT_STATUS.RESOLVED, resolvedS: this.now });
        this.#incidentChanged(inc);
        this.#goHome(unit);
        break;
      }
      case 'ARRIVE_HOME':
        this.#becomeAvailable(unit);
        break;
      default:
    }
  }

  // Advance simulated time by realMs, process due events in time order, broadcast positions.
  tick(realMs) {
    const target = this.clock.nowS + (realMs / 1000) * this.clock.speed;
    while (!this.events.isEmpty() && this.events.peek().time <= target) {
      const ev = this.events.pop();
      this.clock.nowS = Math.max(this.clock.nowS, ev.time);   // handle each event at its own time
      this.#handle(ev);
    }
    this.clock.nowS = target;
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

  incidentView(inc) {
    const { clientId, ...rest } = inc;
    return { ...rest, queue: inc.status === INCIDENT_STATUS.PENDING ? this.queue().find((q) => q.id === inc.id) ?? null : null };
  }

  snapshot() {
    return {
      simTimeS: round1(this.now), speed: this.clock.speed,
      units: [...this.units.values()].map((u) => this.unitView(u)),
      incidents: [...this.incidents.values()].map((i) => this.incidentView(i)),
      queue: this.queue(),
      hospitals: [...this.hospitals.values()].map((h) => ({ id: h.id, bedsFree: h.bedsFree })),
    };
  }

  #unitChanged(u) {
    const rooms = ['dispatch'];
    if (u.incidentId) rooms.push(`inc:${u.incidentId}`);
    this.emit('unit:updated', this.unitView(u), rooms);
  }

  #incidentChanged(inc) { this.emit('incident:updated', this.incidentView(inc), ['dispatch', `inc:${inc.id}`]); }

  #queueChanged() {
    const queue = this.queue();
    this.emit('queue:updated', queue, ['dispatch']);
    for (const q of queue) this.emit('incident:updated', this.incidentView(this.incidents.get(q.id)), [`inc:${q.id}`]);
  }
}

function round6(x) { return Math.round(x * 1e6) / 1e6; }
