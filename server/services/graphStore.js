// Loads the generated Pune road graph + facilities into our Graph / NodeIndex structures and answers
// routing queries. Pure computation: all routing is our own Dijkstra / A* from shared/.
import fs from 'node:fs';
import { Graph, ROAD_STATUS } from '../../shared/graph/Graph.js';
import { dijkstra } from '../../shared/graph/dijkstra.js';
import { astar, maxHeuristicSpeedMps } from '../../shared/graph/astar.js';
import { bfs } from '../../shared/graph/bfs.js';
import { dfs } from '../../shared/graph/dfs.js';
import { NodeIndex } from '../../shared/spatial/kdtree.js';

export const kmhToMps = (kmh) => kmh / 3.6;

// Builds a Graph from the JSON written by scripts/build_graph.py.
// baseTimeS = lengthM / speed, where speed is the tagged maxspeed or the default for the highway type.
export function graphFromJson(data) {
  const g = new Graph();
  for (const n of data.nodes) g.addLocation({ id: n.id, lat: n.lat, lng: n.lng });
  for (const e of data.edges) {
    g.addRoad({
      id: e.id, from: e.from, to: e.to, lengthM: e.lengthM,
      baseTimeS: e.lengthM / kmhToMps(e.maxspeedKmh),
      oneWay: e.oneway, highway: e.highway, maxspeedKmh: e.maxspeedKmh, name: e.name, geometry: e.geometry,
      bridge: Boolean(e.bridge),
    });
  }
  return g;
}

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const ALGORITHMS = { astar, dijkstra };
const TRAVERSALS = { bfs, dfs };

// Joins the geometry of every road on a route into one polyline in the direction of travel.
export function routeGeometry(graph, route) {
  if (!route.reachable) return [];
  if (route.roadIds.length === 0) {
    const p = graph.getLocation(route.source);
    return [[p.lat, p.lng]];
  }
  const out = [];
  route.roadIds.forEach((rid, i) => {
    const seg = graph.roadGeometry(rid, route.path[i]);
    out.push(...(i === 0 ? seg : seg.slice(1)));
  });
  return out;
}

export class GraphStore {
  constructor(graphJson, facilitiesJson) {
    const t0 = performance.now();
    this.meta = graphJson.meta;
    this.graph = graphFromJson(graphJson);
    this.index = new NodeIndex(this.graph);
    this.facilities = facilitiesJson?.facilities ?? [];
    this.units = facilitiesJson?.units ?? [];
    this.facilitiesMeta = facilitiesJson?.meta ?? null;
    this.loadMs = performance.now() - t0;
    this.closureSource = new Map();
    maxHeuristicSpeedMps(this.graph);
  }

  static fromFiles(graphFile, facilitiesFile) {
    const facilities = fs.existsSync(facilitiesFile) ? loadJson(facilitiesFile) : null;
    return new GraphStore(loadJson(graphFile), facilities);
  }

  summary() {
    const g = this.graph;
    let lengthM = 0;
    for (const r of g.roads.values()) lengthM += r.lengthM;
    return {
      area: this.meta.area, bbox: this.meta.bbox, source: this.meta.source, generatedAt: this.meta.generatedAt,
      nodes: g.locations.size, roads: g.roads.size,
      oneWayRoads: [...g.roads.values()].filter((r) => r.oneWay).length,
      roadKm: Math.round(lengthM / 100) / 10,
      statusCounts: g.countRoadsByStatus(),
      heuristicMaxSpeedKmh: Math.round(maxHeuristicSpeedMps(g) * 3.6 * 10) / 10,
      loadMs: Math.round(this.loadMs),
    };
  }

  nearest(lat, lng) {
    const hit = this.index.nearestNode(lat, lng);
    if (!hit) return null;
    const loc = this.graph.getLocation(hit.id);
    return { nodeId: hit.id, lat: loc.lat, lng: loc.lng, distanceM: Math.round(hit.distanceM * 10) / 10 };
  }

