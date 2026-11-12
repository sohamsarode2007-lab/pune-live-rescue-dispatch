# Pune Live Rescue Dispatch

A disaster-rescue **dispatch simulation on the real road network of central Pune**. A person opens a page on
their phone and presses "I'm in danger". Their GPS location reaches the dispatcher dashboard in real time, a
rescue unit is assigned with our own graph algorithms, and the unit is shown driving there.

This is a Data Structures course project: all routing, assignment and spatial search is our own code
(`shared/`). External services supply only map tiles and raw OpenStreetMap data.

> **Demo simulation — in a real emergency call 112.** This app never contacts any emergency service.
> Hospital beds, every rescue vehicle and all unit timings are **simulated**.

The plan of record is [PLAN.md](PLAN.md). **Status: Phase 1 (real Pune graph) and Phase 2 (live SOS loop) done.**
The earlier fictional-city version ("Meridian") is kept, unused, in `legacy/meridian/`.

## 1. Run it

Requires Node.js 18+ (developed on Node 24). No keys or accounts needed.

```bash
npm install
npm run dev          # server on :3001 + web UI on http://localhost:5173 (hot reload)
npm test             # node:test suite: algorithms, real-data checks, dispatch simulation
npm run build        # production build into client/dist
npm start            # server + built UI together on http://localhost:3001
npm run check:sos    # end-to-end socket test against a running server (fake phone + dispatcher)
npm run check:browser  # real browser (Edge/Chrome) test of the SOS page with a faked GPS fix
```

| Page | URL | What it does |
|---|---|---|
| Dispatcher | `/` | Live incidents, units, waiting queue, sim speed, test SOS; Phase 1 route planner tab |
| SOS phone | `/sos` | Big "I'm in danger" button, type, severity, people; live unit and ETA. English / मराठी / हिंदी |
| Algorithms | `/algorithms` | BFS/DFS visit order on the map + explanation card for every algorithm |

Deep links for demos:
- `/?incident=18.5074,73.8077` opens the route planner with that destination.
- `/sos?incident=INC-001` re-opens a request's tracking view.
- `/algorithms?algo=dfs&at=18.5167,73.8414` runs DFS from that point.

### Testing the SOS page on a phone (ngrok)

Phone browsers only allow GPS on **HTTPS** pages, so open the app through an HTTPS tunnel:

