// Live traffic (Phase 4) against a fake TomTom server: no network, no key needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrafficService, trafficFactorFrom, SAMPLE_HIGHWAYS } from '../server/services/trafficService.js';
import { ExternalCalls } from '../server/services/externalCalls.js';
import { astar } from '../shared/graph/astar.js';
import { dijkstra } from '../shared/graph/dijkstra.js';
import { haversineM } from '../shared/spatial/haversine.js';
import { hasPuneData, loadPune, rng } from './helpers.js';

const skip = !hasPuneData && 'Pune graph not generated';
const KEY = 'test-key-SECRET';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-'));

// Fake TomTom flowSegmentData: the segment shape is our sampled road's shape; speeds vary by sample so
// factors cover < 1 (clamped up), normal, > 4 (clamped down), a closure and a stopped road.
function fakeTomTom(store, samples, { fail = false } = {}) {
  const log = [];
  const fetchImpl = async (url) => {
    log.push(url);
    if (fail === 'throw') throw new Error('ECONNREFUSED');
    if (fail) return { ok: false, status: 503, json: async () => ({}) };
    const q = new URL(url).searchParams;
    const [lat, lng] = q.get('point').split(',').map(Number);
    const i = samples.findIndex((s) => s.lat === lat && s.lng === lng);
    const s = samples[i];
    const road = store.graph.getRoad(s.roadId);
    const free = 50;
    const current = [60, 40, 25, 12.5, 5, 0][i % 6];        // factors 0.83->1, 1.25, 2, 4, 10->4, stopped->4
    return {
      ok: true, status: 200,
      json: async () => ({ flowSegmentData: {
        frc: 'FRC2', currentSpeed: current, freeFlowSpeed: free, confidence: 0.9, roadClosure: i === 7,
        coordinates: { coordinate: store.graph.roadGeometry(road.id, road.from).map(([la, ln]) => ({ latitude: la, longitude: ln })) },
      } }),
    };
  };
  return { fetchImpl, log };
}

function makeService(store, opts = {}) {
  const dir = opts.dir ?? tmp();
  const calls = opts.calls ?? new ExternalCalls({ file: path.join(dir, 'calls.json'), caps: { tomtom: opts.cap ?? 200 }, now: opts.now });
  const probe = new TrafficService({ store, apiKey: '', calls });                  // only to know the sample points
  const fake = fakeTomTom(store, probe.samples, opts);
  const svc = new TrafficService({
    store, apiKey: opts.key ?? KEY, snapshotFile: path.join(dir, 'snap.json'), calls, fetchImpl: fake.fetchImpl, spacingMs: 0, now: opts.now,
  });
  return { svc, calls, fake, dir };
}

const resetFactors = (graph) => { for (const r of graph.roads.values()) if (r.trafficFactor !== 1) graph.setTrafficFactor(r.id, 1); };

test('trafficFactor = freeFlow / current, clamped to [1, 4]; closure or stopped road = 4', () => {
  assert.equal(trafficFactorFrom({ currentSpeed: 25, freeFlowSpeed: 50 }), 2);
  assert.equal(trafficFactorFrom({ currentSpeed: 60, freeFlowSpeed: 50 }), 1);     // faster than free flow: 1
  assert.equal(trafficFactorFrom({ currentSpeed: 5, freeFlowSpeed: 50 }), 4);      // 10 -> 4
  assert.equal(trafficFactorFrom({ currentSpeed: 0, freeFlowSpeed: 50 }), 4);
  assert.equal(trafficFactorFrom({ currentSpeed: 40, freeFlowSpeed: 50, roadClosure: true }), 4);
});

test('sample points: about 60, on trunk/primary/secondary roads, at least 450 m apart, deterministic', { skip }, async () => {
  const store = await loadPune();
  const a = new TrafficService({ store, calls: new ExternalCalls() });
  const b = new TrafficService({ store, calls: new ExternalCalls() });
  assert.ok(a.samples.length >= 50 && a.samples.length <= 60, `${a.samples.length} samples`);
  assert.deepEqual(a.samples, b.samples);
  for (const s of a.samples) assert.ok(SAMPLE_HIGHWAYS.has(store.graph.getRoad(s.roadId).highway));
  for (let i = 0; i < a.samples.length; i++) for (let j = i + 1; j < a.samples.length; j++) {
    assert.ok(haversineM(a.samples[i].lat, a.samples[i].lng, a.samples[j].lat, a.samples[j].lng) >= 450);
  }
});

test('no key: nothing is fetched, traffic stays free-flow and says so', { skip }, async () => {
  const store = await loadPune();
  const { svc, fake } = makeService(store, { key: '' });
  const r = await svc.refresh();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NO_KEY');
  assert.equal(fake.log.length, 0);
  assert.equal(svc.status().mode, 'free-flow');
  assert.match(svc.status().message, /unavailable/);
  assert.ok([...store.graph.roads.values()].every((x) => x.trafficFactor === 1));
});

