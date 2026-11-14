// External services failing (TomTom, Open-Meteo): the socket handlers never reject, the dashboard is told
// "Refresh failed — keeping last data", the last data is kept, and a real server keeps running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { REFRESH_FAILED, trafficRefresh, glofasRefresh, compareRoutes } from '../server/externalHandlers.js';
import { TrafficService } from '../server/services/trafficService.js';
import { FloodService } from '../server/services/floodService.js';
import { ExternalCalls } from '../server/services/externalCalls.js';
import { hasPuneData, loadPune, ROOT } from './helpers.js';

const skip = !hasPuneData && 'Pune graph not generated';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ext-fail-'));
const quietLog = () => { const errors = []; return { errors, error: (...a) => errors.push(a) }; };
const boom = () => { throw new Error('boom'); };

// Fails the test if anything escapes as an unhandled rejection while fn runs.
async function noUnhandledRejection(fn) {
  const seen = [];
  const on = (e) => seen.push(e);
  process.on('unhandledRejection', on);
  try { return await fn(); } finally {
    await new Promise((r) => setImmediate(r));
    process.off('unhandledRejection', on);
    assert.deepEqual(seen, [], 'no unhandled rejection');
  }
}

// ---------- handlers with throwing services ----------
test('traffic:refresh: a throwing TomTom refresh is logged and acked "Refresh failed — keeping last data"', async () => {
  const log = quietLog();
  const sent = [];
  const traffic = { status: () => ({ mode: 'live', snapshotAt: 'T0' }), refresh: async () => { throw new TypeError('socket hang up'); } };
  const ack = await noUnhandledRejection(() => trafficRefresh({ traffic, toDispatch: (ev, p) => sent.push([ev, p]), log }, {}));
  assert.equal(ack.ok, false);
  assert.equal(ack.message, REFRESH_FAILED);
  assert.equal(log.errors.length, 1);
  assert.deepEqual(sent.at(-1), ['traffic:updated', { mode: 'live', snapshotAt: 'T0' }], 'dashboard gets the (unchanged) status');
  // even status() / the broadcast throwing must not reject
  const ack2 = await noUnhandledRejection(() => trafficRefresh({ traffic: { status: boom, refresh: boom }, toDispatch: boom, log }, {}));
  assert.equal(ack2.message, REFRESH_FAILED);
});

test('traffic:refresh: service-reported failures get the same message; TOO_SOON is passed through', async () => {
  const mk = (res) => ({ status: () => ({}), refresh: async () => res });
  const ack = await trafficRefresh({ traffic: mk({ ok: false, reason: 'FETCH_FAILED', message: 'TomTom unreachable. Keeping the last snapshot.' }), toDispatch: () => {}, log: quietLog() });
  assert.ok(ack.message.startsWith(REFRESH_FAILED), ack.message);
  assert.equal(ack.reason, 'FETCH_FAILED');
  const soon = await trafficRefresh({ traffic: mk({ ok: false, reason: 'TOO_SOON', message: 'x' }), toDispatch: () => {}, log: quietLog() });
  assert.equal(soon.message, 'x');
});

test('flood:glofas: a throwing Open-Meteo refresh or suggestion is logged and acked as failed; flood:updated still sent', async () => {
  for (const flood of [
    { refreshGlofas: async () => { throw new Error('ECONNRESET'); }, applyGlofasSuggestion: () => {} },
    { refreshGlofas: async () => ({ ok: true, suggestedLevel: 4 }), applyGlofasSuggestion: boom },
  ]) {
    const log = quietLog();
    let changed = 0;
    const ack = await noUnhandledRejection(() => glofasRefresh({ flood, now: () => 0, floodChanged: () => { changed++; }, log }, { apply: true }));
    assert.equal(ack.ok, false);
    assert.equal(ack.error, REFRESH_FAILED);
    assert.equal(log.errors.length, 1);
    assert.equal(changed, 1);
  }
});

test('GET /api/compare (OSRM): a throwing comparison becomes a JSON error, not a rejection', async () => {
  const log = quietLog();
  const [status, body] = await noUnhandledRejection(() => compareRoutes({ compare: { compare: async () => { throw new Error('no junction near the point'); } }, log }, {}, {}));
  assert.equal(status, 400);
  assert.equal(body.error, 'no junction near the point');
  assert.equal(log.errors.length, 1);
});

// ---------- real services ----------
test('TrafficService: an error while applying a fresh TomTom snapshot restores the previous one (last data kept)', { skip }, async () => {
  const store = await loadPune();
  const g = store.graph;
  const dir = tmp();
  const calls = new ExternalCalls({ file: path.join(dir, 'calls.json') });
  const probe = new TrafficService({ store, calls });
  const fetchImpl = async (url) => {
    const [lat, lng] = new URL(url).searchParams.get('point').split(',').map(Number);
    const s = probe.samples.find((x) => x.lat === lat && x.lng === lng);
    const road = g.getRoad(s.roadId);
    return { ok: true, status: 200, json: async () => ({ flowSegmentData: { currentSpeed: 10, freeFlowSpeed: 50, coordinates: { coordinate: g.roadGeometry(road.id, road.from).map(([la, ln]) => ({ latitude: la, longitude: ln })) } } }) };
  };
  const svc = new TrafficService({ store, apiKey: 'k', snapshotFile: path.join(dir, 'snap.json'), calls, fetchImpl, spacingMs: 0 });
  const old = { fetchedAt: '2026-11-01T00:00:00.000Z', samples: [{ id: 'S1', ok: true, currentSpeed: 25, freeFlowSpeed: 50, roadIds: [probe.samples[0].roadId] }] };
  svc.applySnapshot(old, 'disk');
  const factors = () => [...g.roads.values()].filter((r) => r.trafficFactor !== 1).map((r) => [r.id, r.trafficFactor]);
  const before = factors();
  const real = g.setTrafficFactor;
  let n = 0;
  // fails once, part-way through applying the new snapshot
  g.setTrafficFactor = function (id, f) { if (f !== 1 && ++n === 6) throw new Error('graph write failed'); return real.call(this, id, f); };
  try {
    const log = quietLog();
    const ack = await noUnhandledRejection(() => trafficRefresh({ traffic: svc, toDispatch: () => {}, log }, { force: true }));
    assert.equal(ack.message, REFRESH_FAILED);
  } finally { g.setTrafficFactor = real; }
  assert.equal(svc.snapshot, old, 'previous snapshot kept');
  assert.deepEqual(factors(), before, 'previous traffic factors re-applied');
  assert.equal(fs.existsSync(path.join(dir, 'snap.json')), false, 'the half-applied snapshot was not saved');
  assert.equal(svc.refreshing, null);
  for (const r of g.roads.values()) if (r.trafficFactor !== 1) g.setTrafficFactor(r.id, 1);
});

