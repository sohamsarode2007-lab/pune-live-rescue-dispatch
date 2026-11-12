# Pune Live Rescue Dispatch

A disaster-rescue **dispatch simulation on the real road network of central Pune**. A person opens a page on
their phone and presses "I'm in danger". Their GPS location reaches the dispatcher dashboard in real time, a
rescue unit is assigned with our own graph algorithms, and the unit is shown driving there.

This is a Data Structures course project: all routing, assignment and spatial search is our own code
(`shared/`). External services supply only map tiles and raw OpenStreetMap data.

> **Demo simulation â€” in a real emergency call 112.** This app never contacts any emergency service.
> Hospital beds, every rescue vehicle and all unit timings are **simulated**.

The plan of record is [PLAN.md](PLAN.md). **Status: Phases 1â€“4 done** (real Pune graph, live SOS loop,
dispatch intelligence, live traffic + OSRM comparison).
The earlier fictional-city version ("Meridian") is kept, unused, in `legacy/meridian/`.

## 1. Run it

Requires Node.js 18+ (developed on Node 24).

The only key is optional: put `TOMTOM_API_KEY=...` in **`.env`** (git-ignored; copy `.env.example`, which must
stay without a real key because it is committed). Without a key the app runs fully: it uses the saved
traffic snapshot if there is one, otherwise free-flow, and says so on the dashboard.

```bash
npm install
npm run dev          # server on :3001 + web UI on http://localhost:5173 (hot reload)
npm test             # node:test suite: algorithms, real-data checks, dispatch simulation
npm run build        # production build into client/dist
npm start            # server + built UI together on http://localhost:3001
npm run check:sos    # end-to-end socket test against a running server (fake phone + dispatcher)
npm run check:browser  # real browser (Edge/Chrome) test of the SOS page with a faked GPS fix
node scripts/e2e-burst.mjs   # burst (greedy vs Hungarian) + SOS clustering against a running server
node scripts/find-burst-seed.mjs 300   # how the burst seed was chosen
node scripts/bench-burst.mjs 300       # greedy vs Hungarian on 300 seeds -> server/data/burst-benchmark.json
node scripts/e2e-traffic.mjs [--no-refresh]   # traffic refresh (~60 TomTom calls!), toggle, OSRM comparison
```

**Demo script for greedy vs optimal:**
1. Open the dispatcher, set **Traffic â†’ Free-flow** (the figures below are free-flow; with a live snapshot
   the ETAs, and so the totals, are different) and press **Reset**.
2. Leave the mode on **Hungarian** and press **Burst**. The "Greedy vs optimal" panel shows both plans for
   the same 8 incidents: greedy 48 min 03 s vs Hungarian 40 min 31 s total ETA, saving 7 min 32 s (15.7%),
   with the 4 swapped boats highlighted.
3. Press **Reset**, switch to **Greedy** and press **Burst** again. The numbers are identical (same seed, same
   units), but now the units follow the greedy plan.

**The demo pattern is not typical. It is the clearest of 300 random burst patterns.** Benchmark: every unit
at its station, free-flow, each pattern planned once both ways (`scripts/bench-burst.mjs`):

| | Seconds saved by Hungarian per burst | % of greedy total |
|---|---|---|
| Mean | 31.1 s | 1.6% |
| Median | 0 s | 0% |
| Min | 0 s | 0% |
| Max | 451.9 s (seed 92, the demo) | 18.4% (seed 75) |

- Hungarian was better on 116 of 300 patterns and equal on 184. It was **never worse** (tested on all 300).
- When greedy is worse, Hungarian saves 80.3 s (4.1%) on average.
- Typical bursts mix unit types, and most units are free, so greedy is often already optimal. The gap
  appears when a scarce unit type (here the 5 rescue boats) is contested.

