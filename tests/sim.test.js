import test from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue } from '../shared/sim/EventQueue.js';
import { SimClock } from '../shared/sim/simClock.js';
import { buildTrip, positionAt, segmentIndex, partialToNextJunction, nextJunction } from '../shared/sim/trip.js';
import { dijkstra } from '../shared/graph/dijkstra.js';
import { haversineM } from '../shared/spatial/haversine.js';
import { randomGraph, rng } from './helpers.js';

test('EventQueue pops in time order, FIFO on equal times (vs a stable sort) on 500 random events', () => {
  const r = rng(1);
  const q = new EventQueue();
  const all = Array.from({ length: 500 }, (_, i) => ({ time: Math.floor(r() * 50), type: 'X', n: i }));
  all.forEach((e) => q.push(e.time, e));
  const want = [...all].sort((a, b) => a.time - b.time || a.n - b.n).map((e) => e.n);
  const got = [];
  while (!q.isEmpty()) got.push(q.pop().n);
  assert.deepEqual(got, want);
});

test('EventQueue.popDue returns only events at or before now', () => {
  const q = new EventQueue();
  [5, 1, 9, 3].forEach((t) => q.push(t, { type: 'E' }));
  assert.deepEqual(q.popDue(4).map((e) => e.time), [1, 3]);
  assert.equal(q.size, 2);
  assert.throws(() => q.push(NaN, { type: 'bad' }));
});

test('SimClock advances speed x real time and rejects bad speeds', () => {
  const c = new SimClock({ speed: 5 });
  c.tick(1000);
  assert.equal(c.nowS, 5);
  c.setSpeed(1); c.tick(500);
  assert.equal(c.nowS, 5.5);
  assert.throws(() => c.setSpeed(0));
});

test('trip: duration = route cost, passes every junction at its cumulative cost, positions stay on the route', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const g = randomGraph(seed, 30, 70, { closures: false });
    const route = dijkstra(g, 'v0', 'v9');
    if (!route.reachable || route.roadCount === 0) continue;
    const trip = buildTrip(g, route, 100);
    assert.ok(Math.abs(trip.endS - 100 - route.totalCost) < 1e-6);
    let acc = 100;
    trip.marks.slice(1).forEach((m, k) => {
      acc += g.roadCost(g.getRoad(route.roadIds[k]));
      assert.ok(Math.abs(m.time - acc) < 1e-6);
      const p = positionAt(trip, m.time), loc = g.getLocation(m.nodeId);
      assert.ok(haversineM(p.lat, p.lng, loc.lat, loc.lng) < 0.01);
    });
    for (let i = 1; i < trip.times.length; i++) assert.ok(trip.times[i] >= trip.times[i - 1]);
  }
});

test('trip.segmentIndex (binary search) equals a linear scan for random times', () => {
  const g = randomGraph(3, 60, 140, { closures: false });
  const route = dijkstra(g, 'v1', 'v50');
  const trip = buildTrip(g, route, 0);
  const r = rng(9);
  for (let k = 0; k < 500; k++) {
    const t = (r() * 1.2 - 0.1) * trip.endS;
    let lin = 0;
    for (let i = 0; i < trip.times.length; i++) if (trip.times[i] <= t) lin = i;
    assert.equal(segmentIndex(trip, t), Math.min(lin, trip.times.length - 1));
  }
});

test('partialToNextJunction: prefix starts at the current position and ends at the next junction', () => {
  const g = randomGraph(4, 40, 100, { closures: false });
  const route = dijkstra(g, 'v0', 'v30');
  const trip = buildTrip(g, route, 0);
  const t = trip.endS * 0.37;
  const { junction, prefix } = partialToNextJunction(trip, t);
  assert.equal(junction, nextJunction(trip, t));
  assert.ok(junction.time >= t);
  const p = positionAt(trip, t);
  assert.deepEqual(prefix.points[0], [p.lat, p.lng]);
  assert.equal(prefix.times.at(-1), junction.time);
  // a new trip built from the junction continues seamlessly
  const next = buildTrip(g, dijkstra(g, junction.nodeId, 'v1'), junction.time, prefix);
  assert.equal(next.startS, t);
});
