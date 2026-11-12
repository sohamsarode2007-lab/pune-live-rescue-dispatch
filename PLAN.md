# PLAN.md — Pune Live Rescue Dispatch (v2 of rescue-network)

## Goal
Turn the existing fictional-city ("Meridian") routing demo into a **live, real-map disaster rescue
dispatch simulation for central Pune**. A person opens a web page on their phone, presses
"I'm in danger", their GPS location reaches a dispatcher dashboard in real time, and the system
assigns the best rescue unit using **our own graph algorithms** on the real Pune road network,
with live traffic from TomTom as an input, then animates the unit driving there.

**Zero-cost stack, no credit card anywhere:** Leaflet + OpenStreetMap tiles (map display),
OSMnx/OSM (road graph), TomTom free tier (live traffic, no card), SRTM (elevation, offline),
OSRM public demo server (comparison baseline), Open-Meteo Flood API (river discharge, no key).
Do NOT use any Google Maps Platform API.

This is a Data Structures course project. **All routing, assignment, clustering and flow algorithms
must be implemented in our own code.** External services supply map tiles, traffic speeds, and a
baseline route for comparison only. Never display an external service's route as "ours".

## Hard rules
- Simulation only. Show a permanent banner on every page: "Demo simulation — in a real emergency call 112."
  Never contact any real emergency service.
- The only key is `TOMTOM_API_KEY`, server-side only, in `.env` (never committed; add `.env*` to
  `.gitignore`; provide `.env.example`). The app must still run fully if the key is missing:
  traffic falls back to free-flow and the UI says "live traffic unavailable".
- OSM tile usage policy: show "© OpenStreetMap contributors" attribution on every map, keep tile
  use light, and never bulk-download tiles. OSRM public server: at most 1 request per second,
  only for the comparison panel.
- Cache every external response (in-memory with TTL). Server-side call caps: TomTom max 200
  calls/day, enforced in code. Show a live external-call counter on the dashboard.
- Keep the existing test style (`node:test`). Every new algorithm gets tests, including a
  brute-force or reference comparison on small random inputs.
- Work phase by phase. At the end of each phase: run `npm test`, make sure the app builds,
  and summarise what changed before starting the next phase.
- Keep existing algorithm files (`Graph.js`, `MinHeap.js`, `dijkstra.js`, `bfs.js`, `dfs.js`,
  `EmergencyPriorityQueue.js`) and extend them; don't rewrite what already works and is tested.

## Target structure (monorepo)
```
shared/            # pure JS algorithms + data structures, used by server and tests (no React, no DOM)
  graph/           Graph.js MinHeap.js dijkstra.js astar.js bfs.js dfs.js tarjan.js
  dispatch/        hungarian.js EmergencyPriorityQueue.js
  spatial/         geohash.js kdtree.js haversine.js
  flow/            edmondsKarp.js
  sim/             EventQueue.js simClock.js
server/            # Node + Express + Socket.IO
  index.js  config.js
  services/        graphStore.js trafficService.js elevationService.js dispatchService.js
                   incidentService.js hazardService.js coverageService.js eventLog.js
  data/            pune-central.graph.json  facilities.json  (generated)
client/            # existing React + Vite app, moved here
  src/pages/       Dispatcher.jsx  SOS.jsx  Benchmarks.jsx
scripts/
  build_graph.py       # OSMnx: download drive network for a bbox, export graph JSON
  build_facilities.py  # OSMnx: hospitals, fire stations, police from OSM tags
  bench.mjs            # algorithm benchmarks (central Pune + full Pune)
  sos-bots.mjs         # load test: N simulated SOS clients
tests/
```

## Area config
`server/config.js`:
- `DEMO_BBOX` = central Pune: north 18.56, south 18.49, east 73.88, west 73.80
  (Kothrud, Deccan, Shivajinagar, Swargate, Camp, Mutha riverbank).
- `BENCH_AREA` = "Pune, Maharashtra, India" (full city), used only by `bench.mjs`.

---

## Phase 1 — Real Pune graph
1. `scripts/build_graph.py` (Python, OSMnx): download `network_type="drive"` for `DEMO_BBOX`,
   simplify, export JSON: nodes `{id, lat, lng}`, edges `{id, from, to, lengthM, highway,
   maxspeedKmh, oneway, geometry:[[lat,lng],...]}`. Respect one-way streets.
   Default speeds by highway type when `maxspeed` is missing (document the table in README).