| Page | URL | What it does |
|---|---|---|
| Dispatcher | `/` | Live incidents, units, waiting queue, sim speed, test SOS; Phase 1 route planner tab |
| SOS phone | `/sos` | Big "I'm in danger" button, type, severity, people; live unit and ETA. English / à¤®à¤°à¤¾à¤ à¥€ / à¤¹à¤¿à¤‚à¤¦à¥€ |
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
3. On the laptop open `https://<something>.ngrok-free.app/` (dispatcher). On the phone open `â€¦/sos`.
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
| phone â†’ server | `sos:new` | `{lat, lng, accuracyM, type, severity, people, clientId}`; ack `{ok, incident, unit}` or `{ok:false, error}` |
| phone â†’ server | `sos:watch` | re-join an incident's updates after a reload or reconnect |
| phone â†’ server | `road:report` | flooded-road report (stored now; Phase 5 needs 3 reports to close a road) |
| dispatcher â†’ server | `dispatch:join`, `sim:speed`, `sim:reset` | join live feed, set 1Ã—/5Ã—/10Ã—/30Ã—, clear |
| server â†’ clients | `incident:updated`, `unit:updated`, `unit:position`, `queue:updated`, `hospital:updated`, `hazard:updated`, `state:init` | live state |

Phones only receive updates for their own incident (Socket.IO rooms `inc:<id>`).

**Validation:**
- SOS points must be inside the demo area. Mumbai is rejected with `OUTSIDE_AREA`.
- Each connection may send at most one SOS every 3 s.
- Type, severity and people (1â€“50) are checked.

**Unit types:** medical â†’ ambulance, fire â†’ fire truck, flood â†’ rescue boat. Boats travel by road on a
trailer. A RETURNING unit counts as free: it finishes its current road, then re-routes from the next
junction.

**Unit lifecycle:** AVAILABLE â†’ EN_ROUTE â†’ ON_SCENE â†’ TO_HOSPITAL (ambulances) â†’ RETURNING â†’ AVAILABLE.
- Transitions are events in a **discrete-event queue** (min-heap by simulated time).
- A **sim clock** runs at 1Ã— (real time) by default. The dispatcher can switch to 5Ã—, 10Ã— or 30Ã—.
- Positions are interpolated along each trip with **prefix sums + binary search** and broadcast every 0.5 s.
- A road takes its routing cost in seconds, so the arrival time equals the promised ETA.
- Time on scene (simulated): medical 4 min, fire 10 min, flood 8 min.
- **Hospital choice:** the nearest hospital (Dijkstra) with free beds. For *life-threatening* incidents,
  only **major** hospitals are considered while one is reachable. A bed is taken on arrival.

## 3b. Dispatch intelligence (Phase 3)

1. **SOS clustering** (`shared/spatial/geohash.js`, `shared/dispatch/sosClusterer.js`)
   - A new call merges into an open incident of the **same type** within **100 m** and **5 min** of that
     incident's first call. People are summed (up to 200) and the highest severity is kept.
   - Candidates come from a geohash index (precision 7, cells about 145 Ã— 153 m): only the call's cell and
     its 8 neighbours are checked. Every cell is larger than 100 m, so nothing within 100 m is missed, even
     across a cell boundary.
   - Different types never merge, because they need different units.
2. **Priority with aging:** score = 5Â·severity + 2Â·min(people,10) + min(minutes waited,10), where minutes
   waited come from the sim clock. The max-heap is rebuilt every tick (0.5 s) and broadcast when the order
   or a score changes, so phones see their queue position move.
3. **Optimal assignment** (`shared/dispatch/hungarian.js`). Each **batch** (a new SOS, a burst, a freed unit,
   or a 30 s retry) builds one cost matrix:
   - **Rows:** pending incidents. If units are short, the top-k by priority per unit type, the same set for
     both plans.
   - **Columns:** free units.
   - **Cells:** ETA from one reverse Dijkstra per incident; âˆž for the wrong unit type or an unreachable unit.

   Both plans are computed from this one matrix:
   - **greedy:** incidents in priority order each take their nearest free unit. This is the Phase 2 rule,
     kept as the baseline.
   - **Hungarian:** most incidents served first, then minimum total ETA, in O(nÂ²Â·m).

   Both totals are recorded. The dispatcher's **mode** only decides which plan the units follow, so the
   comparison is always on identical inputs.
