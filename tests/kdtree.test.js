import test from 'node:test';
import assert from 'node:assert/strict';
import { KDTree, NodeIndex } from '../shared/spatial/kdtree.js';
import { haversineM } from '../shared/spatial/haversine.js';
import { rng, hasPuneData, loadPune, randomGraph } from './helpers.js';

const bruteNearest = (pts, x, y) => {
  let best = Infinity;
  for (const p of pts) best = Math.min(best, Math.hypot(p.x - x, p.y - y));
  return best;
};

test('empty and single-point trees', () => {
  assert.equal(new KDTree([]).nearest(0, 0), null);
  const t = new KDTree([{ id: 'a', x: 3, y: 4 }]);
  const hit = t.nearest(0, 0);
  assert.equal(hit.point.id, 'a');
  assert.equal(hit.dist, 5);
});

test('k-d tree nearest equals brute force on random points (sizes 2..2000, incl. duplicates)', () => {
  const r = rng(42);
  for (const n of [2, 3, 10, 100, 2000]) {
    const pts = Array.from({ length: n }, (_, i) => ({ id: i, x: Math.floor(r() * 1000), y: Math.floor(r() * 1000) }));
    pts.push({ ...pts[0], id: 'dup' });                           // a duplicate coordinate
    const tree = new KDTree(pts);
    for (let q = 0; q < 300; q++) {
      const x = r() * 1200 - 100, y = r() * 1200 - 100;
      const hit = tree.nearest(x, y);
      assert.ok(Math.abs(hit.dist - bruteNearest(pts, x, y)) < 1e-9, `n=${n} query (${x}, ${y})`);
      assert.ok(Math.abs(Math.hypot(hit.point.x - x, hit.point.y - y) - hit.dist) < 1e-9);
    }
  }
});

test('pruning: a query visits far fewer nodes than n on spread-out points', () => {
  const r = rng(3);
  const pts = Array.from({ length: 5000 }, (_, i) => ({ id: i, x: r() * 1e4, y: r() * 1e4 }));
  const tree = new KDTree(pts);
  let visited = 0;
  for (let q = 0; q < 200; q++) visited += tree.nearest(r() * 1e4, r() * 1e4).visited;
  assert.ok(visited / 200 < 200, `average visited ${visited / 200}`);
});

test('nearest with a filter skips ineligible points', () => {
  const pts = [{ id: 'a', x: 0, y: 0, ok: false }, { id: 'b', x: 5, y: 0, ok: true }, { id: 'c', x: 9, y: 0, ok: true }];
  assert.equal(new KDTree(pts).nearest(1, 0, (p) => p.ok).point.id, 'b');
});

test('withinRadius equals brute force', () => {
  const r = rng(11);
  const pts = Array.from({ length: 800 }, (_, i) => ({ id: i, x: r() * 100, y: r() * 100 }));
  const tree = new KDTree(pts);
  for (let q = 0; q < 100; q++) {
    const x = r() * 100, y = r() * 100, rad = r() * 15;
    const got = tree.withinRadius(x, y, rad).map((h) => h.point.id).sort((a, b) => a - b);
    const want = pts.filter((p) => Math.hypot(p.x - x, p.y - y) <= rad).map((p) => p.id).sort((a, b) => a - b);
    assert.deepEqual(got, want);
  }
});

test('NodeIndex (lat/lng) matches brute-force haversine nearest on a random graph', () => {
  const g = randomGraph(5, 300, 400);
  const idx = new NodeIndex(g);
  const r = rng(8);
  for (let q = 0; q < 300; q++) {
    const lat = 18.5 + r() * 0.02, lng = 73.8 + r() * 0.02;
    let best = Infinity;
    for (const loc of g.locations.values()) best = Math.min(best, haversineM(lat, lng, loc.lat, loc.lng));
    // equirectangular projection vs haversine differ by far less than a millimetre here
    assert.ok(Math.abs(idx.nearestNode(lat, lng).distanceM - best) < 0.01);
  }
});

test('NodeIndex on the real Pune graph matches brute force for 500 random GPS points',
  { skip: !hasPuneData && 'Pune graph not generated' }, async () => {
    const { graph, index, meta } = await loadPune();
    const { north, south, east, west } = meta.bbox;
    const r = rng(2024);
    const locs = [...graph.locations.values()];
    for (let q = 0; q < 500; q++) {
      const lat = south + r() * (north - south), lng = west + r() * (east - west);
      let best = Infinity;
      for (const loc of locs) best = Math.min(best, haversineM(lat, lng, loc.lat, loc.lng));
      // projection distortion over the 8 km bbox is < 0.1%, so allow that much on near-ties
      assert.ok(Math.abs(index.nearestNode(lat, lng).distanceM - best) <= best * 1e-3 + 0.01, `(${lat}, ${lng})`);
    }
  });
