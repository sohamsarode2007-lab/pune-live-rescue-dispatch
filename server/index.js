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
  SIM_SPEED, TICK_MS, TOMTOM_API_KEY, TOMTOM_FLOW_URL, TRAFFIC_SNAPSHOT_FILE, TRAFFIC_SNAPSHOT_BASELINE_FILE, FLOOD_CURRENT_BASELINE_FILE,
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
import { ELEVATION_FILE, FLOOD_CURRENT_FILE, FLOOD_HISTORY_FILE, OPEN_METEO_FLOOD_URL, RIVER_FILE } from './config.js';
import { PlanningService } from './services/planningService.js';
import { ScenarioRunner, monsoonScenario, simStep } from './services/scenario.js';
import { EventLog, listReplays } from './services/eventLog.js';
import { LOG_DIR, REPLAY_DIR, BENCHMARKS_FILE } from './config.js';
import { trafficRefresh, glofasRefresh, compareRoutes } from './externalHandlers.js';
import { ROAD_STATUS } from '../shared/graph/Graph.js';
import { SIM_SPEEDS } from '../shared/sim/simClock.js';

// Last-resort net: every known async path catches its own errors (startupTask, externalHandlers.js), but a
// missed rejection must be logged, not take the dispatch server down.
process.on('unhandledRejection', (e) => console.error('Unhandled promise rejection (server keeps running):', e));

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

// Phase 7 event log: everything the dispatcher sees, stamped with simulated time (JSONL, replayable).
const eventLog = new EventLog({ dir: LOG_DIR });
let simNow = () => 0;
const toDispatch = (event, payload) => { eventLog.write(event, payload, simNow()); io.to('dispatch').emit(event, payload); };

const dispatch = new DispatchService(store, {
  speed: SIM_SPEED,
  emit: (event, payload, rooms) => {
    if (rooms.includes('dispatch')) eventLog.write(event, payload, simNow());   // per-incident copies are not logged twice
    io.to(rooms).emit(event, payload);
  },
});
simNow = () => dispatch.now;
eventLog.open('session');

// Phase 4: external services (TomTom traffic, OSRM baseline) with a persisted daily call counter.
const calls = new ExternalCalls({ file: EXTERNAL_CALLS_FILE, onChange: (v) => toDispatch('external:calls', v) });
// Network resilience (Tarjan, trap zones, river crossings). Recomputed after closures / traffic changes.
const network = NetworkService.fromFile(store, RIVER_FILE, { onChange: (e) => toDispatch('network:updated', e.summary) });
const traffic = new TrafficService({
  store, apiKey: TOMTOM_API_KEY, snapshotFile: TRAFFIC_SNAPSHOT_FILE, baselineFile: TRAFFIC_SNAPSHOT_BASELINE_FILE, calls,
  ...(TOMTOM_FLOW_URL ? { baseUrl: TOMTOM_FLOW_URL } : {}),
  onChange: (st) => { toDispatch('traffic:updated', st); network.roadsChanged(); },
});
// Startup background tasks must never take the server down: any error (in the task or in its logging) is
// logged and the server keeps serving.
const startupTask = (name, fn) => Promise.resolve().then(fn).catch((e) => console.error(`Startup task "${name}" failed:`, e));
startupTask('river crossings', async () => {
  const c = await network.rankCrossings();
  console.log(c?.status === 'ready'
    ? `River crossings: ${c.ranking.length} ranked in ${c.ms} ms`
    : 'River crossings: network changed during ranking; recomputing shortly');
});