4. **Two-leg routing:** unit â†’ incident â†’ hospital.
   - The hospital leg is **previewed at assignment** (shown as "Leg 2 (planned)") and decided for real when
     the scene is cleared, because beds may have changed.
   - Best hospital = minimum ETA among hospitals with free beds; only **major** hospitals while one is
     reachable for life-threatening cases.
   - A bed is taken on arrival.
5. **Greedy vs optimal panel:**
   - total and average ETA of both plans for the latest batch (or any recent batch)
   - which unit each plan sends to each incident, with differences highlighted
   - cumulative totals over all batches
6. **Burst button:** 8 simultaneous incidents from a fixed seeded pattern (`server/services/burst.js`,
   seed 92), dispatched as one batch.
   - The seed was chosen with `scripts/find-burst-seed.mjs` as the clearest greedy/optimal gap among seeds
     1â€“300 with all units at their stations. 116 of the 300 seeds had greedy worse than optimal.
   - Pressing Burst again within 5 minutes merges the 8 calls into the existing incidents (clustering), so
     press **Reset** first.

Socket events added: `burst:create` (ack with created and merged ids and the comparison), `dispatch:mode`,
`comparison:updated`. The `sos:new` ack now includes `merged`.

## 3c. Live traffic and "our engine vs OSRM" (Phase 4)

1. **Traffic** (`server/services/trafficService.js`)
   - **Sample points:** 60 points on major roads (midpoints of the longest trunk, primary and secondary roads,
     at least 450 m apart, deterministic).
   - **Fetch:** for each point, TomTom *Traffic Flow Segment Data* (`flowSegmentData`) returns `currentSpeed`,
     `freeFlowSpeed` and the segment shape.
   - **Factor:** `trafficFactor = freeFlowSpeed / currentSpeed`, **clamped to [1.0, 4.0]**. A closure or a
     stopped road counts as 4. Because no road becomes faster than free flow, the A* heuristic stays
     admissible and A* stays exact. This is tested on 500 Pune pairs with a snapshot applied.
   - **Matching:** the segment shape is matched to our roads with **nearest-edge matching**
     (`shared/spatial/edgeMatcher.js`). TomTom segments are long: the first real fetch matched 630 roads from
     60 samples. Roads without a sample stay at 1.0.
   - **Direction:** a two-way road is one road object here, so one direction's factor applies to both.
2. **When it refreshes:** there is no timer.
   - When a dispatcher connects, it refreshes if the snapshot is missing or older than 15 min.
   - The **Refresh traffic** button refreshes on demand.
   - One refresh = 60 calls.
3. **Daily cap:** `ExternalCalls` checks the **200 TomTom calls/day** cap before every request. The count is
   saved to `server/data/external-calls.json` (UTC day, git-ignored), so a restart cannot reset it. The
   dashboard chip and the Traffic panel show the count live.
4. **Offline:** every successful fetch is saved to `server/data/traffic-snapshot.json` (committed) and loaded
   on startup. The dashboard shows **"Traffic as of <time>"** (IST), adds "(saved snapshot)" when the data was
   loaded from disk, and shows "free-flow" otherwise. Failed or capped fetches keep the previous snapshot,
   and error messages never include the key.
5. **Live traffic / Free-flow toggle:** switches every factor between the snapshot and 1.0. Routes, dispatch
   ETAs and the Hungarian matrix all follow the toggle.
6. **Traffic colours:** an optional map layer colours the sampled roads green (< 1.25Ã—), orange (1.25â€“2Ã—) or
   red (â‰¥ 2Ã—).
