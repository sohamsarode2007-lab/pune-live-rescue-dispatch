// Weighted road graph stored as an adjacency list.
// Junctions -> vertices (lat/lng), roads -> edges. Map gives O(1) average lookup by ID.
//
// Cost model (all in SECONDS of travel time):
//   cost = baseTimeS * trafficFactor + riskPenaltyS
//   baseTimeS     = lengthM / free-flow speed            (from road data)
//   trafficFactor = freeFlowSpeed / currentSpeed, >= 1   (1.0 = free flow; live traffic in Phase 4)
//   riskPenaltyS  = extra seconds for hazardous roads    (simulation parameter, see computeRiskPenaltyS)
//   status        = OPEN | HIGH_RISK | BLOCKED           (BLOCKED roads are never traversed)
// The components are stored separately so a route can report each one.

export const ROAD_STATUS = Object.freeze({
  OPEN: 'OPEN',
  HIGH_RISK: 'HIGH_RISK',
  BLOCKED: 'BLOCKED',
});

export const RISK_LEVEL = Object.freeze({ LOW: 'LOW', MODERATE: 'MODERATE' });

// Illustrative simulation parameters in seconds (not real-world safety standards).
export const RISK_PENALTY_S = Object.freeze({ HIGH_RISK: 120, OPEN_MODERATE: 30 });

export const TRAFFIC_FACTOR_MIN = 1.0;
export const TRAFFIC_FACTOR_MAX = 4.0;

export function computeRiskPenaltyS(status, riskLevel = RISK_LEVEL.LOW) {
  if (status === ROAD_STATUS.HIGH_RISK) return RISK_PENALTY_S.HIGH_RISK;
  if (status === ROAD_STATUS.OPEN) return riskLevel === RISK_LEVEL.MODERATE ? RISK_PENALTY_S.OPEN_MODERATE : 0;
  return 0; // BLOCKED: penalty irrelevant, road is not traversable
}

export const clampTrafficFactor = (f) =>
  Math.min(TRAFFIC_FACTOR_MAX, Math.max(TRAFFIC_FACTOR_MIN, Number.isFinite(f) ? f : 1));

export class Graph {
  constructor() {
    this.locations = new Map(); // id -> location { id, name, type, lat, lng, affected }
    this.roads = new Map();     // id -> road (single source of truth for road state)
    this.adjacency = new Map(); // id -> [{ roadId, from, to }]
    this._maxSpeedMps = null;   // cached for the A* heuristic; reset when roads are added
    this._inAdjacency = null;   // reverse adjacency, built on first use; reset when roads are added
    this.version = 0;           // bumped on every status/traffic change, so analyses know when they are stale
  }

