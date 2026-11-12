// Pune Live Rescue Dispatch: API + real-time server (Express + Socket.IO).
//
// Socket.IO events
//   phone -> server : sos:new {lat,lng,accuracyM,type,severity,people,clientId}  (ack: {ok, incident} | {ok:false, error})
//                     sos:watch {incidentId}   (re-join an incident's updates after a reload/reconnect)
//                     road:report {lat,lng,clientId}  (stored; Phase 5 turns 3 reports into a closure)
//   dispatcher      : dispatch:join, sim:speed {speed}, sim:reset
//   server -> all   : incident:updated, unit:updated, unit:position, queue:updated, hospital:updated,
//                     hazard:updated (closed roads), state:init (full snapshot on join)
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Server } from 'socket.io';
import { DEMO_BBOX, FACILITIES_FILE, GRAPH_FILE, PORT, ROOT, SIM_SPEED, TICK_MS, TOMTOM_API_KEY } from './config.js';
import { GraphStore } from './services/graphStore.js';
import { DispatchService } from './services/dispatchService.js';
import { ROAD_STATUS } from '../shared/graph/Graph.js';
import { SIM_SPEEDS } from '../shared/sim/simClock.js';

if (!fs.existsSync(GRAPH_FILE)) {
  console.error(`Missing ${GRAPH_FILE}. Run: npm run data:graph`);
  process.exit(1);
}
const store = GraphStore.fromFiles(GRAPH_FILE, FACILITIES_FILE);
const s = store.summary();
console.log(`Graph loaded: ${s.nodes} junctions, ${s.roads} roads, ${s.roadKm} km in ${s.loadMs} ms`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, maxHttpBufferSize: 1e5 });

const dispatch = new DispatchService(store, {
  speed: SIM_SPEED,
  emit: (event, payload, rooms) => io.to(rooms).emit(event, payload),
});

app.use(express.json({ limit: '100kb' }));

const MARGIN = 0.02; // accept points slightly outside the bbox; they snap to the nearest edge junction
const inArea = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng)
  && lat >= DEMO_BBOX.south - MARGIN && lat <= DEMO_BBOX.north + MARGIN
  && lng >= DEMO_BBOX.west - MARGIN && lng <= DEMO_BBOX.east + MARGIN;
const point = (q, prefix) => ({ lat: Number(q[`${prefix}Lat`]), lng: Number(q[`${prefix}Lng`]) });
const bad = (res, msg) => res.status(400).json({ error: msg });

// ---------------- REST ----------------
app.get('/api/summary', (_req, res) => {
  res.json({
    ...store.summary(),
    facilityCounts: store.facilitiesMeta?.counts ?? null,
    traffic: { live: false, mode: 'free-flow', message: TOMTOM_API_KEY ? 'Free-flow traffic (live traffic is added in Phase 4).' : 'Live traffic unavailable: using free-flow speeds.' },
  });
});

app.get('/api/facilities', (_req, res) => res.json({ meta: store.facilitiesMeta, facilities: store.facilities, units: store.units }));

app.get('/api/state', (_req, res) => res.json(dispatch.snapshot()));

app.get('/api/nearest', (req, res) => {
  const p = point(req.query, 'at');
  if (!inArea(p.lat, p.lng)) return bad(res, 'atLat/atLng must be a point inside the demo area.');
  res.json(store.nearest(p.lat, p.lng));
});

app.get('/api/route', (req, res) => {
  const from = point(req.query, 'from'), to = point(req.query, 'to');
  if (!inArea(from.lat, from.lng) || !inArea(to.lat, to.lng)) return bad(res, 'Both points must be inside the demo area.');
  const algos = String(req.query.algo ?? 'astar,dijkstra').split(',').filter(Boolean);
  try { res.json(store.route(from, to, algos)); } catch (e) { bad(res, e.message); }
});

app.get('/api/traverse', (req, res) => {
  const p = point(req.query, 'at');
  if (!inArea(p.lat, p.lng)) return bad(res, 'Pick a junction inside the demo area.');
  try { res.json(store.traverse(String(req.query.algo), p.lat, p.lng)); } catch (e) { bad(res, e.message); }
});