7. **Our engine vs OSRM** (`osrmService.js`, `compareService.js`)
   - **Where:** for the selected dispatch (unit start junction â†’ incident) or the planner route, on request.
   - **Same endpoints:** OSRM is asked for the same snapped junctions as our engine.
   - **Rate limit and cache:** at most **1 request per second** (queued), responses cached for 1 h and
     failures for 30 s, with an 8 s timeout.
   - **If OSRM is unreachable:** the panel says *"OSRM comparison unavailable: â€¦"* and still shows our route.
   - **On the map:** ours is cyan (labelled live traffic or free-flow); OSRM is purple dashed (labelled
     *normal traffic*).
   - **Log:** every comparison is appended to `server/data/osrm-comparisons.jsonl` (git-ignored), and the
     panel shows the running mean % difference for the report.
   - **First real runs** (Shaniwar Wada â†’ Kothrud, 6.3 km): ours 460 s at free-flow and 492 s with live
     traffic, vs OSRM 408 s. Fire Station â†’ Kothrud: ours 10 min 45 s vs OSRM 9 min 21 s (+15%). Our default
     speeds are lower than OSRM's car profile.
8. **Not done:** PLAN.md's optional TomTom raster-tile overlay. The coloured sampled roads cover the same need
   without exposing the key to the browser or spending tile quota.

Socket events added: `traffic:refresh`, `traffic:mode`, `traffic:updated`, `external:calls`.
REST added: `GET /api/traffic`, `/api/compare`, `/api/compare/summary`, `/api/burst-benchmark`.

**Rehearsing without spending TomTom calls:** start the server with `TOMTOM_DISABLED=1`. The saved snapshot is
still used and no request is made. In PowerShell: `$env:TOMTOM_DISABLED='1'; npm start`. Setting
`TOMTOM_API_KEY` to an empty string does **not** work there, because PowerShell deletes the variable and the
key is read from `.env` again.

## 3d. Network resilience: Tarjan (PLAN.md Phase 6 item 3, done before Phase 5)

1. **Single points of failure** (`shared/graph/tarjan.js`)
   - **Algorithm:** an **iterative** Tarjan (an explicit stack, because recursion would overflow on 7,695
     junctions) finds bridges and articulation points on the **undirected** road graph. Closed roads are left
     out, and parallel roads are never bridges.
   - **Cut-off analysis:** the same pass accumulates subtree sizes and facility counts. For each bridge or
     articulation point it reports the junctions cut off (the smaller side), the facilities inside that part,
     and the facility kinds it can no longer reach.
   - **On Pune:** 2,140 bridges and 1,795 articulation points in about 60 ms. Only **54 + 53 are critical**
     (cut off â‰¥ 50 junctions or any facility). The other ~3,800 are dead-end lanes; the Network tab hides
     them by default, says how many it filtered, and has a toggle to show them all.
   - **No single road cuts off 50 or more junctions** (the largest cut-off is 49). Every critical item is
     critical because a hospital or station would be stranded behind it.
2. **Trap zones:** Tarjan **SCC** on the directed graph (one-way streets, closures) runs after every
   closure, reopening and traffic change.
   - Every SCC except the main one is a zone, labelled from the condensation edges: **trap** (can be entered
     but not left), **no-entry** (can be left but not entered), **isolated** or **passage**.
   - The dispatcher shows a warning on every tab with each zone's size and the facilities inside it, and draws
     the zones on the map.
   - Example: closing Shankarao Gaikwad Path isolates 12 junctions including a hospital.
3. **River crossings** (`server/services/networkService.js`)
   - **Finding them:** the graph export now keeps OSM `bridge=*`. `scripts/build_river.py` saves the
     river lines (`server/data/river.json`). A crossing is a bridge road whose shape intersects the Mutha or
     Mula-Mutha line. Hits within 150 m of each other are grouped into one physical bridge.
   - **Result:** **9 crossings** with their real names (Sambhaji, Shivaji, New Sangam, Baba Bhide,
     Chhatrapati Shahu Setu, â€¦).
