// End-to-end check of the one-click "Monsoon flood demo" against a running server: start it as a dispatcher,
// watch flood level, closures, reroutes, coverage and incidents over ~70 s of real time (10x speed).
//   node scripts/e2e-scenario.mjs [url] [seconds]
import { io } from 'socket.io-client';

const URL = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:3001';
const SECONDS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 70);
const s = io(URL, { transports: ['websocket'] });
await new Promise((r) => s.on('connect', r));
let flood = null, coverage = null, scenario = null, calls = null;
const reroutes = [], incidents = new Map();
s.on('flood:updated', (f) => { flood = f; });
s.on('coverage:updated', (c) => { coverage = c; });
s.on('scenario:updated', (x) => { scenario = x; });
s.on('external:calls', (c) => { calls = c; });
s.on('unit:rerouted', (r) => reroutes.push(r));
s.on('incident:updated', (i) => incidents.set(i.id, i));
s.emit('dispatch:join');
await new Promise((r) => setTimeout(r, 1000));
const ack = await new Promise((r) => s.timeout(10000).emit('scenario:start', { id: 'monsoon' }, (e, x) => r(e ? { ok: false } : x)));
console.log('scenario started:', ack.ok, `| TomTom calls today: ${calls?.tomtom?.calls}`);
const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
  await new Promise((r) => setTimeout(r, 10000));
  const st = [...incidents.values()].reduce((a, i) => ((a[i.status] = (a[i.status] ?? 0) + 1), a), {});
  console.log(`t+${Math.round((Date.now() - t0) / 1000)}s: level ${flood?.level} m, flooded ${flood?.floodedNow}, blocked ${flood?.blockedRoads}, `
    + `fire coverage ${coverage?.fire?.pct8}% (amb ${coverage?.ambulance?.pct8}%), calls ${scenario?.callsSent}/${scenario?.calls}, reroutes ${reroutes.length}, incidents ${JSON.stringify(st)}`);
}
console.log('coverage history:', (coverage?.history ?? []).map((h) => `${Math.round(h.simS)}s:${h.fire}%`).join(' '));
console.log('reroute outcomes:', JSON.stringify(reroutes.reduce((a, r) => ((a[r.outcome] = (a[r.outcome] ?? 0) + 1), a), {})));
console.log(`TomTom calls today at the end: ${calls?.tomtom?.calls}`);
process.exit(0);