test('FloodService: a throwing Open-Meteo fetch keeps the last GloFAS result and loads the baseline when there is no runtime copy', { skip }, async () => {
  const store = await loadPune();
  const dir = tmp();
  const baseline = path.join(dir, 'flood-current.baseline.json');
  fs.writeFileSync(baseline, JSON.stringify({ ok: true, fetchedAt: '2026-11-01T00:00:00.000Z', status: 'normal', suggestedLevel: 0, peak: { m3s: 9 } }));
  const flood = new FloodService({
    store, elevation: null, rivers: [], historyFile: path.join(dir, 'h.json'), currentFile: path.join(dir, 'flood-current.json'),
    currentBaselineFile: baseline, fetchImpl: () => { throw new TypeError('fetch failed'); },
  });
  assert.equal(flood.glofas.fetchedAt, '2026-11-01T00:00:00.000Z', 'baseline loaded');
  const ack = await noUnhandledRejection(() => glofasRefresh({ flood, now: () => 0, floodChanged: () => {}, log: quietLog() }, { apply: true }));
  assert.equal(ack.ok, false);
  assert.ok(ack.error.startsWith(REFRESH_FAILED), ack.error);
  assert.equal(flood.glofas.peak.m3s, 9, 'last data kept');
  assert.equal(fs.existsSync(path.join(dir, 'flood-current.json')), false, 'nothing written on failure');
});

// ---------- the real server ----------
// Boots server/index.js against a mock where TomTom resets every connection and Open-Meteo answers garbage.
// Runtime files go to a temp dir (this machine's snapshots and TomTom call counter are untouched).
test('real server: failing TomTom and Open-Meteo refreshes are acked as failed and the server keeps running', { skip, timeout: 180_000 }, async () => {
  const hits = { tomtom: 0, flood: 0 };
  const mock = http.createServer((req, res) => {
    if (req.url.startsWith('/tomtom')) { hits.tomtom++; req.socket.destroy(); return; }
    hits.flood++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{not json');
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const dir = tmp();
  const port = 3900 + Math.floor(Math.random() * 90);
  const env = {
    ...process.env, PORT: String(port), RUNTIME_DATA_DIR: dir, LOG_DIR: path.join(dir, 'logs'),
    TOMTOM_API_KEY: 'test-key', TOMTOM_FLOW_URL: `${mockUrl}/tomtom`, OPEN_METEO_FLOOD_URL: `${mockUrl}/flood`,
  };
  delete env.TOMTOM_DISABLED;
  const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  let exited = null;
  server.on('exit', (code) => { exited = code; });
  let socket;
  try {
    await new Promise((resolve, reject) => {
      const t = setInterval(() => {
        if (out.includes('Server on')) { clearInterval(t); resolve(); }
        if (exited !== null) { clearInterval(t); reject(new Error(`server exited (${exited}):\n${out}`)); }
      }, 100);
    });
    const base = `http://127.0.0.1:${port}`;
    const before = await (await fetch(`${base}/api/summary`)).json();
    assert.ok(before.traffic.snapshotAt, 'no runtime copy: the committed baseline snapshot is loaded');

    socket = io(base, { transports: ['websocket'] });
    await new Promise((r) => socket.on('connect', r));
    socket.emit('dispatch:join');
    const ack = (ev, msg) => socket.timeout(120_000).emitWithAck(ev, msg);
    const [traffic, glofas] = await Promise.all([ack('traffic:refresh', { force: true }), ack('flood:glofas', { apply: true })]);

    assert.equal(traffic.ok, false);
    assert.ok(traffic.message.startsWith(REFRESH_FAILED), traffic.message);
    assert.equal(glofas.ok, false);
    assert.ok(glofas.error.startsWith(REFRESH_FAILED), glofas.error);
    assert.ok(hits.tomtom > 0 && hits.flood > 0, `mock was called: ${JSON.stringify(hits)}`);

    const after = await (await fetch(`${base}/api/summary`)).json();
    assert.equal(exited, null, `server still running:\n${out}`);
    assert.equal(after.traffic.snapshotAt, before.traffic.snapshotAt, 'last traffic data kept');
    assert.ok(!/Unhandled promise rejection/.test(out), out);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /snapshot|flood-current/.test(f)), [], 'failed refreshes write nothing');
  } finally {
    socket?.close();
    server.kill();
    mock.close();
    if (exited === null) await new Promise((r) => server.once('exit', r));
  }
});