4. **Crossing importance:** each crossing is removed alone (its roads excluded from the search; the graph is
   not modified), then multi-source Dijkstra measures:
   - response time from the **5 fire stations** (fire trucks and rescue boats), and from all 47 unit bases;
   - time from each junction to the nearest **major** hospital.

   The ranking is by the increase in average fire-station response. Clicking a crossing shows: *"If this
   floods: +X average and +Y worst-case fire-station response, up to +Z at the worst-hit junction;
   N junctions lose major-hospital access within 8 min"*, with a button to close it.

   Two deliberate choices, because the literal metrics come out flat:
   - **Fire stations, not all bases:** with 47 bases on both banks, almost every junction's nearest base is on
     its own side, so the all-bases average barely moves (+0 s). It is still shown alongside.
   - **Major hospitals only:** there are 189 hospitals, many of them small clinics, so every junction is within
     8 min of *some* hospital.
5. **Findings (live traffic snapshot):**
   - **New Sangam Bridge ranks first:** +4 s average fire response, +3 min 54 s at the worst-hit junction, and
     1 junction loses major-hospital access.
   - **Raveendra Mhatre (+3 s) and Sambhaji (+1 s)** follow.
   - **No single crossing changes the worst case,** because the 9 crossings back each other up.
   - **Recomputation:** the ranking updates automatically (debounced) after closures, so the Phase 5 flood
     will move it.

REST: `GET /api/network/spof`, `/api/network/scc`, `/api/network/crossings`, `/api/rivers`,
`POST /api/crossings/:id/status`. Socket: `network:updated`.

## 4. Road graph and cost model

- **Area** (`server/config.js` `DEMO_BBOX`): N 18.56, S 18.49, E 73.88, W 73.80. Covers Kothrud, Deccan,
  Shivajinagar, Swargate, Camp and the Mutha riverbank.
- **Source:** OpenStreetMap `network_type="drive"`, simplified, giving 7,695 junctions and 10,218 roads
  (775 km, 2,395 of them one-way). Only the largest strongly connected component is kept, so every junction
  can reach every other one while obeying one-way streets.
- **Two-way roads** are one road object shared by both directions, so a closure affects both. **One-way**
  roads are stored only in their legal direction.
- **Edge cost (seconds)** = `baseTimeS Ã— trafficFactor + riskPenaltyS`
  - `baseTimeS = lengthM / speed`. The speed is the OSM `maxspeed` tag (5â€“120 km/h), else the default below.
  - `trafficFactor` is 1.0 (free flow) until Phase 4 (TomTom), clamped to the range 1.0â€“4.0.
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

**Duplicate merging** (union-find, so merging is transitive): records of the same kind are merged when:
- one point is inside the other's building outline, or
- they are within 150 m with the same or similar name (token sets equal, contained, or Jaccard â‰¥ 0.6), or
- they are within 150 m and one is unnamed, or
- a documented manual same-place rule applies. There is one: the Sassoon General Hospital campus, mapped as
  "B.J. Medical College and Sassoon Hospital" and "David Sassoon Hospital".

| | raw OSM records | after merging |
|---|---|---|
| Hospitals | 222 | **189** (11 merged inside an outline, 15 on a similar name, 7 unnamed nearby, 1 by the Sassoon rule) |
| Fire stations | 6 | 5 |
| Police stations | 30 | 30 |

