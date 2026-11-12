import { SEVERITY, REQUEST_STATUS, DISASTER_TYPES } from '../data/requestConstants.js';
import { EmergencyPriorityQueue, priorityScore } from '../algorithms/EmergencyPriorityQueue.js';
import { dijkstra } from '../algorithms/dijkstra.js';
import { compareStations } from './routingService.js';

export { SEVERITY, REQUEST_STATUS, priorityScore };

export function makeRequest({ id, locationId, disasterType, severity, peopleAffected, waitingTimeScore = 0, origin = 'MANUAL' }) {
  if (!(severity in SEVERITY)) throw new Error(`Invalid severity: ${severity}`);
  return {
    id, locationId, disasterType, severity, peopleAffected, waitingTimeScore,
    status: REQUEST_STATUS.PENDING, assignedStation: null,
    origin, // 'FLOOD' | 'FIRE' | 'MANUAL': scenarios replace only their own requests
  };
}

// Map gives O(1) average lookup by request ID.
export class RequestStore {
  constructor() { this.byId = new Map(); this.manualCounter = 0; }
  has(id) { return this.byId.has(id); }
  get(id) { return this.byId.get(id); }
  add(req) {
    if (this.byId.has(req.id)) throw new Error(`Duplicate request ID: ${req.id}`);
    this.byId.set(req.id, req);
  }
  nextManualId() {
    let id;
    do { id = `REQ-${String(++this.manualCounter).padStart(3, '0')}`; } while (this.byId.has(id));
    return id;
  }
  list() { return [...this.byId.values()]; }
  removeWhere(pred) { for (const [id, r] of this.byId) if (pred(r)) this.byId.delete(id); }
  clear() { this.byId.clear(); this.manualCounter = 0; }
  get size() { return this.byId.size; }
}

const fail = (error) => ({ ok: false, error });

// ---- creating requests (manual) ----
export function createRequest(store, graph, f) {
  if (!graph.hasLocation(f.locationId)) return fail('Choose a valid incident location.');
  if (!DISASTER_TYPES.includes(f.disasterType)) return fail('Choose a disaster type.');
  if (!(f.severity in SEVERITY)) return fail('Choose a severity level.');
  if (!Number.isInteger(f.peopleAffected) || f.peopleAffected < 1 || f.peopleAffected > 100000) return fail('People affected must be a whole number from 1 to 100000.');
  if (!Number.isInteger(f.waitingTimeScore) || f.waitingTimeScore < 0 || f.waitingTimeScore > 1000) return fail('Waiting-time score must be a whole number from 0 to 1000.');
  const req = makeRequest({ ...f, id: store.nextManualId(), origin: 'MANUAL' });
  store.add(req);
  return { ok: true, request: req };
}

// ---- priority queue views ----
export const pendingRequests = (store) => store.list().filter((r) => r.status === REQUEST_STATUS.PENDING);
export const activeRequests = (store) => store.list().filter((r) => r.status !== REQUEST_STATUS.COMPLETED);

// The queue is built from PENDING requests only, so assigned/completed ones can never be selected.
export function buildPriorityQueue(store) {
  const q = new EmergencyPriorityQueue();
  pendingRequests(store).forEach((r) => q.insert(r));
  return q;
}
export const getPriorityOrder = (store) => buildPriorityQueue(store).toSortedArray();
export const selectNextRequest = (store) => buildPriorityQueue(store).peek() ?? null;

// ---- status changes ----
// Assign one rescue team to a pending request. With no stationId, the lowest-cost reachable station is used.
export function assignRequest(store, graph, requestId, stationId = null) {
  const req = store.get(requestId);
  if (!req) return fail(`Request ${requestId} not found.`);
  if (req.status !== REQUEST_STATUS.PENDING) return fail(`Request ${requestId} is already ${req.status.toLowerCase()}; only pending requests can be assigned.`);
  const dest = graph.getLocation(req.locationId);

  let chosen = stationId, route;
  if (stationId) {
    const st = graph.getLocation(stationId);
    if (!st || st.type !== 'Rescue Station') return fail('Choose a valid rescue station.');
    route = dijkstra(graph, stationId, req.locationId);
    if (!route.reachable) return fail(`No route is currently available from ${stationId} to ${dest.name}. Request left pending.`);
  } else {
    const { recommended, results } = compareStations(graph, req.locationId);
    if (!recommended) return fail(`No route is currently available from any rescue station to ${dest.name}. Request left pending.`);
    chosen = recommended;
    route = results.find((x) => x.stationId === recommended).route;
  }
  req.status = REQUEST_STATUS.ASSIGNED;
  req.assignedStation = chosen;
  return { ok: true, stationId: chosen, route };
}

export function completeRequest(store, requestId) {
  const req = store.get(requestId);
  if (!req) return fail(`Request ${requestId} not found.`);
  if (req.status === REQUEST_STATUS.COMPLETED) return fail(`Request ${requestId} is already completed.`);
  req.status = REQUEST_STATUS.COMPLETED;
  return { ok: true };
}

// ---- metrics (all derived from the store) ----
export function requestStats(store) {
  const all = store.list();
  const bySeverity = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  all.filter((r) => r.status !== REQUEST_STATUS.COMPLETED).forEach((r) => bySeverity[r.severity]++);
  const count = (s) => all.filter((r) => r.status === s).length;
  return {
    total: all.length,
    pending: count(REQUEST_STATUS.PENDING),
    assigned: count(REQUEST_STATUS.ASSIGNED),
    completed: count(REQUEST_STATUS.COMPLETED),
    active: all.length - count(REQUEST_STATUS.COMPLETED),
    bySeverity, // active requests per severity level
  };
}