app.get('/api/roads/closed', (_req, res) => res.json(store.closedRoads()));

app.get('/api/roads/:id', (req, res) => {
  const info = store.roadInfo(req.params.id);
  info ? res.json(info) : res.status(404).json({ error: 'Unknown road' });
});

const hazardChanged = () => io.to('dispatch').emit('hazard:updated', store.closedRoads());

app.post('/api/roads/:id/status', (req, res) => {
  const { status } = req.body ?? {};
  if (!store.graph.getRoad(req.params.id)) return res.status(404).json({ error: 'Unknown road' });
  if (!Object.values(ROAD_STATUS).includes(status)) return bad(res, 'status must be OPEN, HIGH_RISK or BLOCKED');
  const info = store.setRoadStatus(req.params.id, status);
  hazardChanged();
  res.json(info);
});

app.post('/api/roads/reset', (_req, res) => { store.resetRoads(); hazardChanged(); res.json({ ok: true }); });

// ---------------- Socket.IO ----------------
const SOS_MIN_INTERVAL_MS = 3000;  // per connection, to stop accidental double-taps / floods

io.on('connection', (socket) => {
  let lastSos = 0;

  socket.on('dispatch:join', () => {
    socket.join('dispatch');
    socket.emit('state:init', dispatch.snapshot());
    socket.emit('hazard:updated', store.closedRoads());
  });

  socket.on('sos:new', (msg, ack = () => {}) => {
    try {
      if (Date.now() - lastSos < SOS_MIN_INTERVAL_MS) return ack({ ok: false, error: 'TOO_FAST' });
      const lat = Number(msg?.lat), lng = Number(msg?.lng);
      if (!inArea(lat, lng)) return ack({ ok: false, error: 'OUTSIDE_AREA' });
      lastSos = Date.now();
      const inc = dispatch.createIncident({
        lat, lng, type: msg.type, severity: msg.severity, people: Number(msg.people),
        accuracyM: Number.isFinite(Number(msg.accuracyM)) ? Math.round(Number(msg.accuracyM)) : null,
        source: msg.source === 'dispatcher' ? 'dispatcher' : 'phone',
        clientId: typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : null,
      });
      socket.join(`inc:${inc.id}`);
      ack({ ok: true, incident: dispatch.incidentView(inc), unit: inc.unitId ? dispatch.unitView(dispatch.units.get(inc.unitId)) : null });
    } catch (e) {
      ack({ ok: false, error: 'INVALID', message: e.message });
    }
  });

  socket.on('sos:watch', (msg, ack = () => {}) => {
    const inc = dispatch.incidents.get(String(msg?.incidentId));
    if (!inc) return ack({ ok: false, error: 'UNKNOWN_INCIDENT' });
    socket.join(`inc:${inc.id}`);
    ack({ ok: true, incident: dispatch.incidentView(inc), unit: inc.unitId ? dispatch.unitView(dispatch.units.get(inc.unitId)) : null });
  });

  socket.on('road:report', (msg, ack = () => {}) => {
    const lat = Number(msg?.lat), lng = Number(msg?.lng);
    if (!inArea(lat, lng)) return ack({ ok: false, error: 'OUTSIDE_AREA' });
    dispatch.reportRoad({ lat, lng, clientId: String(msg?.clientId ?? socket.id).slice(0, 64) });
    ack({ ok: true });
  });

  socket.on('sim:speed', (msg) => {
    if (!socket.rooms.has('dispatch') || !SIM_SPEEDS.includes(Number(msg?.speed))) return;
    dispatch.setSpeed(Number(msg.speed));
    io.to('dispatch').emit('sim:speed', { speed: dispatch.clock.speed });
  });

  socket.on('sim:reset', () => {
    if (!socket.rooms.has('dispatch')) return;
    dispatch.reset();
    io.to('dispatch').emit('state:init', dispatch.snapshot());
  });
});

let last = Date.now();
setInterval(() => {
  const nowMs = Date.now();
  dispatch.tick(nowMs - last);
  last = nowMs;
}, TICK_MS);

// Production: serve the built client (npm run build) from the same port, with SPA fallback.
const dist = path.join(ROOT, 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}  (sim speed ${dispatch.clock.speed}x)`));