**Major hospitals (12):** the top-scoring hospitals. The score uses OSM `beds`, `emergency=yes`,
`healthcare:speciality`, the building footprint area, and a short list of well-known names. The result is
Sassoon, Deenanath Mangeshkar, Jehangir, KEM, Kamla Nehru, Poona Hospital, Ratna Memorial, Ruby Hall,
Sahyadri (2 branches), Sancheti and Sardar Patel Cantonment General Hospital. Each one stores the reasons
it was chosen (`majorReasons`).

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
| A* (haversine Ã· V_MAX heuristic) | `astar.js` | O((V + E) log V) worst, far fewer nodes in practice |
| BFS (queue) / DFS (iterative, explicit stack) | `bfs.js`, `dfs.js` | O(V + E) |
| k-d tree (2-D, median split) | `kdtree.js` | build O(n logÂ² n); nearest O(log n) avg |
| Haversine distance | `haversine.js` | O(1) |
| Emergency priority queue (binary max-heap) | `EmergencyPriorityQueue.js` | insert/extract O(log n) |
| Geohash encode/decode + 3Ã—3 neighbour lookup (spatial hash grid) | `geohash.js` | O(precision); query O(1 + hits) |
| SOS clustering (geohash candidates + haversine, 100 m / 5 min) | `sosClusterer.js` | O(1 + calls in 9 cells) per call |
| Hungarian algorithm (potentials, rectangular, âˆž = impossible) | `hungarian.js` | O(nÂ²Â·m), n â‰¤ m |
| Traffic-weighted edges (factor in [1, 4], snapshot apply) | `Graph.js`, `trafficService.js` | apply O(roads); routing unchanged |
| Nearest-edge matching (sampled shapes in a k-d tree + exact point-to-segment) | `edgeMatcher.js` | build O(S logÂ² S); query O(log S + candidates) |
| Tarjan bridges + articulation points (iterative, with cut-off sizes/facilities) | `tarjan.js` | O(V + E) |
| Tarjan SCC (iterative) + trap-zone classification on the condensation | `tarjan.js` | O(V + E) |
| Multi-source Dijkstra (all sources at cost 0; forward or reverse) | `dijkstra.js` | O((V + E) log V) |
| River crossing importance (segment intersection + 3 multi-source runs per crossing) | `networkService.js` | O(CÂ·(V + E) log V) |
| Greedy assignment (priority order, nearest free unit) | `hungarian.js` | O(nÂ·m) |
| Priority aging (heap rebuilt every tick) | `dispatchService.js` | O(p log p) per tick |
| Discrete-event queue (min-heap by time, FIFO ties) | `EventQueue.js` | push/pop O(log n) |
| Trip interpolation (prefix sums + binary search) | `trip.js` | build O(points), position O(log points) |

**Why A* is exact here:** V_MAX = max over all roads of (straight-line length Ã· baseTimeS), computed from the
data (85.2 km/h). Every road therefore costs at least `straight-line / V_MAX`, because traffic only slows
roads down and penalties are â‰¥ 0. With the triangle inequality, `h(v) = haversine(v, target) / V_MAX` is
consistent, so A* returns Dijkstra's optimal cost.

**Dijkstra early stop is optional:** it applies only when a `target` is given. A full run returns a
distance for all 7,695 junctions (tested).

## 7. Tests

`npm test` runs 116 tests in about 25 s. The 300-seed burst benchmark takes most of that time.

Tarjan / network reference comparisons:
- **Bridges and articulation points:** equal to brute force (remove each road / junction, count components)
  on 60 random graphs with dead-end chains, one-way roads, closures and a parallel road. The cut-off sizes and
  facility counts match too.
- **SCC:** equal to brute-force mutual reachability on 40 random directed graphs.
- **Trap zones:** trap, no-entry and isolated are each classified correctly.
- **Multi-source Dijkstra:** equals the minimum of single-source runs (forward and reverse).
- **Pune:**
  - Tarjan runs deep (stack > 500) without overflow
  - the network is one SCC when every road is open
  - the crossing importance equals a brute-force recomputation with the crossing really closed
  - ranking never modifies the graph
  - closing a critical bridge creates an isolated zone of exactly the predicted size

Phase 4 reference comparisons (no network needed: TomTom and OSRM are faked in the tests):
- **A* vs Dijkstra:** equal on 500 random Pune pairs with a traffic snapshot applied (factors 1â€“4 incl.
  clamped values). Traffic is shown to change some routes.
