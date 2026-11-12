// End-to-end check: a fake phone sends an SOS, a fake dispatcher watches. Measures SOS -> assignment
// -> first movement latency (wall clock) and follows the lifecycle at 30x sim speed.
import { io } from 'socket.io-client';
const URL = process.argv[2] ?? 'http://localhost:3001';
const phone = io(URL, { transports: ['websocket'] });
const desk = io(URL, { transports: ['websocket'] });
const ack = (s, ev, p) => new Promise((res) => s.timeout(5000).emit(ev, p, (e, r) => res(e ? { ok: false, error: String(e) } : r)));
await Promise.all([new Promise((r) => phone.on('connect', r)), new Promise((r) => desk.on('connect', r))]);
desk.emit('dispatch:join');
await new Promise((r) => desk.once('state:init', r));
desk.emit('sim:speed', { speed: 30 });

const outside = await ack(phone, 'sos:new', { lat: 19.07, lng: 72.87, type: 'fire', severity: 'LOW', people: 1 });
console.log('outside-area SOS (Mumbai) rejected:', outside.error);

const seen = [];
let firstMove = null, unitId = null, deskSaw = null;
phone.on('unit:position', (p) => { if (firstMove === null && unitId && p.units[0]?.id === unitId) firstMove = Date.now() - t0; });
desk.on('incident:updated', (i) => { if (deskSaw === null && i.unitId) deskSaw = Date.now() - t0; });
const t0 = Date.now();
const res = await ack(phone, 'sos:new', { lat: 18.5167, lng: 73.8414, type: 'medical', severity: 'HIGH', people: 2, accuracyM: 12, clientId: 'e2e' });
unitId = res.unit?.id;
console.log('phone ack', res.ok, res.incident?.id, res.incident?.status, 'unit', unitId, `after ${Date.now() - t0} ms`);
seen.push(res.incident.status);
phone.on('incident:updated', (i) => { if (i.id === res.incident.id && seen.at(-1) !== i.status) seen.push(i.status); });
const again = await ack(phone, 'sos:new', { lat: 18.52, lng: 73.84, type: 'fire', severity: 'LOW', people: 1 });
console.log('immediate second SOS rate-limited:', again.error);
await new Promise((r) => setTimeout(r, 1500));
console.log('dispatcher saw the assigned incident after', deskSaw, 'ms');
await new Promise((r) => { const iv = setInterval(() => { if (seen.includes('RESOLVED')) { clearInterval(iv); r(); } }, 200); setTimeout(() => { clearInterval(iv); r(); }, 90_000); });
console.log('phone saw first unit movement after', firstMove, 'ms');
console.log('phone saw statuses:', seen.join(' -> '));
desk.emit('sim:speed', { speed: 1 });
desk.emit('sim:reset');
setTimeout(() => process.exit(0), 300);
