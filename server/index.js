// Pune Live Rescue Dispatch: API + real-time server (Express + Socket.IO).
//
// Socket.IO events
//   phone -> server : sos:new {lat,lng,accuracyM,type,severity,people,clientId}  (ack: {ok, incident} | {ok:false, error})
//                     sos:watch {incidentId}   (re-join an incident's updates after a reload/reconnect)
//                     road:report {lat,lng,clientId}  (3 different phones within 15 min close the road)
//   dispatcher (5)  : flood:set {level}, flood:glofas {apply}
//   server (5)      : flood:updated, crowd:updated, unit:rerouted
//   dispatcher      : dispatch:join, sim:speed {speed}, sim:reset, burst:create, dispatch:mode,
//                     traffic:refresh, traffic:mode {mode: 'live'|'free-flow'}
//   server -> all   : incident:updated, unit:updated, unit:position, queue:updated, hospital:updated,
//                     hazard:updated (closed roads), state:init (full snapshot on join), comparison:updated,
//                     traffic:updated, external:calls
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Server } from 'socket.io';
import {
  BURST_BENCHMARK_FILE, DEMO_BBOX, EXTERNAL_CALLS_FILE, FACILITIES_FILE, GRAPH_FILE, OSRM_BASE_URL, OSRM_LOG_FILE, PORT, ROOT,
  SIM_SPEED, TICK_MS, TOMTOM_API_KEY, TOMTOM_FLOW_URL, TRAFFIC_SNAPSHOT_FILE,
} from './config.js';
import { GraphStore } from './services/graphStore.js';
import { DispatchService, DISPATCH_MODES } from './services/dispatchService.js';
import { ExternalCalls } from './services/externalCalls.js';
import { TrafficService } from './services/trafficService.js';
import { OsrmService } from './services/osrmService.js';
import { CompareService } from './services/compareService.js';
import { NetworkService } from './services/networkService.js';
import { FloodService } from './services/floodService.js';
import { CrowdReports } from './services/crowdReports.js';
import { ELEVATION_FILE, FLOOD_CURRENT_FILE, FLOOD_HISTORY_FILE, RIVER_FILE } from './config.js';
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

// Phase 4: external services (TomTom traffic, OSRM baseline) with a persisted daily call counter.
const calls = new ExternalCalls({ file: EXTERNAL_CALLS_FILE, onChange: (v) => io.to('dispatch').emit('external:calls', v) });
// Network resilience (Tarjan, trap zones, river crossings). Recomputed after closures / traffic changes.
const network = NetworkService.fromFile(store, RIVER_FILE, { onChange: (e) => io.to('dispatch').emit('network:updated', e.summary) });
const traffic = new TrafficService({
  store, apiKey: TOMTOM_API_KEY, snapshotFile: TRAFFIC_SNAPSHOT_FILE, calls,
  ...(TOMTOM_FLOW_URL ? { baseUrl: TOMTOM_FLOW_URL } : {}),
  onChange: (st) => { io.to('dispatch').emit('traffic:updated', st); network.roadsChanged(); },
});
network.rankCrossings().then((c) => console.log(`River crossings: ${c.ranking?.length ?? 0} ranked in ${c.ms} ms`));

// Phase 5: flood model + crowd reports.
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const flood = new FloodService({
  store, elevation: readJson(ELEVATION_FILE), rivers: network.rivers, calls,
  historyFile: FLOOD_HISTORY_FILE, currentFile: FLOOD_CURRENT_FILE,
});
const crowd = new CrowdReports({ store });
const floodChanged = () => io.to('dispatch').emit('flood:updated', flood.status());
console.log(`Flood model: ${flood.status().available ? 'ready' : 'unavailable (run scripts/build_elevation.py)'}`);
flood.refreshGlofas().then((g) => {
  console.log(g.ok ? `GloFAS: ${g.status} (peak ${g.peak.m3s} m3/s; p90 ${g.p90?.toFixed(1)}, p99 ${g.p99?.toFixed(1)}) -> initial level ${g.suggestedLevel} m` : `GloFAS: ${g.error}`);
  flood.applyGlofasSuggestion(dispatch.now);           // PLAN: GloFAS sets the initial slider level
  floodChanged();
});
const osrm = new OsrmService({ calls, ...(OSRM_BASE_URL ? { baseUrl: OSRM_BASE_URL } : {}) });
const compare = new CompareService({ store, osrm, traffic, logFile: OSRM_LOG_FILE });
const ts = traffic.status();
console.log(`Traffic: ${ts.message}; ${ts.samples} sample points; TomTom ${TOMTOM_API_KEY ? 'key present' : process.env.TOMTOM_DISABLED ? 'DISABLED (TOMTOM_DISABLED=1)' : 'key missing (free-flow fallback)'}`);

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
    traffic: { ...traffic.status(), live: traffic.mode === 'live' },
    externalCalls: calls.view(),
  });
});