  addLocation({ id, name = '', type = 'Intersection', lat, lng, affected = false }) {
    if (this.locations.has(id)) throw new Error(`Duplicate location ID: ${id}`);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`Location ${id} needs numeric lat/lng`);
    this.locations.set(id, { id, name, type, lat, lng, affected, initialAffected: affected });
    this.adjacency.set(id, []);
  }

  // oneWay=false: connection stored in both directions (both entries share ONE road object, so a
  // status change is seen in both directions). `geometry` is [[lat,lng],...] from `from` to `to`.
  addRoad({
    id, from, to, lengthM, baseTimeS, status = ROAD_STATUS.OPEN, riskLevel = RISK_LEVEL.LOW,
    oneWay = false, trafficFactor = 1, highway = 'unclassified', maxspeedKmh = null, name = '', geometry = null, bridge = false,
  }) {
    if (this.roads.has(id)) throw new Error(`Duplicate road ID: ${id}`);
    if (!this.locations.has(from) || !this.locations.has(to)) throw new Error(`Road ${id} references unknown location`);
    if (!(lengthM >= 0)) throw new Error(`Road ${id} must have non-negative length`);
    if (!(baseTimeS >= 0)) throw new Error(`Road ${id} must have non-negative base time`);
    const tf = clampTrafficFactor(trafficFactor);
    const road = {
      id, from, to, lengthM, baseTimeS, trafficFactor: tf, status, riskLevel, oneWay,
      highway, maxspeedKmh, name, geometry, bridge,
      riskPenaltyS: computeRiskPenaltyS(status, riskLevel),
      initialStatus: status, initialRiskLevel: riskLevel, initialTrafficFactor: tf,
    };
    this.roads.set(id, road);
    this.adjacency.get(from).push({ roadId: id, from, to });
    if (!oneWay) this.adjacency.get(to).push({ roadId: id, from: to, to: from });
    this._maxSpeedMps = null;
    this._inAdjacency = null;
    return road;
  }

  getLocation(id) { return this.locations.get(id); }
  getRoad(id) { return this.roads.get(id); }
  hasLocation(id) { return this.locations.has(id); }

  isTraversable(road) { return road.status !== ROAD_STATUS.BLOCKED; }
  travelTimeS(road) { return road.baseTimeS * road.trafficFactor; }
  roadCost(road) { return road.baseTimeS * road.trafficFactor + road.riskPenaltyS; }
  effectiveCost(road) { return this.isTraversable(road) ? this.roadCost(road) : null; }

  // Traversable outgoing edges of a vertex, in insertion order (deterministic).
  neighbors(id) {
    const out = [];
    for (const e of this.adjacency.get(id) ?? []) {
      const road = this.roads.get(e.roadId);
      if (!this.isTraversable(road)) continue;
      out.push({
        to: e.to, roadId: road.id, lengthM: road.lengthM,
        timeS: this.travelTimeS(road), riskPenaltyS: road.riskPenaltyS, cost: this.roadCost(road),
      });
    }
    return out;
  }

  // Traversable INCOMING edges of a vertex: roads u -> id, reported as { to: u, ... } so a search on the
  // reversed graph can use the same loop as a forward search. Used for "cost from every vertex TO id"
  // (e.g. ETA of every rescue unit to one incident with a single Dijkstra run).
  inNeighbors(id) {
    if (!this._inAdjacency) {
      this._inAdjacency = new Map([...this.locations.keys()].map((k) => [k, []]));
      for (const edges of this.adjacency.values()) {
        for (const e of edges) this._inAdjacency.get(e.to).push({ roadId: e.roadId, from: e.to, to: e.from });
      }
    }
    const out = [];
    for (const e of this._inAdjacency.get(id) ?? []) {
      const road = this.roads.get(e.roadId);
      if (!this.isTraversable(road)) continue;
      out.push({
        to: e.to, roadId: road.id, lengthM: road.lengthM,
        timeS: this.travelTimeS(road), riskPenaltyS: road.riskPenaltyS, cost: this.roadCost(road),
      });
    }
    return out;
  }

  setRoadStatus(roadId, status, riskLevel) {
    const road = this.roads.get(roadId);
    if (!road) throw new Error(`Unknown road: ${roadId}`);
    if (!Object.values(ROAD_STATUS).includes(status)) throw new Error(`Invalid status: ${status}`);
    road.status = status;
    if (riskLevel) road.riskLevel = riskLevel;
    road.riskPenaltyS = computeRiskPenaltyS(status, road.riskLevel);
    this.version++;
  }

  // Traffic can only slow a road down (factor clamped to [1, 4]), which keeps the A* heuristic admissible.
  setTrafficFactor(roadId, factor) {
    const road = this.roads.get(roadId);
    if (!road) throw new Error(`Unknown road: ${roadId}`);
    road.trafficFactor = clampTrafficFactor(factor);
    this.version++;
  }

  setLocationAffected(id, affected) {
    const loc = this.locations.get(id);
    if (!loc) throw new Error(`Unknown location: ${id}`);
    loc.affected = affected;
    this.version++;
  }

  // Restore every road and location to its original state.
  reset() {
    for (const road of this.roads.values()) {
      road.status = road.initialStatus;
      road.riskLevel = road.initialRiskLevel;
      road.trafficFactor = road.initialTrafficFactor;
      road.riskPenaltyS = computeRiskPenaltyS(road.status, road.riskLevel);
    }
    for (const loc of this.locations.values()) loc.affected = loc.initialAffected;
    this.version++;
  }

  countRoadsByStatus() {
    const c = { OPEN: 0, HIGH_RISK: 0, BLOCKED: 0 };
    for (const r of this.roads.values()) c[r.status]++;
    return c;
  }

  // Road geometry in the direction of travel (from -> to); straight line if none is stored.
  roadGeometry(roadId, fromId) {
    const r = this.roads.get(roadId);
    const a = this.locations.get(r.from), b = this.locations.get(r.to);
    const g = r.geometry ?? [[a.lat, a.lng], [b.lat, b.lng]];
    return fromId === r.from ? g.slice() : [...g].reverse();   // never hand out the internal array
  }
}
