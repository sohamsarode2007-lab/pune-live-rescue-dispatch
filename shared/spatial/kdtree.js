// 2-D k-d tree for nearest-neighbour queries ("which road junction is closest to this GPS point?").
//
// Each internal node splits the plane at the median point of its subset, alternating the axis
// (x at even depth, y at odd depth). Build: O(n log^2 n) (sort per level). Query: O(log n) average
// for well-spread points, O(n) worst case. Search descends towards the query first, then visits the
// other side only if the splitting line is closer than the best distance found so far (pruning).
//
// Points are planar {x, y, ...}. For lat/lng use projectLatLng() (equirectangular projection in metres,
// accurate to well under 0.1% over a city-sized area).

import { EARTH_RADIUS_M, haversineM } from './haversine.js';

const RAD = Math.PI / 180;

export function projectLatLng(lat, lng, refLat) {
  return { x: EARTH_RADIUS_M * lng * RAD * Math.cos(refLat * RAD), y: EARTH_RADIUS_M * lat * RAD };
}

const sq = (a) => a * a;
const dist2 = (p, x, y) => sq(p.x - x) + sq(p.y - y);

export class KDTree {
  constructor(points) {
    this.size = points.length;
    this.root = this.#build(points.slice(), 0);
  }

  #build(pts, depth) {
    if (pts.length === 0) return null;
    const axis = depth % 2 === 0 ? 'x' : 'y';
    pts.sort((a, b) => a[axis] - b[axis]);
    const mid = pts.length >> 1;
    return {
      point: pts[mid], axis,
      left: this.#build(pts.slice(0, mid), depth + 1),
      right: this.#build(pts.slice(mid + 1), depth + 1),
    };
  }

  // Nearest point to (x, y). Returns { point, dist, visited } or null for an empty tree.
  // `filter(point)` (optional) skips points that are not eligible.
  nearest(x, y, filter = null) {
    let best = null, bestD2 = Infinity, visited = 0;
    const search = (node) => {
      if (!node) return;
      visited++;
      const p = node.point;
      if (!filter || filter(p)) {
        const d2 = dist2(p, x, y);
        if (d2 < bestD2) { bestD2 = d2; best = p; }
      }
      const diff = (node.axis === 'x' ? x : y) - p[node.axis];
      const near = diff < 0 ? node.left : node.right;
      const far = diff < 0 ? node.right : node.left;
      search(near);
      if (sq(diff) < bestD2) search(far);   // the other side could still hold something closer
    };
    search(this.root);
    return best ? { point: best, dist: Math.sqrt(bestD2), visited } : null;
  }

  // All points within `radius` of (x, y), nearest first.
  withinRadius(x, y, radius) {
    const out = [], r2 = radius * radius;
    const search = (node) => {
      if (!node) return;
      const p = node.point;
      const d2 = dist2(p, x, y);
      if (d2 <= r2) out.push({ point: p, dist: Math.sqrt(d2) });
      const diff = (node.axis === 'x' ? x : y) - p[node.axis];
      if (diff < 0 || sq(diff) <= r2) search(node.left);
      if (diff >= 0 || sq(diff) <= r2) search(node.right);
    };
    search(this.root);
    return out.sort((a, b) => a.dist - b.dist);
  }
}

// Spatial index over a Graph's junctions: nearest road node to a GPS point.
export class NodeIndex {
  constructor(graph) {
    let sum = 0;
    for (const loc of graph.locations.values()) sum += loc.lat;
    this.refLat = graph.locations.size ? sum / graph.locations.size : 0;
    this.graph = graph;
    const pts = [...graph.locations.values()].map((loc) => ({ id: loc.id, ...projectLatLng(loc.lat, loc.lng, this.refLat) }));
    this.tree = new KDTree(pts);
  }

  // Returns { id, distanceM, visited } with distanceM measured by haversine.
  nearestNode(lat, lng) {
    const { x, y } = projectLatLng(lat, lng, this.refLat);
    const hit = this.tree.nearest(x, y);
    if (!hit) return null;
    const loc = this.graph.getLocation(hit.point.id);
    return { id: hit.point.id, distanceM: haversineM(lat, lng, loc.lat, loc.lng), visited: hit.visited };
  }

  nodesWithin(lat, lng, radiusM) {
    const { x, y } = projectLatLng(lat, lng, this.refLat);
    return this.tree.withinRadius(x, y, radiusM).map((h) => ({ id: h.point.id, distanceM: h.dist }));
  }
}