app.get('/api/traffic', (_req, res) => res.json({ status: traffic.status(), ...traffic.roadsView() }));

app.get('/api/compare', async (req, res) => {
  const from = point(req.query, 'from'), to = point(req.query, 'to');
  if (!inArea(from.lat, from.lng) || !inArea(to.lat, to.lng)) return bad(res, 'Both points must be inside the demo area.');
  try { res.json(await compare.compare(from, to)); } catch (e) { bad(res, e.message); }
});

app.get('/api/compare/summary', (_req, res) => res.json(compare.summary()));

app.get('/api/burst-benchmark', (_req, res) => {
  if (!fs.existsSync(BURST_BENCHMARK_FILE)) return res.status(404).json({ error: 'Run node scripts/bench-burst.mjs' });
  const { rows, ...summary } = JSON.parse(fs.readFileSync(BURST_BENCHMARK_FILE, 'utf8'));
  res.json(summary);
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

const hazardChanged = () => { io.to('dispatch').emit('hazard:updated', store.closedRoads()); network.roadsChanged(); };
// Every closure path (manual, crossing, flood, crowd) ends here: reroute affected units, then broadcast.
const roadsClosed = (ids) => { if (ids.length) dispatch.roadsBlocked(ids); hazardChanged(); };

app.get('/api/flood', (_req, res) => res.json({ status: flood.status(), points: flood.floodedPoints(dispatch.now) }));
app.get('/api/crowd', (_req, res) => res.json(crowd.pending()));

app.get('/api/network/spof', (_req, res) => res.json(network.spof()));
app.get('/api/network/scc', (_req, res) => res.json(network.scc()));
app.get('/api/network/crossings', (_req, res) => res.json(network.crossings()));
app.get('/api/rivers', (_req, res) => res.json(network.rivers));

// Demo: close or reopen every road of one river crossing (simulates that bridge flooding).
app.post('/api/crossings/:id/status', (req, res) => {
  const c = network.crossingDefs.find((x) => x.id === req.params.id);
  const { status } = req.body ?? {};
  if (!c) return res.status(404).json({ error: 'Unknown crossing' });
  if (!['OPEN', 'BLOCKED'].includes(status)) return bad(res, 'status must be OPEN or BLOCKED');
  for (const id of c.roadIds) { store.setRoadStatus(id, status, 'crossing'); flood.forget(id); }
  roadsClosed(status === 'BLOCKED' ? c.roadIds : []);
  res.json({ ok: true, roadIds: c.roadIds });
});

app.post('/api/roads/:id/status', (req, res) => {
  const { status } = req.body ?? {};
  if (!store.graph.getRoad(req.params.id)) return res.status(404).json({ error: 'Unknown road' });
  if (!Object.values(ROAD_STATUS).includes(status)) return bad(res, 'status must be OPEN, HIGH_RISK or BLOCKED');
  const info = store.setRoadStatus(req.params.id, status, 'manual');
  flood.forget(req.params.id);                     // a dispatcher's decision overrides the flood model
  roadsClosed(status === 'BLOCKED' ? [req.params.id] : []);
  res.json(info);
});

// Reopens everything; an active flood re-applies itself on the next tick.
app.post('/api/roads/reset', (_req, res) => { store.resetRoads(); flood.applied.clear(); crowd.clear(); hazardChanged(); res.json({ ok: true }); });

// ---------------- Socket.IO ----------------
const SOS_MIN_INTERVAL_MS = 3000;  // per connection, to stop accidental double-taps / floods

io.on('connection', (socket) => {
  let lastSos = 0;

  socket.on('dispatch:join', () => {
    socket.join('dispatch');
    socket.emit('state:init', dispatch.snapshot());
    socket.emit('hazard:updated', store.closedRoads());
    socket.emit('traffic:updated', traffic.status());
    socket.emit('external:calls', calls.view());
    socket.emit('network:updated', network.summary());
    socket.emit('flood:updated', flood.status());
    socket.emit('crowd:updated', crowd.pending());
    // PLAN: no timer; refresh only while a dispatcher is connected, at most every 15 minutes.
    traffic.maybeAutoRefresh()?.then(() => io.to('dispatch').emit('traffic:updated', traffic.status()));
  });

  socket.on('traffic:refresh', async (_msg, ack = () => {}) => {
    if (!socket.rooms.has('dispatch')) return ack({ ok: false, reason: 'NOT_DISPATCHER' });
    io.to('dispatch').emit('traffic:updated', { ...traffic.status(), refreshing: true });
    const r = await traffic.refresh({ reason: 'manual' });
    io.to('dispatch').emit('traffic:updated', traffic.status());
    ack(r);
  });

  socket.on('traffic:mode', (msg, ack = () => {}) => {
    if (!socket.rooms.has('dispatch')) return ack({ ok: false });
    try { traffic.setMode(msg?.mode); ack({ ok: true }); } catch (e) { ack({ ok: false, message: e.message }); }
  });

  socket.on('sos:new', (msg, ack = () => {}) => {
    try {
      if (Date.now() - lastSos < SOS_MIN_INTERVAL_MS) return ack({ ok: false, error: 'TOO_FAST' });
      const lat = Number(msg?.lat), lng = Number(msg?.lng);
      if (!inArea(lat, lng)) return ack({ ok: false, error: 'OUTSIDE_AREA' });
      lastSos = Date.now();
      const { incident: inc, merged } = dispatch.submitCall({
        lat, lng, type: msg.type, severity: msg.severity, people: Number(msg.people),
        accuracyM: Number.isFinite(Number(msg.accuracyM)) ? Math.round(Number(msg.accuracyM)) : null,
        source: msg.source === 'dispatcher' ? 'dispatcher' : 'phone',
        clientId: typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : null,
      });
      socket.join(`inc:${inc.id}`);
      ack({ ok: true, merged, incident: dispatch.incidentView(inc), unit: inc.unitId ? dispatch.unitView(dispatch.units.get(inc.unitId)) : null });
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

  // Phase 5: crowd "flooded road" reports; 3 different phones within 15 min close the road.
  let lastReport = 0;
  socket.on('road:report', (msg, ack = () => {}) => {
    const lat = Number(msg?.lat), lng = Number(msg?.lng);
    if (!inArea(lat, lng)) return ack({ ok: false, error: 'OUTSIDE_AREA' });
    if (Date.now() - lastReport < 2000) return ack({ ok: false, error: 'TOO_FAST' });
    lastReport = Date.now();
    const r = crowd.report({ lat, lng, clientId: typeof msg?.clientId === 'string' ? msg.clientId.slice(0, 64) : socket.id });
    if (r.newlyBlocked) { flood.forget(r.roadId); roadsClosed([r.roadId]); }
    io.to('dispatch').emit('crowd:updated', crowd.pending());
    ack(r);
  });

  // Phase 5: "Khadakwasla dam release" slider and GloFAS refresh (dispatcher only).
  socket.on('flood:set', (msg, ack = () => {}) => {
    if (!socket.rooms.has('dispatch')) return ack({ ok: false });
    try { flood.setLevel(Number(msg?.level), dispatch.now, 'manual'); floodChanged(); ack({ ok: true, status: flood.status() }); } catch (e) { ack({ ok: false, message: e.message }); }
  });

  socket.on('flood:glofas', async (msg, ack = () => {}) => {
    if (!socket.rooms.has('dispatch')) return ack({ ok: false });
    const g = await flood.refreshGlofas({ force: true });
    if (msg?.apply && g.ok) flood.applyGlofasSuggestion(dispatch.now);
    floodChanged();
    ack(g);
  });

  socket.on('sim:speed', (msg) => {
    if (!socket.rooms.has('dispatch') || !SIM_SPEEDS.includes(Number(msg?.speed))) return;
    dispatch.setSpeed(Number(msg.speed));
    io.to('dispatch').emit('sim:speed', { speed: dispatch.clock.speed });
  });

  // Phase 3: 8 simultaneous incidents (fixed seeded pattern), dispatched as one batch.
  socket.on('burst:create', (_msg, ack = () => {}) => {
    if (!socket.rooms.has('dispatch')) return ack({ ok: false, error: 'NOT_DISPATCHER' });
    const r = dispatch.createBurst();
    ack({ ok: true, ...r });
  });

  socket.on('dispatch:mode', (msg) => {
    if (!socket.rooms.has('dispatch') || !DISPATCH_MODES.includes(msg?.mode)) return;
    dispatch.setMode(msg.mode);
    io.to('dispatch').emit('dispatch:mode', { mode: dispatch.mode });
  });

  socket.on('sim:reset', () => {
    if (!socket.rooms.has('dispatch')) return;
    dispatch.reset();
    if (flood.level > 0) flood.setLevel(flood.level, 0, flood.levelSource);   // sim clock restarted at 0
    io.to('dispatch').emit('state:init', dispatch.snapshot());
    floodChanged();
  });
});

let last = Date.now();
let lastFloodKey = '';
setInterval(() => {
  const nowMs = Date.now();
  dispatch.tick(nowMs - last);
  last = nowMs;
  // The flood spreads with simulated time: apply due road closures, reroute units, refresh analyses.
  const ch = flood.tick(dispatch.now);
  if (ch.blocked.length || ch.highRisk.length || ch.reopened.length) roadsClosed(ch.blocked);
  const key = `${flood.level}|${flood.floodedNow}|${flood.applied.size}`;
  if (key !== lastFloodKey) { lastFloodKey = key; floodChanged(); }
}, TICK_MS);

// Production: serve the built client (npm run build) from the same port, with SPA fallback.
const dist = path.join(ROOT, 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}  (sim speed ${dispatch.clock.speed}x)`));