2. Base edge weight = travel time in seconds = lengthM / speed. Keep the existing idea of separate
   components: `baseTimeS`, `trafficFactor`, `riskPenaltyS`, `status (OPEN|HIGH_RISK|BLOCKED)`.
   `cost = baseTimeS * trafficFactor + riskPenaltyS`.
3. Change `Graph.js` locations from canvas `x,y` to `lat,lng`. Keep the shared-road-object design.
4. `shared/graph/astar.js`: A* with haversine distance / max road speed as an admissible heuristic.
   Test: A* cost equals Dijkstra cost on 500 random pairs.
5. `shared/spatial/kdtree.js`: 2D k-d tree over graph nodes for "nearest road node to a GPS point".
   Test against brute-force nearest on random points.
6. `scripts/build_facilities.py`: real hospitals, fire stations, police stations inside the bbox from
   OSM tags, snapped to nearest graph node. Give hospitals a simulated `bedsFree` value and stations a
   simulated fleet (ambulance / fire truck / rescue boat), clearly marked as simulated.
7. Client: replace the SVG map with Leaflet via `react-leaflet`. Use the CARTO dark basemap for a
   command-centre look, with its required attribution; fall back to standard OSM raster tiles
   (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`) if it fails to load. Draw routes as
   polylines from edge geometry. Do NOT draw all edges by default; draw only routes, blocked roads,
   and hazard zones.

## Phase 2 — Live SOS loop
1. `server/index.js`: Express + Socket.IO. Events: `sos:new`, `incident:updated`, `unit:position`,
   `road:report`, `hazard:updated`.
2. `client/src/pages/SOS.jsx` (mobile-first, served at `/sos`): one large "I'm in danger" button,
   severity picker (3 levels), people-count stepper, incident type (medical / fire / flood).
   Uses `navigator.geolocation.getCurrentPosition` (high accuracy). Falls back to tap-on-map location
   if GPS is denied. After sending, shows the assigned unit, live ETA, and the unit moving on a map.
   Language toggle: English / मराठी / हिंदी.
3. Dispatcher dashboard (`/`): live incident pins, unit markers, queue panel, route panel.
4. Unit movement: server simulation clock moves units along their route geometry at edge speeds,
   broadcasting `unit:position`. Units go AVAILABLE → EN_ROUTE → ON_SCENE → TO_HOSPITAL → RETURNING.
5. Deploy notes in README: GPS requires HTTPS, so use ngrok or a deployed URL for phone testing.

## Phase 3 — Dispatch intelligence
1. **SOS clustering** (`shared/spatial/geohash.js`): bucket SOS calls by geohash (precision ~7);
   calls within ~100 m and ~5 min merge into one incident (check neighbour cells too). Sum people,
   keep max severity. Test merging and non-merging cases.
2. **Priority with aging**: reuse `EmergencyPriorityQueue`; waiting time now comes from the sim clock
   and increases live, so the queue is re-prioritised on each tick.
3. **Optimal assignment** (`shared/dispatch/hungarian.js`): build a cost matrix
   (available units × pending incidents) of ETAs from our engine; units whose type can't serve the
   incident (e.g. flood needs a boat) get infinite cost. Solve with the Hungarian algorithm, O(n³).
   Also implement greedy nearest-unit. Test Hungarian against brute-force permutations for n ≤ 6.
4. **Two-leg routing**: unit → incident → best hospital, where best = minimum ETA among hospitals
   with `bedsFree > 0`. Decrement beds on arrival. For severe incidents (highest severity level),
   prefer hospitals marked `major` in `facilities.json` (fall back to any hospital with beds if no
   major hospital is reachable). *(Added after Phase 1.)*
5. **Greedy vs optimal panel**: show total and average response time for both on the same incidents.

## Phase 4 — Live traffic + "Our engine vs OSRM"
1. `trafficService.js`: pick ~60 sample points on major roads (highway = primary/secondary/trunk) in
   the bbox. For each, call TomTom Traffic Flow Segment Data API (`flowSegmentData`), which returns
   `currentSpeed` and `freeFlowSpeed`. Set `trafficFactor = freeFlowSpeed / currentSpeed` (clamped to
   1.0–4.0) on the edges of that road segment, matched via the k-d tree. Edges without a sample stay 1.0.
   No timer: refresh only when a dispatcher client is connected, at most every 15 minutes, plus a
   manual "Refresh traffic" button. Save the last snapshot to disk so the demo works offline.
2. Optional visual: TomTom traffic flow raster tiles as a toggleable Leaflet overlay (cached).
3. Comparison panel: for the chosen dispatch, show our traffic-aware route + ETA next to OSRM's
   free-flow route (public demo server `router.project-osrm.org`) for the same origin/destination,
   both drawn on the map, plus the % ETA difference. Label clearly: OSRM = normal traffic, ours =
   live traffic. Log these for an average-difference figure in the report.
4. Traffic toggle on dashboard: "live traffic" vs "free-flow", to show the route changing.

## Phase 5 — Flood realism and rerouting
1. `scripts/build_elevation.py`: assign an elevation to every graph node using SRTM data
   (Python `srtm.py` package, downloaded once, offline after that); write `server/data/elevation.json`.
   `elevationService.js` only reads that file.
2. **Mutha river flood**: river line from OSM. A "Khadakwasla dam release" slider raises a water level.
   A node floods if it is within a buffer of the river AND its elevation is below the river elevation
   plus the water level. Edges touching flooded nodes become BLOCKED; edges near the flood edge become
   HIGH_RISK. Flood grows over sim time (BFS spread outward from the river across low nodes).
   Label clearly as a simplified model, not a hydrological prediction.
   **Real trigger:** `floodService.js` fetches the Open-Meteo Flood API (GloFAS river discharge, free,
   no key) for a point on the Mutha in the bbox, compares today's/forecast discharge with its
   historical percentiles, and sets the initial slider level (normal / elevated / flood alert).
   The slider can still override it for the demo. Cache the last response to disk. State in the UI
   and README that GloFAS is a coarse global model and does not capture Khadakwasla dam releases,
   which is why the manual slider exists.
3. **Dynamic rerouting**: when an edge on an active unit's remaining route becomes BLOCKED, recompute
   from the unit's current position and broadcast the new route. Highlight reroute events on the map.
4. **Crowd road reports**: SOS page "report flooded road" button; an edge becomes BLOCKED only after
   3 reports from different clients within 15 minutes.

## Phase 6 — Planning tools
1. **Coverage isochrones**: multi-source Dijkstra from all stations; colour roads by response time
   (<5, 5–8, 8–12, >12 min). Show % of road length covered within 8 minutes.
2. **New station placement**: greedy k-center over graph nodes — suggest the location that most
   reduces the worst-case response time; show before/after coverage.
3. **Single points of failure** (`shared/graph/tarjan.js`): Tarjan's algorithm for bridges and
   articulation points on the undirected version of the road graph. Highlight on the map the edges
   and junctions whose loss cuts a neighbourhood off from every hospital (e.g. river crossings on the
   Mutha). Show "neighbourhoods cut off if this fails" on click. Test against brute force
   (remove each edge, check connectivity) on small random graphs.
4. **Evacuation feasibility** (`shared/flow/edmondsKarp.js`): super-source → affected neighbourhoods
   (people as supply) → road network (edge capacity in vehicles/hour by highway type, documented
   assumption: motorway/trunk 2000, primary/secondary 1200, tertiary/residential 400; HIGH_RISK edges
   at 50%) → shelters
   (capacity) → super-sink. Report max people evacuable vs total, and the bottleneck edges (min cut)
   on the map. Test against a hand-solved small network.

## Cross-phase additions (requested after Phase 1)
- `/algorithms` page: pick a junction, run BFS or DFS, show visit order on the map and the number of
  junctions reached; an explanation card (purpose, input, output, steps, complexity) for every
  algorithm/data structure. Each phase adds cards for its new algorithms.
- Git: commit at the end of every phase.

## Phase 7 — Evaluation and demo safety
1. `scripts/bench.mjs`: Dijkstra vs A* (time, nodes settled) on central Pune and full Pune;
   k-d tree vs brute-force nearest; Hungarian vs greedy. Output a markdown table and show it at
   `/benchmarks`.
2. `scripts/sos-bots.mjs`: N simulated phones send SOS from random road locations; report incidents
   created, clustering ratio, average assignment latency, average response time.
3. **Event log + replay**: every event written to a JSONL log with sim timestamps; replay at 1×/5×/10×
   with a fixed seed. Include one ready-made scenario "Monsoon flood — Mutha riverbank" so the
   demo works even if live GPS or Wi-Fi fails in the room.

## Definition of done
- Phone SOS → dispatcher pin → unit assigned and moving, in under 3 seconds on a local network.
- Total external spend: zero. No credit card registered with any provider.
- `npm test` passes, with reference/brute-force comparisons for A*, k-d tree, Hungarian, Tarjan, Edmonds-Karp.
- README updated: architecture diagram, cost model, every assumption and simulated value labelled,
  complexity table for every algorithm, benchmark results, data sources and attributions
  (OpenStreetMap, TomTom, SRTM, OSRM).