1. Create a free ngrok account and install ngrok (https://ngrok.com/download). Run
   `ngrok config add-authtoken <token>` once.
2. Simplest: serve everything from one port.
   ```bash
   npm run build && npm start        # http://localhost:3001
   ngrok http 3001                   # prints https://<something>.ngrok-free.app
   ```
   Alternatively, with hot reload: `npm run dev`, then `ngrok http 5173`. Vite already allows `*.ngrok-free.app`
   hosts and proxies `/api` and `/socket.io`.
3. On the laptop open `https://<something>.ngrok-free.app/` (dispatcher). On the phone open `…/sos`.
   ngrok's free plan shows a one-time "You are about to visit" page; tap **Visit Site**.
4. Press **I'm in danger** and allow location.
   - **If you are not in central Pune**, the page says you are outside the demo area and lets you tap a location
     on the map instead.
   - It does the same if GPS is denied or unavailable.

The dispatcher sees the pin immediately. Measured locally: SOS to assigned unit in 17 ms, phone sees the unit
moving within 0.2 s.

## 2. Structure

```
shared/   pure JS, no React/DOM. Used by the server and the tests
  graph/     Graph.js MinHeap.js dijkstra.js astar.js bfs.js dfs.js
  dispatch/  EmergencyPriorityQueue.js requestConstants.js
  spatial/   kdtree.js haversine.js
  sim/       EventQueue.js simClock.js trip.js
server/   Express + Socket.IO
  index.js config.js
  services/  graphStore.js (graph, routing, traversal)  dispatchService.js (live simulation)
  data/      pune-central.graph.json facilities.json (generated)
client/   React + Vite + Leaflet (react-leaflet)
  src/pages/  Dispatcher.jsx SOS.jsx Algorithms.jsx
  src/components/  RescueMap SosMap AlgoMap mapParts NavLinks SafetyBanner
  src/data/algorithmInfo.js   explanation cards (add one per new algorithm)
scripts/  build_graph.py build_facilities.py osm_common.py run-python.mjs e2e-sos.mjs browser-check.mjs
tests/    *.test.js (node:test)
legacy/   previous fictional-city version, not built or tested
```

## 3. Live SOS loop (Phase 2)

**Socket.IO events**

| Direction | Event | Payload / meaning |
|---|---|---|
| phone → server | `sos:new` | `{lat, lng, accuracyM, type, severity, people, clientId}`; ack `{ok, incident, unit}` or `{ok:false, error}` |
| phone → server | `sos:watch` | re-join an incident's updates after a reload or reconnect |
| phone → server | `road:report` | flooded-road report (stored now; Phase 5 needs 3 reports to close a road) |
| dispatcher → server | `dispatch:join`, `sim:speed`, `sim:reset` | join live feed, set 1×/5×/10×/30×, clear |
| server → clients | `incident:updated`, `unit:updated`, `unit:position`, `queue:updated`, `hospital:updated`, `hazard:updated`, `state:init` | live state |

Phones only receive updates for their own incident (Socket.IO rooms `inc:<id>`).

**Validation:**
- SOS points must be inside the demo area. Mumbai is rejected with `OUTSIDE_AREA`.
- Each connection may send at most one SOS every 3 s.
- Type, severity and people (1–50) are checked.

**Assignment (Phase 2 rule; Phase 3 adds clustering, aging and the Hungarian algorithm)**
- Medical → ambulance, fire → fire truck, flood → rescue boat. Boats travel by road on a trailer.
- One **reverse Dijkstra** from the incident gives every junction's travel time *to* the incident. The free
  unit with the lowest ETA is sent. A RETURNING unit can be re-assigned: it finishes its current road, then
  re-routes from the next junction.
- If no capable unit is free, the incident waits in the **emergency priority queue** (max-heap). Score =
  5·severity + 2·min(people,10) + min(minutes waited,10). The first freed unit takes the top incident it can
  serve.

**Unit lifecycle:** AVAILABLE → EN_ROUTE → ON_SCENE → TO_HOSPITAL (ambulances) → RETURNING → AVAILABLE.
- Transitions are events in a **discrete-event queue** (min-heap by simulated time).
- A **sim clock** runs at 1× (real time) by default. The dispatcher can switch to 5×, 10× or 30×.
- Positions are interpolated along each trip with **prefix sums + binary search** and broadcast every 0.5 s.
- A road takes its routing cost in seconds, so the arrival time equals the promised ETA.
- Time on scene (simulated): medical 4 min, fire 10 min, flood 8 min.
- **Hospital choice:** the nearest hospital (Dijkstra) with free beds. For *life-threatening* incidents,
  only **major** hospitals are considered while one is reachable. A bed is taken on arrival.

## 4. Road graph and cost model

- **Area** (`server/config.js` `DEMO_BBOX`): N 18.56, S 18.49, E 73.88, W 73.80. Covers Kothrud, Deccan,
  Shivajinagar, Swargate, Camp and the Mutha riverbank.
- **Source:** OpenStreetMap `network_type="drive"`, simplified, giving 7,695 junctions and 10,218 roads
  (775 km, 2,395 of them one-way). Only the largest strongly connected component is kept, so every junction
  can reach every other one while obeying one-way streets.
- **Two-way roads** are one road object shared by both directions, so a closure affects both. **One-way**
  roads are stored only in their legal direction.
- **Edge cost (seconds)** = `baseTimeS × trafficFactor + riskPenaltyS`
  - `baseTimeS = lengthM / speed`. The speed is the OSM `maxspeed` tag (5–120 km/h), else the default below.
  - `trafficFactor` is 1.0 (free flow) until Phase 4 (TomTom), clamped to the range 1.0–4.0.
  - `riskPenaltyS`: HIGH_RISK +120 s, OPEN-with-moderate-risk +30 s (illustrative).
  - BLOCKED roads are never traversed.

**Default free-flow speeds (km/h) when `maxspeed` is missing** (urban Indian assumption, not measured):

| highway | km/h | highway | km/h |
|---|---|---|---|
| motorway | 80 | motorway_link | 50 |
| trunk | 60 | trunk_link | 40 |
| primary | 50 | primary_link | 35 |
| secondary | 40 | secondary_link | 30 |
| tertiary | 35 | tertiary_link | 25 |
| unclassified | 30 | residential / road | 25 |
| living_street / service | 15 | anything else | 25 |

## 5. Facilities

Names and locations are **real** (OSM `amenity=hospital|fire_station|police`, `healthcare=hospital`). Each one
is snapped to its nearest junction by brute force.

**Duplicate merging** (union-find, so merging is transitive): records of the same kind are merged when one
point is inside the other's building outline, when they are within 150 m with the same or similar name
(token sets equal, contained, or Jaccard ≥ 0.6), or when they are within 150 m and one is unnamed.

| | raw OSM records | after merging |
|---|---|---|
| Hospitals | 222 | **190** (11 merged inside an outline, 15 on a similar name, 7 unnamed nearby) |
| Fire stations | 6 | 5 |
| Police stations | 30 | 30 |

**Major hospitals (12):** the top-scoring hospitals. The score uses OSM `beds`, `emergency=yes`,
`healthcare:speciality`, the building footprint area, and a short list of well-known names. The result is
Sassoon (2 records), Deenanath Mangeshkar, Jehangir, KEM, Kamla Nehru, Poona Hospital, Ratna Memorial,
Ruby Hall, Sahyadri (2 branches) and Sancheti. Each one stores the reasons it was chosen
(`majorReasons`).

**Simulated** (fixed seed 2026):
- `bedsFree`
- the fleet:
  - each fire station: 2 fire trucks + 1 rescue boat
  - each police station: 1 ambulance
  - each major hospital: 1 ambulance

That is 57 units.

## 6. Algorithms and data structures

Every item also has an explanation card on `/algorithms`.

| Item | File | Complexity |
|---|---|---|
| Adjacency list (`Map` of arrays, shared road objects, lazy reverse adjacency) | `Graph.js` | O(1) avg vertex lookup |
| Binary min-heap | `MinHeap.js` | push/pop O(log n), peek O(1) |
| Dijkstra (lazy deletion, optional early stop, reverse mode) | `dijkstra.js` | O((V + E) log V) |
| A* (haversine ÷ V_MAX heuristic) | `astar.js` | O((V + E) log V) worst, far fewer nodes in practice |
| BFS (queue) / DFS (iterative, explicit stack) | `bfs.js`, `dfs.js` | O(V + E) |
| k-d tree (2-D, median split) | `kdtree.js` | build O(n log² n); nearest O(log n) avg |
| Haversine distance | `haversine.js` | O(1) |
| Emergency priority queue (binary max-heap) | `EmergencyPriorityQueue.js` | insert/extract O(log n) |
| Discrete-event queue (min-heap by time, FIFO ties) | `EventQueue.js` | push/pop O(log n) |
| Trip interpolation (prefix sums + binary search) | `trip.js` | build O(points), position O(log points) |

**Why A* is exact here:** V_MAX = max over all roads of (straight-line length ÷ baseTimeS), computed from the
data (85.2 km/h). Every road therefore costs at least `straight-line / V_MAX`, because traffic only slows
roads down and penalties are ≥ 0. With the triangle inequality, `h(v) = haversine(v, target) / V_MAX` is
consistent, so A* returns Dijkstra's optimal cost.

**Dijkstra early stop is optional:** it applies only when a `target` is given. A full run returns a
distance for all 7,695 junctions (tested).

## 7. Tests

`npm test` runs 70 tests in about 6 s. Reference comparisons:
- **Dijkstra and A*:**
  - vs Bellman-Ford on every pair of 30 random road graphs (one-way roads, traffic, closures)
  - A* vs Dijkstra on 500 random Pune pairs, and again after 300 random closures
  - a full Dijkstra run reaches all 7,695 junctions
- **Reverse Dijkstra:** equals the forward cost for every vertex.
- **BFS:** depth vs Bellman-Ford with unit costs.
- **DFS:** iterative visit order equals recursive DFS on 40 random graphs, and it doesn't overflow the stack
  on the Pune graph.
- **k-d tree:** vs brute force on random points and 500 Pune GPS points.
- **EventQueue:** vs a stable sort.
- **Trip:** binary search vs a linear scan.
- **Dispatch:**
  - the assigned unit's ETA equals the minimum A* time over all capable free units
  - the full lifecycle runs, and the arrival time equals the promised ETA
  - life-threatening cases go to a major hospital
  - when units are busy, waiting incidents are served by priority
  - re-assigning a returning unit ignores its stale arrival event
- **Real-data checks:**
  - the graph is strongly connected and road geometry is consistent
  - one-way streets are respected
  - facilities snap to existing junctions, and simulated values are flagged

## 8. Data sources and attribution

- Map data and tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). Standard
  OSM raster tiles are used lightly. The dark look is a CSS filter (CARTO's dark basemap now requires an API
  key). Tiles are never bulk-downloaded.
- Road network and facilities downloaded with OSMnx via the Overpass API, cached in `scripts/.osm_cache`.
- Later phases add: TomTom (traffic), OSRM public demo server (comparison only), SRTM (elevation), Open-Meteo
  Flood API.

### Regenerating the map data (optional)

`server/data/*.json` is committed, so the app runs offline. To rebuild it:

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r scripts/requirements.txt   # Windows (macOS/Linux: .venv/bin/python)
npm run data:graph && npm run data:facilities
```

Some Python packages are pinned to older versions because Windows Application Control blocked the newest
pandas/pyproj DLLs on the development machine.

## 9. Limitations (so far)

- Free-flow speeds and all unit/scene timings are assumptions. There is no live traffic until Phase 4.
- Assignment is greedy (nearest free unit) until Phase 3. There is no SOS clustering yet.
- Moving units are not re-routed if a road on their way closes (Phase 5).
- State lives in server memory: restarting the server clears incidents (event log and replay come in Phase 7).
- The Marathi and Hindi texts were written for the demo and should be checked by a native speaker.
