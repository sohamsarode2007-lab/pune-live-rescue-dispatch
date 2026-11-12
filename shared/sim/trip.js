// A "trip" = a vehicle driving a route, as a timed polyline.
//
//   points[i] = [lat, lng], times[i] = simulated time the vehicle passes points[i] (non-decreasing).
//   marks     = the junctions on the route: { idx (into points), nodeId, time }.
//
// Each road takes its routing cost in seconds (baseTimeS × trafficFactor + riskPenaltyS), so the
// displayed ETA equals the cost Dijkstra/A* minimised. Inside a road, time is spread over its
// geometry in proportion to distance (constant speed along the road).
//
// positionAt(t) uses binary search over `times` (prefix sums of segment durations): O(log n).
import { haversineM } from '../spatial/haversine.js';

const lerp = (a, b, f) => a + (b - a) * f;

export function buildTrip(graph, route, startTimeS, prefix = null) {
  const points = [], times = [], marks = [];
  let t = startTimeS;
  if (prefix) {                      // the rest of a road the vehicle is already driving
    prefix.points.forEach((p, i) => { points.push(p); times.push(prefix.times[i]); });
    t = prefix.times.at(-1);
  }
  const startNode = route.path[0];
  const s = graph.getLocation(startNode);
  if (!points.length) { points.push([s.lat, s.lng]); times.push(t); }
  marks.push({ idx: points.length - 1, nodeId: startNode, time: t });

  route.roadIds.forEach((rid, k) => {
    const road = graph.getRoad(rid);
    const geom = graph.roadGeometry(rid, route.path[k]);
    const cost = graph.roadCost(road);
    const seg = [];
    let total = 0;
    for (let i = 1; i < geom.length; i++) {
      const d = haversineM(geom[i - 1][0], geom[i - 1][1], geom[i][0], geom[i][1]);
      seg.push(d); total += d;
    }
    let acc = 0;
    for (let i = 1; i < geom.length; i++) {
      acc += seg[i - 1];
      points.push(geom[i]);
      times.push(t + (total > 0 ? (acc / total) * cost : (i / (geom.length - 1)) * cost));
    }
    t += cost;
    times[times.length - 1] = t;     // avoid floating drift at junctions
    marks.push({ idx: points.length - 1, nodeId: route.path[k + 1], time: t });
  });
  return { points, times, marks, startS: times[0], endS: times.at(-1), roadIds: route.roadIds, path: route.path };
}

// Largest i with times[i] <= t (binary search), clamped to [0, n-1].
export function segmentIndex(trip, t) {
  const { times } = trip;
  if (t <= times[0]) return 0;
  if (t >= times.at(-1)) return times.length - 1;
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  return lo;
}

export function positionAt(trip, t) {
  const i = segmentIndex(trip, t);
  const { points, times } = trip;
  if (i >= points.length - 1) return { lat: points.at(-1)[0], lng: points.at(-1)[1], idx: points.length - 1 };
  const span = times[i + 1] - times[i];
  const f = span > 0 ? (t - times[i]) / span : 0;
  return { lat: lerp(points[i][0], points[i + 1][0], f), lng: lerp(points[i][1], points[i + 1][1], f), idx: i };
}

// First junction reached at or after time t: where a re-route can start from.
export function nextJunction(trip, t) {
  for (const m of trip.marks) if (m.time >= t) return m;
  return trip.marks.at(-1);
}

// The piece of the trip from the current position (time t) to the next junction, used as the
// prefix of a new trip when a moving vehicle is re-assigned.
export function partialToNextJunction(trip, t) {
  const j = nextJunction(trip, t);
  const pos = positionAt(trip, t);
  const points = [[pos.lat, pos.lng]], times = [t];
  for (let i = pos.idx + 1; i <= j.idx; i++) { points.push(trip.points[i]); times.push(trip.times[i]); }
  return { junction: j, prefix: { points, times } };
}

// Roads the vehicle has not started yet at time t (after its next junction). The road it is on now is
// not included: a vehicle already on a road finishes it to the next junction.
export function upcomingRoadIds(trip, t) {
  const m = trip.marks.findIndex((x) => x.time >= t);
  return m === -1 ? [] : trip.roadIds.slice(m);
}

// Remaining geometry from time t (for drawing what is still ahead).
export function remainingPoints(trip, t) {
  const pos = positionAt(trip, t);
  return [[pos.lat, pos.lng], ...trip.points.slice(pos.idx + 1)];
}
