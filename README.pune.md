# Pune Live Rescue Dispatch

A disaster-rescue **dispatch simulation on the real road network of central Pune**. Data Structures course
project: all routing and spatial search is our own code (`shared/`). External services supply only map tiles
and raw OpenStreetMap data.

> **Demo simulation — in a real emergency call 112.** This app never contacts any emergency service.
> Hospital beds and every rescue vehicle are **simulated** values.

The plan of record is [PLAN.md](PLAN.md). Status: **Phase 1 (real Pune graph) done.**
The earlier fictional-city version ("Meridian") is kept, unused, in `legacy/meridian/`.

## 1. Run it

Requires Node.js 18+ (developed on Node 24). No keys or accounts needed.

```bash
npm install
npm run dev      # API on :3001 + web UI on http://localhost:5173
npm test         # node:test suite (algorithms + real-data checks)
npm run build    # production build into client/dist
npm start        # API + built UI together on http://localhost:3001
```

Using it: open the dashboard and click anywhere on the map to place an incident. The route from the chosen
station is drawn, with its ETA and an A* vs Dijkstra comparison. Click **Block** on a road of the route to
close it and watch the route change. Closed roads appear on the map and can be reopened. Demo deep link:
`/?incident=18.5074,73.8077` (Kothrud).

### Regenerating the map data (optional)

`server/data/*.json` is already generated and committed, so the app runs offline. To rebuild it:

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r scripts/requirements.txt   # Windows (macOS/Linux: .venv/bin/python)
npm run data:graph         # scripts/build_graph.py      -> server/data/pune-central.graph.json
npm run data:facilities    # scripts/build_facilities.py -> server/data/facilities.json
```

The scripts use OSMnx only to download and clean OSM data (no routing). Overpass mirrors are tried in turn,
and responses are cached in `scripts/.osm_cache`. Some Python packages are pinned to older versions because
Windows Application Control blocked the newest pandas/pyproj DLLs on the development machine.

## 2. Structure

```
shared/   pure JS, no React/DOM. Used by the server and the tests
  graph/     Graph.js MinHeap.js dijkstra.js astar.js bfs.js dfs.js
  dispatch/  EmergencyPriorityQueue.js requestConstants.js
  spatial/   kdtree.js haversine.js
