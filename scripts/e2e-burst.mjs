// End-to-end Phase 3 check against a running server: burst (greedy vs Hungarian) and SOS clustering.
//   node scripts/e2e-burst.mjs [url]
import { io } from 'socket.io-client';

const URL = process.argv[2] ?? 'http://localhost:3001';
const connect = () => new Promise((r) => { const s = io(URL, { transports: ['websocket'] }); s.on('connect', () => r(s)); });
const ack = (s, ev, p) => new Promise((res) => s.timeout(10000).emit(ev, p, (e, r) => res(e ? { ok: false, error: String(e) } : r)));

const desk = await connect();
desk.emit('dispatch:join');
await new Promise((r) => desk.once('state:init', r));
desk.emit('sim:reset');
await new Promise((r) => desk.once('state:init', r));

const t0 = Date.now();
const burst = await ack(desk, 'burst:create', {});
const c = burst.comparison;
console.log(`burst: ${burst.created.length} incidents in ${Date.now() - t0} ms; greedy ${c.greedy.totalS} s vs Hungarian ${c.hungarian.totalS} s ` +
  `(saves ${(c.greedy.totalS - c.hungarian.totalS).toFixed(1)} s, ${((100 * (c.greedy.totalS - c.hungarian.totalS)) / c.greedy.totalS).toFixed(1)}%), executed ${c.mode}`);
console.log('pairs that differ from greedy:', c.pairs.filter((p) => p.unitId !== p.greedyUnitId).map((p) => `${p.incidentId}: ${p.greedyUnitId}->${p.unitId}`).join(', '));
const again = await ack(desk, 'burst:create', {});
console.log(`second burst within 5 min: ${again.created.length} new, ${again.merged.length} merged into existing incidents`);

// two phones 40 m apart report the same emergency
const p1 = await connect(), p2 = await connect();
const a = await ack(p1, 'sos:new', { lat: 18.5167, lng: 73.8414, type: 'medical', severity: 'LOW', people: 2, clientId: 'phone-1' });
const b = await ack(p2, 'sos:new', { lat: 18.5167 + 40 / 111195, lng: 73.8414, type: 'medical', severity: 'HIGH', people: 3, clientId: 'phone-2' });
console.log(`phone 1 -> ${a.incident.id}; phone 2 -> ${b.incident.id} merged=${JSON.stringify(b.merged)}; people ${b.incident.people}, severity ${b.incident.severity}, calls ${b.incident.calls}`);
desk.emit('sim:reset');
setTimeout(() => process.exit(0), 300);
