// End-to-end Phase 4 check against a running server: traffic refresh (uses ~60 TomTom calls if a key is
// configured), live/free-flow toggle, call counter, and one OSRM comparison.
//   node scripts/e2e-traffic.mjs [url] [--no-refresh]
import { io } from 'socket.io-client';

const URL = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:3001';
const noRefresh = process.argv.includes('--no-refresh');
const s = io(URL, { transports: ['websocket'] });
const ack = (ev, p, ms = 120000) => new Promise((res) => s.timeout(ms).emit(ev, p, (e, r) => res(e ? { ok: false, error: String(e) } : r)));
const get = async (path) => (await fetch(URL + path)).json();

await new Promise((r) => s.on('connect', r));
let traffic = null, calls = null;
s.on('traffic:updated', (t) => { traffic = t; });
s.on('external:calls', (c) => { calls = c; });
s.emit('dispatch:join');
await new Promise((r) => setTimeout(r, 1500));
console.log('traffic on join:', traffic?.message, '| key:', traffic?.hasKey, '| TomTom calls today:', calls?.tomtom?.calls);

if (!noRefresh) {
  const t0 = Date.now();
  const r = await ack('traffic:refresh', {});
  console.log(`refresh (${((Date.now() - t0) / 1000).toFixed(1)} s):`, JSON.stringify(r));
  await new Promise((res) => setTimeout(res, 300));
  console.log('status:', traffic?.message, `| samples ${traffic?.fetchedSamples}/${traffic?.samples}, roads ${traffic?.matchedRoads}`, '| calls today:', calls?.tomtom?.calls);
}
const roads = await get('/api/traffic');
const f = roads.roads.map((x) => x.factor);
if (f.length) console.log(`coloured roads: ${f.length}; factor min ${Math.min(...f)} max ${Math.max(...f)}; green ${f.filter((x) => x < 1.25).length}, orange ${f.filter((x) => x >= 1.25 && x < 2).length}, red ${f.filter((x) => x >= 2).length}`);

const q = 'fromLat=18.5196&fromLng=73.8553&toLat=18.5074&toLng=73.8077';     // Shaniwar Wada -> Kothrud
const live = await get(`/api/compare?${q}`);
console.log(`ours (${live.ours.trafficMode}): ${live.ours.etaS.toFixed(0)} s, ${Math.round(live.ours.lengthM)} m | OSRM: ${live.osrm.available ? `${live.osrm.durationS.toFixed(0)} s, ${Math.round(live.osrm.distanceM)} m, diff ${live.diffPct.toFixed(1)}%` : `unavailable (${live.osrm.reason})`}`);
if (traffic?.snapshotAt) {
  await ack('traffic:mode', { mode: 'free-flow' });
  const ff = await get(`/api/compare?${q}`);
  console.log(`ours (free-flow): ${ff.ours.etaS.toFixed(0)} s | OSRM ${ff.osrm.cached ? 'served from cache' : 'fetched again'}`);
  await ack('traffic:mode', { mode: 'live' });
}
console.log('external calls:', JSON.stringify(calls));
process.exit(0);
