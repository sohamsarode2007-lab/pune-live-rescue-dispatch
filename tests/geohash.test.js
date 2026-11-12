import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, bounds, neighbours, GeohashIndex } from '../shared/spatial/geohash.js';
import { SosClusterer } from '../shared/dispatch/sosClusterer.js';
import { haversineM } from '../shared/spatial/haversine.js';
import { rng } from './helpers.js';

// Point `dist` metres from (lat, lng) at bearing `deg` (small-distance approximation, checked by haversine).
function offset(lat, lng, dist, deg) {
  const b = (deg * Math.PI) / 180;
  return { lat: lat + (dist * Math.cos(b)) / 111195, lng: lng + (dist * Math.sin(b)) / (111195 * Math.cos((lat * Math.PI) / 180)) };
}

test('geohash encode matches the published reference value', () => {
  assert.equal(encode(57.64911, 10.40744, 11), 'u4pruydqqvj');      // Wikipedia example
  assert.equal(encode(18.5196, 73.8553, 5), encode(18.5196, 73.8553, 7).slice(0, 5));  // prefix property
});

test('decode/bounds: the cell contains the point; precision-7 cells are ~145 x 153 m in Pune', () => {
  const r = rng(1);
  for (let k = 0; k < 200; k++) {
    const lat = 18.49 + r() * 0.07, lng = 73.80 + r() * 0.08;
    const b = bounds(encode(lat, lng, 7));
    assert.ok(lat >= b.minLat && lat < b.maxLat && lng >= b.minLng && lng < b.maxLng);
  }
  const b = bounds(encode(18.52, 73.85, 7));
  const w = haversineM(18.52, b.minLng, 18.52, b.maxLng), h = haversineM(b.minLat, 73.85, b.maxLat, 73.85);
  assert.ok(w > 140 && w < 150 && h > 150 && h < 156, `${w} x ${h}`);
  const c = decode(encode(18.52, 73.85, 7));
  assert.ok(haversineM(c.lat, c.lng, 18.52, 73.85) < 110);
});

test('neighbours: 8 distinct cells that touch the centre cell', () => {
  const h = encode(18.5196, 73.8553, 7);
  const ns = neighbours(h);
  assert.equal(new Set(ns).size, 8);
  assert.ok(!ns.includes(h));
  const c = bounds(h);
  for (const n of ns) {
    const b = bounds(n);
    const touchLat = Math.abs(b.maxLat - c.minLat) < 1e-12 || Math.abs(b.minLat - c.maxLat) < 1e-12 || Math.abs(b.minLat - c.minLat) < 1e-12;
    const touchLng = Math.abs(b.maxLng - c.minLng) < 1e-12 || Math.abs(b.minLng - c.maxLng) < 1e-12 || Math.abs(b.minLng - c.minLng) < 1e-12;
    assert.ok(touchLat && touchLng, n);
  }
});

test('every point within 100 m lies in the 3x3 block (2000 random pairs) — why the neighbour check is enough', () => {
  const r = rng(2);
  for (let k = 0; k < 2000; k++) {
    const lat = 18.49 + r() * 0.07, lng = 73.80 + r() * 0.08;
    const q = offset(lat, lng, r() * 100, r() * 360);
    if (haversineM(lat, lng, q.lat, q.lng) > 100) continue;
    const h = encode(lat, lng, 7);
    assert.ok([h, ...neighbours(h)].includes(encode(q.lat, q.lng, 7)));
  }
});

test('GeohashIndex.query finds exactly the brute-force ids within 100 m (plus nearby extras)', () => {
  const r = rng(3);
  const idx = new GeohashIndex(7);
  const pts = Array.from({ length: 3000 }, (_, i) => ({ id: i, lat: 18.50 + r() * 0.02, lng: 73.83 + r() * 0.02 }));
  pts.forEach((p) => idx.add(p.id, p.lat, p.lng));
  for (let k = 0; k < 200; k++) {
    const lat = 18.50 + r() * 0.02, lng = 73.83 + r() * 0.02;
    const got = new Set(idx.query(lat, lng).ids);
    for (const p of pts) if (haversineM(lat, lng, p.lat, p.lng) <= 100) assert.ok(got.has(p.id));
  }
  idx.remove(0); idx.remove(0);
  assert.equal(idx.size, 2999);
});

// ---------- SOS clustering ----------
const call = (p, type = 'medical') => ({ ...p, type });

test('clustering: two calls 30 m apart within a minute merge', () => {
  const c = new SosClusterer();
  const a = { lat: 18.5196, lng: 73.8553 };
  c.add({ id: 'INC-1', ...a, type: 'medical', createdS: 0 });
  const m = c.findMatch(call(offset(a.lat, a.lng, 30, 45)), 60);
  assert.equal(m?.id, 'INC-1');
  assert.ok(m.distanceM < 31);
});

test('clustering: no merge beyond 100 m (120 m apart)', () => {
  const c = new SosClusterer();
  const a = { lat: 18.5196, lng: 73.8553 };
  c.add({ id: 'INC-1', ...a, type: 'medical', createdS: 0 });
  const q = offset(a.lat, a.lng, 120, 90);
  assert.ok(haversineM(a.lat, a.lng, q.lat, q.lng) > 100);
  assert.equal(c.findMatch(call(q), 10), null);
});

test('clustering: merge across a geohash cell boundary (found through the neighbour check)', () => {
  const c = new SosClusterer();
  const b = bounds(encode(18.5196, 73.8553, 7));
  const lat = (b.minLat + b.maxLat) / 2;
  const west = { lat, lng: b.maxLng - 0.0002 };      // ~21 m inside the cell's east edge
  const east = { lat, lng: b.maxLng + 0.0002 };      // ~21 m into the next cell
  assert.notEqual(encode(west.lat, west.lng, 7), encode(east.lat, east.lng, 7));
  c.add({ id: 'INC-1', ...west, type: 'fire', createdS: 0 });
  assert.equal(c.findMatch(call(east, 'fire'), 30)?.id, 'INC-1');
});

test('clustering: no merge after 5 minutes, and never across incident types', () => {
  const c = new SosClusterer();
  const a = { lat: 18.5196, lng: 73.8553 };
  c.add({ id: 'INC-1', ...a, type: 'flood', createdS: 100 });
  assert.equal(c.findMatch(call(a, 'flood'), 100 + 300)?.id, 'INC-1');   // exactly 5 min: still merges
  assert.equal(c.findMatch(call(a, 'flood'), 100 + 301), null);           // after 5 min: new incident
  assert.equal(c.findMatch(call(a, 'fire'), 120), null);                  // fire is not the same emergency
  c.remove('INC-1');
  assert.equal(c.findMatch(call(a, 'flood'), 120), null);
});