// Phase 5: flood model + crowd reports.
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const flood = new FloodService({
  store, elevation: readJson(ELEVATION_FILE), rivers: network.rivers, calls,
  historyFile: FLOOD_HISTORY_FILE, currentFile: FLOOD_CURRENT_FILE, currentBaselineFile: FLOOD_CURRENT_BASELINE_FILE,
  ...(OPEN_METEO_FLOOD_URL ? { apiUrl: OPEN_METEO_FLOOD_URL } : {}),
});
const crowd = new CrowdReports({ store });
const floodChanged = () => toDispatch('flood:updated', flood.status());
console.log(`Flood model: ${flood.status().available ? 'ready' : 'unavailable (run scripts/build_elevation.py)'}`);
// Phase 6 planning: coverage isochrones, station placement (k-center), evacuation (Edmonds-Karp).
const planning = new PlanningService({ store, flood });
let geometryJson = null;
let coverageTimer = null;
const coverageChanged = () => {
  clearTimeout(coverageTimer);
  coverageTimer = setTimeout(() => toDispatch('coverage:updated', planning.coverageSummary(dispatch.now)), 250);
};
setTimeout(() => startupTask('planning', async () => {
  const p = await planning.computePlacement();
  console.log(`Station placement (k-center) ready in ${p.ms} ms; normal and 10 m flood suggestions ${p.sameSuggestion ? 'are the same' : 'differ'}`);
  const e = await planning.computeEvacuation();
  if (e) console.log(`Evacuation (Edmonds-Karp): normal ${e.normal.pct}% vs 10 m flood ${e.flood.pct}% of ${e.normal.totalPeople} people`);
  toDispatch('planning:updated', { placement: Boolean(p), evacuation: Boolean(e) });
}), 300);

// One-click demo scenario (deterministic: fixed sim steps, seeded calls).
const runner = new ScenarioRunner();
const MONSOON = monsoonScenario(flood.riverPoints, DEMO_BBOX, network.crossingDefs);