server/   Express API (Socket.IO arrives in Phase 2)
  index.js config.js services/graphStore.js data/*.json
client/   React + Vite + Leaflet (react-leaflet)
  src/pages/Dispatcher.jsx  src/components/RescueMap.jsx SafetyBanner.jsx
scripts/  build_graph.py build_facilities.py osm_common.py run-python.mjs
tests/    *.test.js (node:test)
legacy/   previous fictional-city version, not built or tested
```

## 3. Road graph and cost model

- **Area** (`server/config.js` `DEMO_BBOX`): N 18.56, S 18.49, E 73.88, W 73.80. Covers Kothrud, Deccan,
  Shivajinagar, Swargate, Camp and the Mutha riverbank.
- **Source:** OpenStreetMap `network_type="drive"`, simplified, giving 7,695 junctions and 10,218 roads
  (775 km, 2,395 of them one-way). Only the **largest strongly connected component** is kept, so every
  junction can reach every other one while obeying one-way streets.
- **Two-way roads** are one road object shared by both directions of the adjacency list, so a closure
  affects both directions at once. **One-way** roads are stored only in their legal direction.
- **Edge cost (seconds)** = `baseTimeS × trafficFactor + riskPenaltyS`
  - `baseTimeS = lengthM / speed`. The speed is the OSM `maxspeed` tag (if between 5 and 120 km/h),
    otherwise the default for the road type below.
  - `trafficFactor` is 1.0 (free flow) for now. Live TomTom traffic arrives in Phase 4 and is clamped to
    the range 1.0–4.0.
  - `riskPenaltyS`: HIGH_RISK +120 s, OPEN-with-moderate-risk +30 s. These are illustrative simulation values.
  - `status`: OPEN | HIGH_RISK | BLOCKED. BLOCKED roads are never traversed.

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

**Facilities** (`facilities.json`): 204 hospitals, 5 fire stations and 30 police stations. Their names and
locations are **real** (OSM `amenity=hospital|fire_station|police`, `healthcare=hospital`). Each one is
snapped to its nearest junction by brute force. **Simulated** (fixed seed 2026):
- hospital `bedsFree`
- the fleet:
  - each fire station: 2 fire trucks + 1 rescue boat
  - each police station: 1 ambulance
  - 14 hospitals: 1 ambulance each

## 4. Algorithms and data structures

| Item | File | Complexity |
|---|---|---|
| Adjacency list (`Map` of arrays, shared road objects) | `Graph.js` | O(1) avg vertex lookup |
| Binary min-heap | `MinHeap.js` | push/pop O(log n), peek O(1) |
| Dijkstra (lazy deletion, early stop at target) | `dijkstra.js` | O((V + E) log V) |
| A* (haversine ÷ V_MAX heuristic) | `astar.js` | O((V + E) log V) worst, far fewer nodes in practice |
| k-d tree (2-D, median split) | `kdtree.js` | build O(n log² n); nearest O(log n) avg |
| Haversine distance | `haversine.js` | O(1) |
| BFS / DFS | `bfs.js`, `dfs.js` | O(V + E) |
| Emergency priority queue (binary max-heap) | `EmergencyPriorityQueue.js` | insert/extract O(log n) |

**Why A* is exact here:** V_MAX = max over all roads of (straight-line length ÷ baseTimeS). This is
computed from the data and is currently 85.2 km/h. Every road therefore costs at least
`straight-line / V_MAX`, because traffic only slows roads down and penalties are ≥ 0. Together with the
triangle inequality, this makes `h(v) = haversine(v, target) / V_MAX` consistent, so A* returns the same
optimal cost as Dijkstra. Example (Pune Main Fire Station → Kothrud): same 604.7 s cost, with A* settling
74% of the junctions Dijkstra settles.

**Nearest junction to a GPS point:** coordinates are projected to metres (equirectangular; distortion
< 0.1% over the area) and stored in the k-d tree.

## 5. Tests

`npm test` runs 51 tests in about 5 s. Reference comparisons:
- **Dijkstra vs Bellman-Ford:** every pair, on 30 random road graphs with one-way roads, traffic and closures.
- **A* vs Bellman-Ford:** the same random graphs.
- **A* vs Dijkstra on the real Pune graph:** 500 random pairs, with equal cost and fewer nodes settled for
  A*. Also checked again after 300 random closures and traffic changes.
- **k-d tree vs brute-force nearest:** random point sets of size 2–2000, including duplicates.
- **k-d tree on the real Pune graph:** 500 random GPS points against brute-force haversine.
- **withinRadius vs brute force.**
- **Real-data checks:**
  - the graph is strongly connected (forward and reverse BFS)
  - every road's geometry starts and ends on its junctions, and its length matches
  - one-way streets are never driven backwards
  - blocking a road on a route reroutes
  - facilities snap to existing junctions, and simulated values are flagged

## 6. Data sources and attribution

- Map data and tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). Standard
  OSM raster tiles are used lightly. The dark look is a CSS filter (CARTO's dark basemap now requires an API
  key). Tiles are never bulk-downloaded.
- Road network downloaded with OSMnx via the Overpass API.
- Later phases add: TomTom (traffic), OSRM public demo server (comparison only), SRTM (elevation), Open-Meteo
  Flood API.

## 7. Limitations (so far)

- Free-flow speeds are assumptions. There is no live traffic until Phase 4.
- Only roads inside the bounding box are included. A GPS point outside it snaps to the nearest junction
  at the edge.
- Snapping is to the nearest junction, not the nearest point on a road (median snap distance is 34 m for
  facilities).
