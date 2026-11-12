// Load test (Phase 7): N simulated phones send SOS over Socket.IO from random road points.
//   node scripts/sos-bots.mjs [url] [N=100] [--seconds=20] [--wait=90] [--speed=30]
// Start the server first (ideally with TOMTOM_DISABLED=1). The script resets the simulation as a
// dispatcher, sets the sim speed, then each phone (its own connection) sends one SOS at a random moment in
// the first --seconds. 30 % of the phones call about one of 10 "hotspots" (several people reporting the
// same emergency) to exercise SOS clustering. Reports: incidents created, merge ratio, assignment latency
// (wall clock, p50/p95, until the incident has a unit) and response time (simulated, SOS -> unit on scene).
// Results are printed and written to server/data/sos-bots-result.json.
import fs from 'node:fs';
import path from 'node:path';
import { io } from 'socket.io-client';
import { mulberry32 } from '../shared/sim/random.js';

const args = process.argv.slice(2);
const RESULT_FILE = path.join(process.cwd(), 'server', 'data', 'sos-bots-result.json');

// Writes the result table between <!-- SOSBOTS:START --> and <!-- SOSBOTS:END --> in README.md.
function updateReadme(s) {
  const md = `<!-- SOSBOTS:START -->
Run on ${s.generatedAt.slice(0, 10)}: \`node scripts/sos-bots.mjs ${s.phones}\` (calls spread over ${s.spreadS} s, sim speed ${s.simSpeed}×, observed for ${s.waitS} s).

| Calls sent / accepted | Incidents created | Merged by clustering | Ack latency p50 / p95 | Assigned immediately | Assignment latency p50 / p95 (all) | Response time (SOS → on scene) |
|---|---|---|---|---|---|---|
| ${s.sent} / ${s.accepted} | ${s.incidentsCreated} | ${s.mergedCalls} calls (${s.mergeRatio}%; ${s.hotspotCalls} hotspot calls) | ${s.ackMs.p50} / ${s.ackMs.p95} ms | ${s.assignment.immediately} (p50 ${s.assignment.immediateP50Ms} ms, p95 ${s.assignment.immediateP95Ms} ms) | ${s.assignment.p50Ms} ms / ${(s.assignment.p95Ms / 1000).toFixed(1)} s | avg ${s.response.avgSimS} sim-s, p95 ${s.response.p95SimS} sim-s (${s.response.incidentsArrived} incidents arrived) |

Incidents that found a free unit were assigned in tens of milliseconds. ${s.accepted - s.assignment.immediately} calls had to wait in the priority queue until a unit came free (57 units for ${s.incidentsCreated} incidents), which is what the long p95 shows; ${s.assignment.neverWithinWait} were still waiting at the end.
<!-- SOSBOTS:END -->`;
  const f = path.join(process.cwd(), 'README.md');
  const t = fs.readFileSync(f, 'utf8');
  if (t.includes('<!-- SOSBOTS:START -->')) fs.writeFileSync(f, t.replace(/<!-- SOSBOTS:START -->[\s\S]*<!-- SOSBOTS:END -->/, md));
}