- **Traffic factor:** freeFlow/current is clamped to [1, 4] (0.83 â†’ 1, 10 â†’ 4, a closure or a stopped road â†’ 4).
- **Refresh:**
  - only matched roads change
  - the snapshot is saved, and on restart it is reloaded with no fetch and identical factors
  - the live/free-flow toggle works
- **Daily cap:**
  - it stops exactly at the cap and refuses afterwards
  - the counter survives a restart
  - a new UTC day resets it
- **Failures:** HTTP errors and network errors keep the old snapshot and never expose the key. With no key,
  nothing is fetched.
- **Nearest-edge matching:** equals a brute-force scan of every road, on a random graph and on Pune (incl.
  points at the middle of the 30 longest roads).
- **OSRM:**
  - requests sent together are spaced by the minimum interval
  - a repeated route is served from the cache
  - an unreachable server, an HTTP 429 or a timeout gives `{available: false, reason}`
  - a failure is cached briefly
  - the comparison uses the same snapped junctions, computes the % difference and logs only successful
    comparisons
- **Burst benchmark:** on all 300 seeds Hungarian never serves fewer incidents and its total is never worse,
  and the demo seed has the largest saving.

Phase 3 reference comparisons:
- **Hungarian vs brute force over all permutations, n â‰¤ 6:**
  - square matrices
  - rectangular matrices, with more units than incidents and fewer
  - impossible pairs (âˆž, wrong unit type), checking the number served and the total cost
- **Hungarian vs greedy:** never worse in 300 random cases, plus a hand-made counter-example where greedy loses.
- **Geohash:**
  - matches the published reference value
  - the 3Ã—3 block contains every point within 100 m (2,000 random pairs)
  - the index finds every point the brute-force scan finds
- **Clustering:**
  - calls 30 m apart merge
  - calls 120 m apart do not
  - calls across a cell boundary merge (found through the neighbour check)
  - no merge after 5 min, and never across incident types
- **Service:**
  - the burst serves 8 incidents with Hungarian clearly better than greedy, and executed ETAs sum to the
    recorded total
  - greedy mode follows the greedy plan with identical comparison numbers
  - aging re-scores the queue over sim time (an old LOW call overtakes a fresh MEDIUM one)
  - the two-leg preview picks a major hospital for life-threatening cases

Earlier reference comparisons:
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

- Map data and tiles Â© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). Standard
  OSM raster tiles are used lightly. The dark look is a CSS filter (CARTO's dark basemap now requires an API
  key). Tiles are never bulk-downloaded.
- Road network and facilities downloaded with OSMnx via the Overpass API, cached in `scripts/.osm_cache`.
- Live traffic: **TomTom** Traffic Flow Segment Data (free tier, no card). The server-side key is in `.env`,
  calls are capped at 200/day, and `traffic-snapshot.json` contains TomTom-derived speeds.
- Comparison baseline: **OSRM** public demo server (`router.project-osrm.org`), max 1 request/s, cached,
  never presented as our route.
- Later phases add: SRTM (elevation), Open-Meteo Flood API.

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

- Free-flow speeds and all unit/scene timings are assumptions.
- **Traffic covers 60 sample points:**
  - roads they don't reach stay at free flow
  - the factor applies to both directions of a two-way road
  - in-progress trips keep the timing they started with
- OSRM's speed profile differs from our default speeds, so part of the ETA difference is the speed model,
  not traffic.
- The Hungarian plan minimises the total ETA of the incidents being served. Which incidents are served when
  units are short is decided by priority, not by the optimisation.
- Clustering compares a call with the incident's first call position (not a moving cluster centre).
- Moving units are not re-routed if a road on their way closes (Phase 5).
- State lives in server memory: restarting the server clears incidents (event log and replay come in Phase 7).
- The Marathi and Hindi texts were written for the demo and should be checked by a native speaker.