test('refresh: factors applied to matched roads (clamped), snapshot saved, reloaded on startup for offline use', { skip }, async () => {
  const store = await loadPune();
  const { svc, fake, dir, calls } = makeService(store);
  try {
    const r = await svc.refresh();
    assert.equal(r.ok, true);
    assert.equal(r.fetched, svc.samples.length);
    assert.equal(calls.count('tomtom'), svc.samples.length);
    const sampled = new Set(svc.snapshot.samples.flatMap((s) => s.roadIds));
    for (const road of store.graph.roads.values()) {
      assert.ok(road.trafficFactor >= 1 && road.trafficFactor <= 4);
      if (road.trafficFactor !== 1) assert.ok(sampled.has(road.id), `${road.id} changed without a sample`);
    }
    for (const [i, s] of svc.snapshot.samples.entries()) {
      assert.ok(s.roadIds.includes(s.roadId), `sample ${s.id} matched its own road`);
      const want = [1, 1.25, 2, 4, 4, 4][i % 6];
      assert.ok(store.graph.getRoad(s.roadId).trafficFactor >= want - 1e-9);
    }
    assert.ok(fs.existsSync(path.join(dir, 'snap.json')));
    assert.ok(fake.log.every((u) => u.includes('point=')));

    // A new server start with the same files: no fetch, same factors, labelled as the saved snapshot.
    const before = new Map([...store.graph.roads.values()].map((x) => [x.id, x.trafficFactor]));
    resetFactors(store.graph);
    const again = makeService(store, { dir, calls });
    assert.equal(again.fake.log.length, 0);
    assert.equal(again.svc.status().mode, 'live');
    assert.match(again.svc.status().message, /Traffic as of .*saved snapshot/);
    for (const x of store.graph.roads.values()) assert.equal(x.trafficFactor, before.get(x.id));

    // Toggle: free-flow puts every factor back to 1, live re-applies the snapshot.
    again.svc.setMode('free-flow');
    assert.ok([...store.graph.roads.values()].every((x) => x.trafficFactor === 1));
    again.svc.setMode('live');
    for (const x of store.graph.roads.values()) assert.equal(x.trafficFactor, before.get(x.id));
  } finally {
    resetFactors(store.graph);
  }
});

test('daily cap is enforced in code and persisted; a new UTC day resets it', { skip }, async () => {
  const store = await loadPune();
  let now = Date.parse('2026-11-12T10:00:00Z');
  const { svc, fake, dir } = makeService(store, { cap: 25, now: () => now });
  try {
    const r1 = await svc.refresh();
    assert.equal(fake.log.length, 25, 'stops at the cap');
    assert.equal(r1.capReached, true);
    assert.equal(svc.snapshot.partial, true);
    const r2 = await svc.refresh({ force: true });
    assert.equal(r2.reason, 'DAILY_CAP');
    assert.equal(fake.log.length, 25, 'no request once the cap is reached');
    assert.ok(svc.snapshot, 'the last snapshot is kept');
    const reopened = new ExternalCalls({ file: path.join(dir, 'calls.json'), caps: { tomtom: 25 }, now: () => now });
    assert.equal(reopened.count('tomtom'), 25, 'a restart cannot reset the counter');
    now = Date.parse('2026-11-13T00:00:01Z');
    assert.equal(reopened.remaining('tomtom'), 25, 'new UTC day');
  } finally {
    resetFactors(store.graph);
  }
});

test('manual only: with a key and an old snapshot nothing is fetched until refresh(); a 2nd refresh within 15 min needs force', { skip }, async () => {
  const store = await loadPune();
  let now = Date.parse('2026-11-12T10:00:00Z');
  const { svc, fake, dir, calls } = makeService(store, { now: () => now });
  try {
    await svc.refresh();
    const n = fake.log.length;
    now += 3 * 3600 * 1000;                                     // the snapshot is now 3 hours old
    const restarted = makeService(store, { dir, calls, now: () => now });
    assert.equal(typeof restarted.svc.maybeAutoRefresh, 'undefined', 'there is no automatic refresh path');
    assert.equal(restarted.fake.log.length, 0, 'startup with a key and a stale snapshot makes no TomTom call');
    restarted.svc.status(); restarted.svc.roadsView();
    assert.equal(restarted.fake.log.length, 0);
    now += 60 * 1000;
    const again = await svc.refresh();
    assert.equal(again.ok, true, 'snapshot from 3 h ago: a manual refresh runs');
    const soon = await svc.refresh();
    assert.equal(soon.reason, 'TOO_SOON');
    assert.equal(fake.log.length, n * 2, 'the refused refresh made no call');
  } finally {
    resetFactors(store.graph);
  }
});

test('TomTom failures keep the previous snapshot and never expose the key', { skip }, async () => {
  const store = await loadPune();
  for (const fail of [true, 'throw']) {
    const { svc } = makeService(store, { fail });
    const r = await svc.refresh();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'FETCH_FAILED');
    assert.equal(svc.snapshot, null);
    assert.ok(!JSON.stringify(svc.status()).includes(KEY));
    assert.equal(svc.status().mode, 'free-flow');
    assert.throws(() => svc.setMode('live'), /No traffic snapshot/);
  }
});

test('A* equals Dijkstra on 500 random Pune pairs with a traffic snapshot applied', { skip }, async () => {
  const store = await loadPune();
  const { svc } = makeService(store);
  try {
    await svc.refresh();
    const changed = [...store.graph.roads.values()].filter((x) => x.trafficFactor > 1).length;
    assert.ok(changed >= 40, `${changed} roads slowed by traffic`);   // 5 of every 6 fake samples are slower than free flow
    const ids = [...store.graph.locations.keys()];
    const r = rng(4242);
    let differentRoute = 0;
    for (let i = 0; i < 500; i++) {
      const s = ids[Math.floor(r() * ids.length)], t = ids[Math.floor(r() * ids.length)];
      const a = astar(store.graph, s, t), d = dijkstra(store.graph, s, t);
      assert.ok(Math.abs(a.totalCost - d.totalCost) < 1e-6, `${s}->${t}: ${a.totalCost} vs ${d.totalCost}`);
      if (i < 60) {
        svc.setMode('free-flow');
        if (dijkstra(store.graph, s, t).roadIds.join() !== d.roadIds.join()) differentRoute++;
        svc.setMode('live');
      }
    }
    assert.ok(differentRoute > 0, 'traffic changes some routes');
  } finally {
    resetFactors(store.graph);
  }
});