  // Route between two GPS points (each snapped to its nearest junction with the k-d tree).
  // Runs the requested algorithms and reports cost components, settled-node counts and run time.
  route(from, to, algorithms = ['astar', 'dijkstra']) {
    const a = this.nearest(from.lat, from.lng);
    const b = this.nearest(to.lat, to.lng);
    const results = {};
    for (const name of algorithms) {
      const fn = ALGORITHMS[name];
      if (!fn) throw new Error(`Unknown algorithm: ${name}`);
      const t0 = performance.now();
      const r = fn(this.graph, a.nodeId, b.nodeId);
      const ms = performance.now() - t0;
      results[name] = {
        reachable: r.reachable,
        totalCostS: r.totalCost, totalTimeS: r.totalTimeS, totalRiskPenaltyS: r.totalRiskPenaltyS,
        totalLengthM: r.totalLengthM, roadCount: r.roadCount,
        settled: r.stats.settled, heapExtractions: r.stats.heapExtractions, ms: Math.round(ms * 100) / 100,
        roadIds: r.roadIds,
        roads: r.roadIds.map((id) => {
          const road = this.graph.getRoad(id);
          return { id, name: road.name, highway: road.highway, lengthM: road.lengthM, status: road.status };
        }),
        geometry: routeGeometry(this.graph, r),
      };
    }
    return { from: a, to: b, results };
  }

  // BFS / DFS from the junction nearest to a GPS point, for the /algorithms visualisation.
  // order[i] = [lat, lng, depth, parentIndex] (parentIndex = index into order, -1 for the start).
  traverse(kind, lat, lng) {
    const fn = TRAVERSALS[kind];
    if (!fn) throw new Error(`Unknown traversal: ${kind}`);
    const start = this.nearest(lat, lng);
    const t0 = performance.now();
    const r = fn(this.graph, start.nodeId);
    const ms = performance.now() - t0;
    const index = new Map(r.order.map((id, i) => [id, i]));
    let maxDepth = 0;
    const order = r.order.map((id) => {
      const loc = this.graph.getLocation(id);
      const p = r.parent.get(id);
      const depth = r.depth.get(id);
      maxDepth = Math.max(maxDepth, depth);
      return [loc.lat, loc.lng, depth, p ? index.get(p.from) : -1];
    });
    return {
      algorithm: kind, start, order, reached: r.order.length, total: this.graph.locations.size,
      maxDepth, maxStack: r.maxStack ?? null, ms: Math.round(ms * 100) / 100,
      blockedRoads: this.graph.countRoadsByStatus().BLOCKED,
    };
  }

  // source: who closed it ('manual' | 'flood' | 'crowd' | 'crossing'), shown in the closures list.
  setRoadStatus(roadId, status, source = 'manual') {
    this.graph.setRoadStatus(roadId, status);
    if (status === 'OPEN') this.closureSource.delete(roadId); else this.closureSource.set(roadId, source);
    return this.roadInfo(roadId);
  }

  roadInfo(roadId) {
    const r = this.graph.getRoad(roadId);
    if (!r) return null;
    return {
      id: r.id, name: r.name, highway: r.highway, status: r.status, lengthM: r.lengthM, oneWay: r.oneWay,
      maxspeedKmh: r.maxspeedKmh, baseTimeS: r.baseTimeS, trafficFactor: r.trafficFactor, riskPenaltyS: r.riskPenaltyS,
      bridge: r.bridge, source: this.closureSource.get(r.id) ?? null,
      geometry: this.graph.roadGeometry(r.id, r.from),
    };
  }

  // Only non-OPEN roads are sent to the client (we never draw the whole network).
  closedRoads() {
    return [...this.graph.roads.values()].filter((r) => r.status !== ROAD_STATUS.OPEN).map((r) => this.roadInfo(r.id));
  }

  resetRoads() { this.graph.reset(); this.closureSource?.clear(); }
}
