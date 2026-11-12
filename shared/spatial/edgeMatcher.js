// Nearest-edge matching: which road is closest to a GPS point (e.g. a TomTom traffic segment point)?
//
// Junctions alone are not enough: a point in the middle of an 800 m road can be far from both of its
// junctions. So every road's geometry is sampled (all shape points + extra points every STEP_M metres)
// and the samples go into a 2-D k-d tree tagged with their road id.
//
// Query for a point P with search distance D:
//   1. k-d tree radius search with R = D + STEP_M / 2 gives candidate roads. If a road passes within D of P,
//      its closest point to P is within STEP_M / 2 of some sample, so that sample is within R.
//   2. Exact point-to-polyline distance for each candidate road; keep the nearest one within D.
// Coordinates are projected to metres (equirectangular around the graph's mean latitude).
// Build O(S log^2 S) for S samples; query O(log S + candidates x shape points).
import { KDTree, projectLatLng } from './kdtree.js';

export const STEP_M = 40;

// Distance from point (px, py) to segment (ax, ay)-(bx, by), plus the position t in [0, 1] along it.
export function pointSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const x = ax + t * dx, y = ay + t * dy;
  return { dist: Math.hypot(px - x, py - y), t };
}

export class EdgeIndex {
  // filter(road) -> boolean limits which roads can be matched (e.g. only major roads for traffic).
  constructor(graph, { stepM = STEP_M, filter = null } = {}) {
    this.graph = graph;
    this.stepM = stepM;
    let sum = 0;
    for (const loc of graph.locations.values()) sum += loc.lat;
    this.refLat = graph.locations.size ? sum / graph.locations.size : 0;
    this.projected = new Map();       // roadId -> [[x, y], ...]
    const samples = [];
    for (const road of graph.roads.values()) {
      if (filter && !filter(road)) continue;
      const pts = graph.roadGeometry(road.id, road.from).map(([lat, lng]) => {
        const p = projectLatLng(lat, lng, this.refLat);
        return [p.x, p.y];
      });
      this.projected.set(road.id, pts);
      for (let i = 0; i < pts.length; i++) {
        samples.push({ x: pts[i][0], y: pts[i][1], roadId: road.id });
        if (i + 1 < pts.length) {
          const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
          const n = Math.floor(Math.hypot(bx - ax, by - ay) / stepM);
          for (let k = 1; k <= n; k++) samples.push({ x: ax + ((bx - ax) * k) / (n + 1), y: ay + ((by - ay) * k) / (n + 1), roadId: road.id });
        }
      }
    }
    this.sampleCount = samples.length;
    this.tree = new KDTree(samples);
  }

  // Exact distance (m) from a projected point to a road's polyline.
  distanceToRoad(roadId, x, y) {
    const pts = this.projected.get(roadId);
    let best = { dist: Infinity, seg: -1, t: 0 };
    for (let i = 0; i + 1 < pts.length; i++) {
      const r = pointSegment(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (r.dist < best.dist) best = { dist: r.dist, seg: i, t: r.t };
    }
    if (pts.length === 1) best = { dist: Math.hypot(x - pts[0][0], y - pts[0][1]), seg: 0, t: 0 };
    return best;
  }

  // Nearest matchable road within maxDistM of (lat, lng): { roadId, distanceM, seg, t, candidates } or null.
  nearestEdge(lat, lng, maxDistM = 25) {
    const { x, y } = projectLatLng(lat, lng, this.refLat);
    const hits = this.tree.withinRadius(x, y, maxDistM + this.stepM / 2);
    const candidates = new Set(hits.map((h) => h.point.roadId));
    let best = null;
    for (const roadId of candidates) {
      const d = this.distanceToRoad(roadId, x, y);
      if (d.dist <= maxDistM && (!best || d.dist < best.distanceM || (d.dist === best.distanceM && roadId < best.roadId))) {
        best = { roadId, distanceM: d.dist, seg: d.seg, t: d.t };
      }
    }
    return best ? { ...best, candidates: candidates.size } : null;
  }
}
