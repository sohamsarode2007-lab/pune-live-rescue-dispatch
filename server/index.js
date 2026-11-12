// Pune Live Rescue Dispatch: API server.
// Phase 1: REST API over the real Pune road graph. Socket.IO (live SOS) arrives in Phase 2.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_BBOX, FACILITIES_FILE, GRAPH_FILE, PORT, ROOT, TOMTOM_API_KEY } from './config.js';
import { GraphStore } from './services/graphStore.js';
import { ROAD_STATUS } from '../shared/graph/Graph.js';

if (!fs.existsSync(GRAPH_FILE)) {
  console.error(`Missing ${GRAPH_FILE}. Run: .venv\\Scripts\\python scripts/build_graph.py`);
  process.exit(1);
}
const store = GraphStore.fromFiles(GRAPH_FILE, FACILITIES_FILE);
const s = store.summary();
console.log(`Graph loaded: ${s.nodes} junctions, ${s.roads} roads, ${s.roadKm} km in ${s.loadMs} ms`);

const app = express();
app.use(express.json({ limit: '100kb' }));

const MARGIN = 0.02; // accept points slightly outside the bbox; they snap to the nearest edge junction
const inArea = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng)
  && lat >= DEMO_BBOX.south - MARGIN && lat <= DEMO_BBOX.north + MARGIN
  && lng >= DEMO_BBOX.west - MARGIN && lng <= DEMO_BBOX.east + MARGIN;
const point = (q, prefix) => ({ lat: Number(q[`${prefix}Lat`]), lng: Number(q[`${prefix}Lng`]) });
const bad = (res, msg) => res.status(400).json({ error: msg });

app.get('/api/summary', (_req, res) => {
  res.json({
    ...store.summary(),
    facilityCounts: store.facilitiesMeta?.counts ?? null,
    traffic: TOMTOM_API_KEY
      ? { live: false, mode: 'free-flow', message: 'Free-flow traffic (live traffic is added in Phase 4).' }
      : { live: false, mode: 'free-flow', message: 'Live traffic unavailable: using free-flow speeds.' },
  });
});

app.get('/api/facilities', (_req, res) => {
  res.json({ meta: store.facilitiesMeta, facilities: store.facilities, units: store.units });
});

app.get('/api/nearest', (req, res) => {
  const p = point(req.query, 'at');
  if (!inArea(p.lat, p.lng)) return bad(res, 'atLat/atLng must be a point inside the demo area.');
  res.json(store.nearest(p.lat, p.lng));
});

app.get('/api/route', (req, res) => {
  const from = point(req.query, 'from'), to = point(req.query, 'to');
  if (!inArea(from.lat, from.lng) || !inArea(to.lat, to.lng)) return bad(res, 'Both points must be inside the demo area.');
  const algos = String(req.query.algo ?? 'astar,dijkstra').split(',').filter(Boolean);
  try {
    res.json(store.route(from, to, algos));
  } catch (e) {
    bad(res, e.message);
  }
});

app.get('/api/roads/closed', (_req, res) => res.json(store.closedRoads()));

app.get('/api/roads/:id', (req, res) => {
  const info = store.roadInfo(req.params.id);
  info ? res.json(info) : res.status(404).json({ error: 'Unknown road' });
});

app.post('/api/roads/:id/status', (req, res) => {
  const { status } = req.body ?? {};
  if (!store.graph.getRoad(req.params.id)) return res.status(404).json({ error: 'Unknown road' });
  if (!Object.values(ROAD_STATUS).includes(status)) return bad(res, 'status must be OPEN, HIGH_RISK or BLOCKED');
  res.json(store.setRoadStatus(req.params.id, status));
});

app.post('/api/roads/reset', (_req, res) => { store.resetRoads(); res.json({ ok: true }); });

// Production: serve the built client (npm run build) from the same port, with SPA fallback.
const dist = path.join(ROOT, 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));
