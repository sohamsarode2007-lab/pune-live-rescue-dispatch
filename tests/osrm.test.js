// OSRM comparison (Phase 4) against a fake OSRM: rate limit, cache, unreachable server, log.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OsrmService } from '../server/services/osrmService.js';
import { CompareService } from '../server/services/compareService.js';
import { ExternalCalls } from '../server/services/externalCalls.js';
import { hasPuneData, loadPune } from './helpers.js';

const okRoute = (duration = 600) => async () => ({
  ok: true, status: 200,
  json: async () => ({ code: 'Ok', routes: [{ duration, distance: 5000, geometry: { coordinates: [[73.80, 18.50], [73.81, 18.51]] } }] }),
});

test('at most one request per interval, even when requests arrive together', async () => {
  let n = 0;
  const osrm = new OsrmService({ fetchImpl: async (...a) => { n++; return okRoute()(...a); }, minIntervalMs: 250 });
  const pts = [0, 1, 2].map((i) => [{ lat: 18.5 + i / 100, lng: 73.8 }, { lat: 18.52, lng: 73.85 }]);
  await Promise.all(pts.map(([a, b]) => osrm.route(a, b)));
  assert.equal(n, 3);
  const t = osrm.requestTimes;
  for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 245, `gap ${t[i] - t[i - 1]} ms`);
});

test('responses are cached: the same route twice makes one request', async () => {
  let n = 0;
  const calls = new ExternalCalls();
  const osrm = new OsrmService({ calls, fetchImpl: async (...a) => { n++; return okRoute(321)(...a); }, minIntervalMs: 0 });
  const a = await osrm.route({ lat: 18.5, lng: 73.8 }, { lat: 18.51, lng: 73.81 });
  const b = await osrm.route({ lat: 18.5, lng: 73.8 }, { lat: 18.51, lng: 73.81 });
  assert.equal(n, 1);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(b.durationS, 321);
  assert.deepEqual(b.geometry[0], [18.50, 73.80]);       // [lng, lat] from OSRM -> [lat, lng]
  assert.equal(calls.view().osrm.calls, 1);
  assert.equal(calls.view().osrm.cacheHits, 1);
});

test('unreachable, error status or timeout: { available: false, reason } instead of an exception', async () => {
  const p = [{ lat: 18.5, lng: 73.8 }, { lat: 18.51, lng: 73.81 }];
  const down = new OsrmService({ fetchImpl: async () => { throw new Error('ENOTFOUND'); }, minIntervalMs: 0 });
  assert.deepEqual(await down.route(...p), { available: false, reason: 'OSRM server unreachable', cached: false });
  const busy = new OsrmService({ fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }), minIntervalMs: 0 });
  assert.equal((await busy.route(...p)).reason, 'OSRM answered HTTP 429');
  const hang = new OsrmService({
    minIntervalMs: 0, timeoutMs: 100,
    fetchImpl: (_u, { signal }) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  assert.equal((await hang.route(...p)).reason, 'OSRM did not answer in time');
  // a failure is cached briefly, so a broken server is not hammered
  let n = 0;
  const flaky = new OsrmService({ fetchImpl: async () => { n++; throw new Error('x'); }, minIntervalMs: 0 });
  await flaky.route(...p); await flaky.route(...p);
  assert.equal(n, 1);
});

test('compare: same snapped start/end for both, % difference, logged; OSRM down -> ours still shown, nothing logged',
  { skip: !hasPuneData && 'Pune graph not generated' }, async () => {
    const store = await loadPune();
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osrm-')), 'log.jsonl');
    let asked = null;
    const osrm = new OsrmService({ minIntervalMs: 0, fetchImpl: async (url) => { asked = url; return okRoute(500)(); } });
    const cmp = new CompareService({ store, osrm, traffic: null, logFile });
    const r = await cmp.compare({ lat: 18.5074, lng: 73.8077 }, { lat: 18.5308, lng: 73.8475 });
    assert.ok(r.ours.reachable && r.osrm.available);
    assert.ok(asked.includes(`${r.from.lng},${r.from.lat};${r.to.lng},${r.to.lat}`), 'OSRM gets the snapped junctions');
    assert.ok(Math.abs(r.diffPct - ((r.ours.etaS - 500) / 500) * 100) < 1e-9);
    assert.ok(Math.abs(r.ours.freeFlowS - r.ours.drivingS) < 1e-6, 'no traffic applied: driving time = free-flow time');
    assert.equal(r.summary.all.n, 1);
    assert.equal(fs.readFileSync(logFile, 'utf8').trim().split('\n').length, 1);
    assert.equal(new CompareService({ store, osrm, logFile }).summary().all.n, 1, 'log is reloaded');

    const down = new CompareService({ store, osrm: new OsrmService({ minIntervalMs: 0, fetchImpl: async () => { throw new Error('down'); } }), logFile });
    const r2 = await down.compare({ lat: 18.5074, lng: 73.8077 }, { lat: 18.5308, lng: 73.8475 });
    assert.equal(r2.osrm.available, false);
    assert.ok(r2.ours.reachable && r2.ours.geometry.length > 1);
    assert.equal(r2.diffPct, null);
    assert.equal(r2.summary.all.n, 1, 'failed comparison is not logged');
  });
