import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Graph } from '../shared/graph/Graph.js';
import { haversineM } from '../shared/spatial/haversine.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GRAPH_FILE = path.join(ROOT, 'server', 'data', 'pune-central.graph.json');
export const FACILITIES_FILE = path.join(ROOT, 'server', 'data', 'facilities.json');
export const hasPuneData = fs.existsSync(GRAPH_FILE);

// Deterministic pseudo-random numbers in [0, 1) (mulberry32), so failures are reproducible.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Diamond: A-B-D is 2 roads costing 10 s; A-C-E-D is 3 roads costing 6 s. Speeds 10 m/s.
export function smallGraph() {
  const g = new Graph();
  ['A', 'B', 'C', 'D', 'E'].forEach((id, i) => g.addLocation({ id, name: id, lat: 18.5, lng: 73.8 + i * 0.0001 }));
  const R = (id, from, to, s) => g.addRoad({ id, from, to, lengthM: s * 10, baseTimeS: s });
  R('r1', 'A', 'B', 5);
  R('r2', 'B', 'D', 5);
  R('r3', 'A', 'C', 2);
  R('r4', 'C', 'E', 2);
  R('r5', 'E', 'D', 2);
  return g;
}

// Random road-like graph: junctions in a ~2 km box, roads at least as long as the straight line,
// random speeds, one-way streets, traffic factors and closures.
export function randomGraph(seed, n = 40, m = 90, { closures = true } = {}) {
  const r = rng(seed);
  const g = new Graph();
  for (let i = 0; i < n; i++) g.addLocation({ id: `v${i}`, lat: 18.5 + r() * 0.02, lng: 73.8 + r() * 0.02 });
  const add = (k, a, b) => {
    const A = g.getLocation(`v${a}`), B = g.getLocation(`v${b}`);
    const straight = haversineM(A.lat, A.lng, B.lat, B.lng);
    const lengthM = straight * (1 + r() * 0.6);
    const speed = (15 + r() * 45) / 3.6;
    g.addRoad({ id: `e${k}`, from: `v${a}`, to: `v${b}`, lengthM, baseTimeS: lengthM / speed, oneWay: r() < 0.25 });
  };
  let k = 0;
  for (let i = 1; i < n; i++) add(k++, i, Math.floor(r() * i));       // spanning tree keeps most of it connected
  while (k < m) {
    const a = Math.floor(r() * n), b = Math.floor(r() * n);
    if (a !== b) add(k++, a, b);
  }
  for (const road of g.roads.values()) {
    if (r() < 0.3) g.setTrafficFactor(road.id, 1 + r() * 3);
    if (closures) {
      const x = r();
      if (x < 0.06) g.setRoadStatus(road.id, 'BLOCKED');
      else if (x < 0.12) g.setRoadStatus(road.id, 'HIGH_RISK');
    }
  }
  return g;
}

// Test-only reference: Bellman-Ford single-source costs (Infinity = unreachable).
export function bellmanFord(g, src) {
  const d = new Map([...g.locations.keys()].map((k) => [k, Infinity]));
  d.set(src, 0);
  for (let i = 0; i < g.locations.size; i++) {
    let changed = false;
    for (const u of g.locations.keys()) {
      if (d.get(u) === Infinity) continue;
      for (const e of g.neighbors(u)) if (d.get(u) + e.cost < d.get(e.to)) { d.set(e.to, d.get(u) + e.cost); changed = true; }
    }
    if (!changed) break;
  }
  return d;
}

// Every road in a route must exist, be currently traversable, connect consecutive path vertices
// in a legal direction, and the reported cost must equal the sum of the road costs.
export function routeIsValid(g, route) {
  if (!route.reachable) return route.path.length === 0;
  if (route.path.length !== route.roadIds.length + 1) return false;
  const ok = route.roadIds.every((rid, i) => {
    const r = g.getRoad(rid);
    if (!r || !g.isTraversable(r)) return false;
    const a = route.path[i], b = route.path[i + 1];
    return (r.from === a && r.to === b) || (!r.oneWay && r.from === b && r.to === a);
  });
  const sum = route.roadIds.reduce((s, rid) => s + g.roadCost(g.getRoad(rid)), 0);
  return ok && Math.abs(sum - route.totalCost) < 1e-6;
}

let puneCache = null;
export async function loadPune() {
  if (!puneCache) {
    const { GraphStore } = await import('../server/services/graphStore.js');
    puneCache = GraphStore.fromFiles(GRAPH_FILE, FACILITIES_FILE);
  }
  return puneCache;
}
