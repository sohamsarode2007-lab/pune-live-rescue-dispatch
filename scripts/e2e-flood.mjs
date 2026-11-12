// End-to-end Phase 5 check against a running server (start it with TOMTOM_DISABLED=1 to avoid TomTom calls):
// flood rise -> closures, reroutes, crossing ranking and trap zones update; crowd reports; recede.
//   node scripts/e2e-flood.mjs [url]
import { io } from 'socket.io-client';

const URL = process.argv[2] ?? 'http://localhost:3001';
const connect = () => new Promise((r) => { const s = io(URL, { transports: ['websocket'] }); s.on('connect', () => r(s)); });
const ack = (s, ev, p, ms = 15000) => new Promise((res) => s.timeout(ms).emit(ev, p, (e, r) => res(e ? { ok: false, error: String(e) } : r)));
const get = async (p) => (await fetch(URL + p)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const desk = await connect();
let flood = null, network = null;
const reroutes = [];
desk.on('flood:updated', (f) => { flood = f; });
desk.on('network:updated', (n) => { network = n; });
desk.on('unit:rerouted', (r) => reroutes.push(r));
desk.emit('dispatch:join');
await sleep(800);
desk.emit('sim:reset');
await post('/api/roads/reset');
await sleep(500);

const before = await get('/api/network/crossings');
console.log('crossings before:', before.ranking.slice(0, 3).map((c) => `${c.rank}. ${c.name} +${c.fire.avgIncreaseS}s`).join(' | '), `| baseline fire avg ${before.baseline.fire.avgS}s`);

// incidents on both banks, so units cross the river
for (const [lat, lng, type] of [[18.5074, 73.8077, 'fire'], [18.5308, 73.8475, 'medical'], [18.5300, 73.8700, 'flood'], [18.5100, 73.8600, 'fire']]) {
  const s = await connect();
  const r = await ack(s, 'sos:new', { lat, lng, type, severity: 'HIGH', people: 3 });
  console.log(`  ${r.incident.id} ${type}: ${r.incident.status} ${r.incident.unitId ?? ''}`);
  s.close();
}
// Rerouting on the live server: close a road in the middle of INC-001's unit route (same code path the
// flood uses), expect a unit:rerouted event and a new ETA.
{
  const state = await get('/api/state');
  const inc = state.incidents.find((i) => i.id === 'INC-001');
  const route = await get(`/api/route?fromLat=${inc.fromLat}&fromLng=${inc.fromLng}&toLat=${inc.lat}&toLng=${inc.lng}&algo=astar`);
  const ids = route.results.astar.roadIds;
  const mid = ids[Math.floor(ids.length * 0.7)];
  const n0 = reroutes.length;
  await fetch(`${URL}/api/roads/${mid}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'BLOCKED' }) });
  await sleep(500);
  const ev = reroutes.slice(n0).find((r) => r.unitId === inc.unitId);
  console.log(`closed ${mid} on ${inc.unitId}'s route -> ${ev ? `${ev.outcome}, ETA ${ev.extraS >= 0 ? '+' : ''}${ev.extraS} s` : 'NO REROUTE EVENT'}`);
}

desk.emit('sim:speed', { speed: 30 });
const set = await ack(desk, 'flood:set', { level: 10 });
console.log(`flood set to 10 m: ${set.status.predictedFlooded} junctions predicted, spreading over ${Math.round(set.status.spreadS / 60)} sim-min`);
for (let i = 0; i < 6; i++) {
  await sleep(5000);
  console.log(`  t+${(i + 1) * 5}s real: flooded ${flood.floodedNow}/${flood.predictedFlooded}, blocked ${flood.blockedRoads}, high-risk ${flood.highRiskRoads}, reroutes so far ${reroutes.length}, trap zones ${network?.trapZones?.length ?? 0}`);
}
await sleep(3000);
const after = await get('/api/network/crossings');
console.log('crossings after flood:', after.ranking.map((c) => `${c.name}${c.closed ? ' (CLOSED)' : ` +${c.fire.avgIncreaseS}s`}`).join(' | '));
console.log(`baseline fire avg ${before.baseline.fire.avgS}s -> ${after.baseline.fire.avgS}s, worst ${before.baseline.fire.worstS}s -> ${after.baseline.fire.worstS}s`);
console.log('reroute outcomes:', JSON.stringify(reroutes.reduce((a, r) => ((a[r.outcome] = (a[r.outcome] ?? 0) + 1), a), {})));
if (network?.trapZones?.length) console.log('trap zones:', network.trapZones.slice(0, 4).map((z) => `${z.id} ${z.kind} ${z.junctions}j`).join(', '));

// three phones report the same road
const p = { lat: 18.5167, lng: 73.8414 };
for (const c of ['phone-a', 'phone-b', 'phone-c']) {
  const s = await connect();
  const r = await ack(s, 'road:report', { ...p, clientId: c });
  console.log(`  ${c}: ${r.ok ? `${r.name} ${r.count}/${r.needed}${r.newlyBlocked ? ' -> CLOSED' : ''}` : r.error}`);
  s.close();
}

const rec = await ack(desk, 'flood:set', { level: 0 });
await sleep(1500);
console.log(`receded: level ${rec.status.level}, flood-blocked roads now ${flood.blockedRoads}, high-risk ${flood.highRiskRoads}`);
desk.emit('sim:speed', { speed: 1 });
desk.emit('sim:reset');
await post('/api/roads/reset');
process.exit(0);

async function post(path) { return (await fetch(URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json(); }