if (args.includes('--readme-only')) {
  updateReadme(JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')));
  console.log('README load-test section updated from', RESULT_FILE);
  process.exit(0);
}
const URL = args.find((a) => a.startsWith('http')) ?? 'http://localhost:3001';
const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 100);
const opt = (k, d) => Number(args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
const SPREAD_S = opt('seconds', 20), WAIT_S = opt('wait', 90), SPEED = opt('speed', 30), SEED = 7;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const connect = () => new Promise((resolve, reject) => {
  const s = io(URL, { transports: ['websocket'], reconnection: false, timeout: 10000 });
  s.on('connect', () => resolve(s)); s.on('connect_error', reject);
});

// ---- dispatcher: reset, speed, observe ----
const desk = await connect();
const incidents = new Map();
desk.on('incident:updated', (i) => incidents.set(i.id, i));
desk.emit('dispatch:join');
await sleep(800);
desk.emit('sim:reset');
await fetch(`${URL}/api/roads/reset`, { method: 'POST' });
await sleep(800);
incidents.clear();
desk.emit('sim:speed', { speed: SPEED });

// ---- phones: seeded random road points (+ hotspots) ----
const geom = await (await fetch(`${URL}/api/geometry/roads`)).json();
const r = mulberry32(SEED);
const roadPoint = () => { const line = geom.lines[Math.floor(r() * geom.lines.length)]; return line[Math.floor(line.length / 2)]; };
const hotspots = Array.from({ length: 10 }, roadPoint);
const TYPES = ['medical', 'medical', 'fire', 'flood'];
const plan = Array.from({ length: N }, (_, i) => {
  const hot = r() < 0.3;
  const [lat, lng] = hot ? hotspots[Math.floor(r() * hotspots.length)] : roadPoint();
  const jitter = hot ? 40 / 111195 : 0;                         // within ~40 m of the hotspot
  return {
    i, hot, at: r() * SPREAD_S * 1000, type: hot ? 'medical' : TYPES[Math.floor(r() * TYPES.length)],
    severity: ['LOW', 'MEDIUM', 'HIGH'][Math.floor(r() * 3)], people: 1 + Math.floor(r() * 5),
    lat: lat + (r() - 0.5) * jitter, lng: lng + (r() - 0.5) * jitter,
  };
});

const results = [];
const t0 = Date.now();
await Promise.all(plan.map(async (p) => {
  await sleep(p.at);
  let s;
  try { s = await connect(); } catch { results.push({ ...p, error: 'connect' }); return; }
  const sent = Date.now();
  const res = await new Promise((resolve) => s.timeout(15000).emit('sos:new', { lat: p.lat, lng: p.lng, type: p.type, severity: p.severity, people: p.people, clientId: `bot-${p.i}` }, (e, x) => resolve(e ? { ok: false, error: 'timeout' } : x)));
  const rec = { ...p, ackMs: Date.now() - sent, ok: res.ok, error: res.error, merged: Boolean(res.merged), incidentId: res.incident?.id };
  if (res.ok && res.incident.unitId) rec.assignMs = rec.ackMs;
  else if (res.ok) {                                          // queued: wait for a unit (this phone joined its incident room)
    rec.assignMs = await new Promise((resolve) => {
      const done = setTimeout(() => resolve(null), WAIT_S * 1000);
      s.on('incident:updated', (i) => { if (i.id === res.incident.id && i.unitId) { clearTimeout(done); resolve(Date.now() - sent); } });
    });
  }
  results.push(rec);
  s.close();
}));
const sendPhaseS = (Date.now() - t0) / 1000;

// let units arrive, then read response times from the dispatcher's view
await sleep(Math.max(0, WAIT_S * 1000 - (Date.now() - t0)));
const ok = results.filter((x) => x.ok);
const created = new Set(ok.map((x) => x.incidentId));
const incs = [...created].map((id) => incidents.get(id)).filter(Boolean);
const arrived = incs.filter((i) => i.responseS != null);
const assignLat = ok.filter((x) => x.assignMs != null).map((x) => x.assignMs);
const immediate = ok.filter((x) => x.assignMs === x.ackMs).map((x) => x.assignMs);
const summary = {
  generatedAt: new Date().toISOString(), url: URL, phones: N, spreadS: SPREAD_S, simSpeed: SPEED, waitS: WAIT_S,
  sent: results.length, accepted: ok.length, rejected: results.filter((x) => !x.ok).length,
  incidentsCreated: created.size, mergedCalls: ok.filter((x) => x.merged).length,
  mergeRatio: Math.round((1000 * ok.filter((x) => x.merged).length) / Math.max(1, ok.length)) / 10,
  hotspotCalls: plan.filter((p) => p.hot).length,
  ackMs: { p50: pct(ok.map((x) => x.ackMs), 0.5), p95: pct(ok.map((x) => x.ackMs), 0.95) },
  assignment: {
    assigned: assignLat.length, immediately: immediate.length, neverWithinWait: ok.length - assignLat.length,
    p50Ms: pct(assignLat, 0.5), p95Ms: pct(assignLat, 0.95), immediateP50Ms: pct(immediate, 0.5), immediateP95Ms: pct(immediate, 0.95),
  },
  response: {
    incidentsArrived: arrived.length, avgSimS: arrived.length ? Math.round(arrived.reduce((s2, i) => s2 + i.responseS, 0) / arrived.length) : null,
    p95SimS: arrived.length ? Math.round(pct(arrived.map((i) => i.responseS), 0.95)) : null,
  },
  sendPhaseS: Math.round(sendPhaseS * 10) / 10,
};
fs.writeFileSync(RESULT_FILE, JSON.stringify(summary, null, 1));
updateReadme(summary);
console.log(JSON.stringify(summary, null, 1));
desk.emit('sim:speed', { speed: 1 });
desk.emit('sim:reset');
await sleep(300);
process.exit(0);
