import test from 'node:test';
import assert from 'node:assert/strict';
import { EdgeIndex, pointSegment } from '../shared/spatial/edgeMatcher.js';
import { projectLatLng } from '../shared/spatial/kdtree.js';
import { rng, randomGraph, hasPuneData, loadPune } from './helpers.js';

test('pointSegment: distance and position along the segment', () => {
  assert.deepEqual(pointSegment(5, 5, 0, 0, 10, 0), { dist: 5, t: 0.5 });
  assert.equal(pointSegment(-3, 4, 0, 0, 10, 0).dist, 5);            // beyond the start: distance to the endpoint
  assert.equal(pointSegment(1, 1, 2, 2, 2, 2).dist, Math.SQRT2);     // zero-length segment
});

// Brute force: exact distance to every road's polyline.
function bruteNearest(idx, graph, lat, lng, maxD, filter = null) {
  const { x, y } = projectLatLng(lat, lng, idx.refLat);
  let best = null;
  for (const r of graph.roads.values()) {
    if (filter && !filter(r)) continue;
    const d = idx.distanceToRoad(r.id, x, y).dist;
    if (d <= maxD && (!best || d < best.d)) best = { id: r.id, d };
  }
  return best;
}

test('nearest edge equals brute force on a random graph (300 random points)', () => {
  const g = randomGraph(12, 80, 160, { closures: false });
  const idx = new EdgeIndex(g, { stepM: 40 });
  const r = rng(5);
  for (let k = 0; k < 300; k++) {
    const lat = 18.5 + r() * 0.02, lng = 73.8 + r() * 0.02;
    const want = bruteNearest(idx, g, lat, lng, 60);
    const got = idx.nearestEdge(lat, lng, 60);
    if (!want) assert.equal(got, null);
    else assert.ok(got && Math.abs(got.distanceM - want.d) < 1e-6, `point ${k}: ${got?.distanceM} vs ${want.d}`);
  }
});

test('nearest edge equals brute force on the real Pune graph, incl. points mid-way along long roads',
  { skip: !hasPuneData && 'Pune graph not generated' }, async () => {
    const { graph, meta } = await loadPune();
    const major = (road) => ['trunk', 'primary', 'secondary', 'tertiary'].includes(road.highway);
    const idx = new EdgeIndex(graph, { filter: major });
    const r = rng(9);
    const { north, south, east, west } = meta.bbox;
    // random points, plus points 10 m off the middle of the 30 longest major roads (far from both junctions)
    const pts = Array.from({ length: 200 }, () => [south + r() * (north - south), west + r() * (east - west)]);
    const longest = [...graph.roads.values()].filter(major).sort((a, b) => b.lengthM - a.lengthM).slice(0, 30);
    for (const road of longest) {
      const g = graph.roadGeometry(road.id, road.from);
      const m = g[Math.floor(g.length / 2)];
      pts.push([m[0] + 10 / 111195, m[1]]);
    }
    for (const [lat, lng] of pts) {
      const want = bruteNearest(idx, graph, lat, lng, 25, major);
      const got = idx.nearestEdge(lat, lng, 25);
      if (!want) assert.equal(got, null, `(${lat}, ${lng})`);
      else assert.ok(got && Math.abs(got.distanceM - want.d) < 1e-6, `(${lat}, ${lng}): ${got?.distanceM} vs ${want.d}`);
    }
  });