startupTask('GloFAS', async () => {
  const g = await flood.refreshGlofas();
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
  const [status, body] = await compareRoutes({ compare }, from, to);
  res.status(status).json(body);
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

const hazardChanged = () => { toDispatch('hazard:updated', store.closedRoads()); network.roadsChanged(); coverageChanged(); };
// Every closure path (manual, crossing, flood, crowd) ends here: reroute affected units, then broadcast.
const roadsClosed = (ids) => { if (ids.length) dispatch.roadsBlocked(ids); hazardChanged(); };

app.get('/api/coverage', (req, res) => {
  const kind = req.query.kind === 'ambulance' ? 'ambulance' : 'fire';
  res.json({ kind, ...planning.coverage(kind), summary: planning.coverageSummary() });
});
// (not under /api/roads/: that prefix is taken by /api/roads/:id)
app.get('/api/geometry/roads', (_req, res) => {
  geometryJson ??= JSON.stringify(planning.geometry());
  res.type('application/json').send(geometryJson);
});
app.get('/api/placement', (_req, res) => res.json(planning.placementResult ?? { computing: true }));
app.get('/api/evacuation', (_req, res) => res.json(planning.evacuationResult ?? { computing: true }));
app.get('/api/shelters', (_req, res) => res.json({ meta: store.facilitiesMeta?.shelters ?? null, shelters: store.facilities.filter((f) => f.kind === 'shelter') }));
app.get('/api/scenario', (_req, res) => res.json({ definition: MONSOON, status: runner.status() }));

// Phase 7: replays (saved demo logs + session logs) and benchmark results.
app.get('/api/replays', (_req, res) => { eventLog.flushSync(); res.json(listReplays(REPLAY_DIR, LOG_DIR)); });
app.get('/api/replays/:name', (req, res) => {
  const name = req.params.name;
  if (!/^[\w.-]+\.jsonl$/.test(name)) return bad(res, 'Bad log name');
  const file = [path.join(REPLAY_DIR, name), path.join(LOG_DIR, name)].find((f) => fs.existsSync(f));
  if (!file) return res.status(404).json({ error: 'Unknown log' });
  eventLog.flushSync();
  res.type('application/x-ndjson').sendFile(file);
});
app.get('/api/benchmarks', (_req, res) => {
  if (!fs.existsSync(BENCHMARKS_FILE)) return res.status(404).json({ error: 'Run node scripts/bench.mjs' });
  res.type('application/json').send(fs.readFileSync(BENCHMARKS_FILE, 'utf8'));
});

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
    socket.emit('coverage:updated', planning.coverageSummary());
    socket.emit('scenario:updated', runner.status());
    // TomTom is never called automatically (not on startup, not on connect): only the "Refresh traffic"
    // button below spends quota.
  });

  // External services (TomTom, Open-Meteo): the handlers never reject; failures are logged and acked as
  // "Refresh failed — keeping last data".
  socket.on('traffic:refresh', async (msg, ack = () => {}) => {
    if (!socket.rooms.has('dispatch')) return ack({ ok: false, reason: 'NOT_DISPATCHER' });
    ack(await trafficRefresh({ traffic, toDispatch }, msg));
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
    toDispatch('crowd:updated', crowd.pending());
    ack(r);
  });

  // Phase 5: "Khadakwasla dam release" slider and GloFAS refresh (dispatcher only).
  socket.on('flood:set', (msg, ack = () => {}) => {
    if (!socket.rooms.has('dispatch')) return ack({ ok: false });
    try { flood.setLevel(Number(msg?.level), dispatch.now, 'manual'); floodChanged(); ack({ ok: true, status: flood.status() }); } catch (e) { ack({ ok: false, message: e.message }); }
  });

  socket.on('flood:glofas', async (msg, ack = () => {}) => {
    if (!socket.rooms.has('dispatch')) return ack({ ok: false });
    ack(await glofasRefresh({ flood, now: () => dispatch.now, floodChanged }, msg));
  });

  socket.on('sim:speed', (msg) => {
    if (!socket.rooms.has('dispatch') || !SIM_SPEEDS.includes(Number(msg?.speed))) return;
    dispatch.setSpeed(Number(msg.speed));
    toDispatch('sim:speed', { speed: dispatch.clock.speed });
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
    toDispatch('dispatch:mode', { mode: dispatch.mode });
  });

  socket.on('sim:reset', () => {
    if (!socket.rooms.has('dispatch')) return;
    runner.stop();
    dispatch.reset();
    eventLog.open('reset');
    flood.restartAt(0);                                // sim clock restarted at 0
    planning.clearHistory();
    toDispatch('state:init', dispatch.snapshot());
    toDispatch('scenario:updated', runner.status());
    floodChanged();
  });

  // One click: reset, free-flow, 10x, Hungarian, flood 0 -> 10 m, 12 seeded SOS calls on both banks.
  socket.on('scenario:start', (msg, ack = () => {}) => {
    if (!socket.rooms.has('dispatch')) return ack({ ok: false });
    if (msg?.id !== 'monsoon') return ack({ ok: false, error: 'Unknown scenario' });
    if (!flood.model) return ack({ ok: false, error: 'Flood model unavailable (run scripts/build_elevation.py)' });
    dispatch.reset();
    store.resetRoads();
    flood.reset();
    crowd.clear();
    planning.clearHistory();
    if (traffic.mode !== MONSOON.trafficMode) traffic.setMode(MONSOON.trafficMode);
    dispatch.setSpeed(MONSOON.speed);
    dispatch.setMode(MONSOON.dispatchMode);
    runner.start(MONSOON, dispatch.now);
    eventLog.open('monsoon', { scenario: MONSOON.id, name: MONSOON.name });
    toDispatch('state:init', dispatch.snapshot());
    toDispatch('sim:speed', { speed: dispatch.clock.speed });
    toDispatch('dispatch:mode', { mode: dispatch.mode });
    toDispatch('scenario:updated', runner.status());
    hazardChanged();
    floodChanged();
    ack({ ok: true, status: runner.status() });
  });
});

// Simulation loop. The sim clock advances by a FIXED step per tick (TICK_MS x speed), not by measured wall
// time, so a scenario always plays out identically (deterministic); wall-clock jitter only changes pace.
let lastFloodKey = '';
setInterval(() => {
  const { roadsChanged, scenarioChanged } = simStep({ dispatch, flood, runner }, TICK_MS);
  // (reroutes caused by changes.blocked were already broadcast by the dispatch service)
  if (roadsChanged) { toDispatch('hazard:updated', store.closedRoads()); network.roadsChanged(); coverageChanged(); }
  if (scenarioChanged) toDispatch('scenario:updated', runner.status());
  const key = `${flood.level}|${flood.floodedNow}|${flood.applied.size}`;
  if (key !== lastFloodKey) {
    lastFloodKey = key;
    floodChanged();
    eventLog.write('flood:points', flood.floodedPoints(dispatch.now), dispatch.now);   // for replay maps
  }
}, TICK_MS);

// Production: serve the built client (npm run build) from the same port, with SPA fallback.
const dist = path.join(ROOT, 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}  (sim speed ${dispatch.clock.speed}x)`));
