# Pune Live Rescue Dispatch

A disaster-rescue **dispatch simulation on the real road network of central Pune**. A person opens a page on
their phone and presses "I'm in danger". Their GPS location reaches the dispatcher dashboard in real time, a
rescue unit is assigned with our own graph algorithms, and the unit is shown driving there.

This is a Data Structures course project: all routing, assignment and spatial search is our own code
(`shared/`). External services supply only map tiles and raw OpenStreetMap data.

> **Demo simulation — in a real emergency call 112.** This app never contacts any emergency service.
> Hospital beds, every rescue vehicle and all unit timings are **simulated**.

The plan of record is [PLAN.md](PLAN.md). **Status: all 7 phases done.**
- real Pune graph
- live SOS loop
- dispatch intelligence
- live traffic + OSRM comparison
- flood realism + rerouting
- planning tools (coverage, station placement, single points of failure, evacuation flow)
- evaluation (benchmarks, load test, event log + replay)

**Demo in one click:** open the dispatcher and press **▶ Monsoon flood demo** (Live dispatch → Simulation).
See [section 3f](#3f-planning-tools-and-the-one-click-demo-phase-6), the timed demo script in
[DEMO.md](DEMO.md) and the oral-exam notes in [VIVA.md](VIVA.md). If anything fails during a demo, `/replay`
plays a saved recording of the whole scenario with no network.
The earlier fictional-city version ("Meridian") is kept, unused, in `legacy/meridian/`.

## 1. Run it

Requires Node.js 18+ (developed on Node 24).

The only key is optional: put `TOMTOM_API_KEY=...` in **`.env`** (git-ignored; copy `.env.example`, which must
stay without a real key because it is committed). Without a key the app runs fully: it uses the saved
traffic snapshot if there is one, otherwise free-flow, and says so on the dashboard. **TomTom is never called
automatically**: not on startup, not when a dispatcher connects, not on a timer. Only the **Refresh traffic**
button calls it, after a confirmation that shows how many of today's calls it will use. For development and
rehearsals, start the server with `TOMTOM_DISABLED=1`.

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
node scripts/e2e-flood.mjs     # flood rise -> closures, reroutes, ranking, trap zones; crowd reports; recede
node scripts/e2e-scenario.mjs 70   # one-click monsoon demo, watched for 70 s (flood, coverage, reroutes)
node scripts/bench.mjs             # all benchmarks -> /benchmarks page and the README tables (2-4 min)
node scripts/sos-bots.mjs 100      # load test: 100 simulated phones over Socket.IO (server must be running)
node scripts/record-demo.mjs       # re-record the saved replay server/data/replays/monsoon-demo.jsonl
```

**Demo script for greedy vs optimal:**
1. Open the dispatcher, set **Traffic → Free-flow** (the figures below are free-flow; with a live snapshot
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
shared/   pure JS algorithms, no React/DOM. Used by the server, the client and the tests
  graph/     Graph MinHeap dijkstra astar bfs dfs tarjan kcenter
  dispatch/  EmergencyPriorityQueue requestConstants hungarian sosClusterer
  spatial/   kdtree haversine geohash edgeMatcher
  flow/      edmondsKarp
  sim/       EventQueue simClock trip floodModel random
server/   Express + Socket.IO
  index.js config.js
  services/  graphStore dispatchService burst burstBenchmark trafficService osrmService compareService
             externalCalls networkService floodService crowdReports planningService scenario eventLog
  data/      pune-central.graph.json facilities.json river.json elevation.json flood-*.json
             traffic-snapshot.json burst-benchmark.json benchmarks.json sos-bots-result.json
             replays/monsoon-demo.jsonl   (all generated, committed so the app runs offline)
  logs/      session event logs (git-ignored)
client/   React + Vite + Leaflet (react-leaflet)
  src/pages/  Dispatcher SOS Algorithms Replay Benchmarks
  src/components/  maps, panels (traffic, flood, network, planning, comparison)
  src/data/algorithmInfo.js   explanation cards shown on /algorithms
scripts/  data: build_graph build_facilities build_shelters build_river build_elevation (Python, OSMnx)
          checks: e2e-* browser-check bench sos-bots record-demo find-burst-seed bench-burst
tests/    *.test.js (node:test)
legacy/   previous fictional-city version, not built or tested
DEMO.md   7-8 minute demo script with fallbacks · VIVA.md  algorithms, assumptions, likely questions
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

**Unit types:** medical → ambulance, fire → fire truck, flood → rescue boat. Boats travel by road on a
trailer. A RETURNING unit counts as free: it finishes its current road, then re-routes from the next
junction.

**Unit lifecycle:** AVAILABLE → EN_ROUTE → ON_SCENE → TO_HOSPITAL (ambulances) → RETURNING → AVAILABLE.
- Transitions are events in a **discrete-event queue** (min-heap by simulated time).
- A **sim clock** runs at 1× (real time) by default. The dispatcher can switch to 5×, 10× or 30×.
- Positions are interpolated along each trip with **prefix sums + binary search** and broadcast every 0.5 s.
- A road takes its routing cost in seconds, so the arrival time equals the promised ETA.
- Time on scene (simulated): medical 4 min, fire 10 min, flood 8 min.
- **Hospital choice:** the nearest hospital (Dijkstra) with free beds. For *life-threatening* incidents,
  only **major** hospitals are considered while one is reachable. A bed is taken on arrival.

## 3b. Dispatch intelligence (Phase 3)

1. **SOS clustering** (`shared/spatial/geohash.js`, `shared/dispatch/sosClusterer.js`)
   - A new call merges into an open incident of the **same type** within **100 m** and **5 min** of that
     incident's first call. People are summed (up to 200) and the highest severity is kept.
   - Candidates come from a geohash index (precision 7, cells about 145 × 153 m): only the call's cell and
     its 8 neighbours are checked. Every cell is larger than 100 m, so nothing within 100 m is missed, even
     across a cell boundary.
   - Different types never merge, because they need different units.
2. **Priority with aging:** score = 5·severity + 2·min(people,10) + min(minutes waited,10), where minutes
   waited come from the sim clock. The max-heap is rebuilt every tick (0.5 s) and broadcast when the order
   or a score changes, so phones see their queue position move.
3. **Optimal assignment** (`shared/dispatch/hungarian.js`). Each **batch** (a new SOS, a burst, a freed unit,
   or a 30 s retry) builds one cost matrix:
   - **Rows:** pending incidents. If units are short, the top-k by priority per unit type, the same set for
     both plans.
   - **Columns:** free units.
   - **Cells:** ETA from one reverse Dijkstra per incident; ∞ for the wrong unit type or an unreachable unit.

   Both plans are computed from this one matrix:
   - **greedy:** incidents in priority order each take their nearest free unit. This is the Phase 2 rule,
     kept as the baseline.
   - **Hungarian:** most incidents served first, then minimum total ETA, in O(n²·m).

   Both totals are recorded. The dispatcher's **mode** only decides which plan the units follow, so the
   comparison is always on identical inputs.
4. **Two-leg routing:** unit → incident → hospital.
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
     1–300 with all units at their stations. 116 of the 300 seeds had greedy worse than optimal.
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
2. **When it refreshes: manual only.**
   - The **Refresh traffic** button is the only trigger. There is no refresh on startup, on connect or on a
     timer (tested).
   - The button first confirms the cost. A second refresh within 15 min of the last one needs another
     confirmation.
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
6. **Traffic colours:** an optional map layer colours the sampled roads green (< 1.25×), orange (1.25–2×) or
   red (≥ 2×).
7. **Our engine vs OSRM** (`osrmService.js`, `compareService.js`)
   - **Where:** for the selected dispatch (unit start junction → incident) or the planner route, on request.
   - **Same endpoints:** OSRM is asked for the same snapped junctions as our engine.
   - **Rate limit and cache:** at most **1 request per second** (queued), responses cached for 1 h and
     failures for 30 s, with an 8 s timeout.
   - **If OSRM is unreachable:** the panel says *"OSRM comparison unavailable: …"* and still shows our route.
   - **On the map:** ours is cyan (labelled live traffic or free-flow); OSRM is purple dashed (labelled
     *normal traffic*).
   - **Log:** every comparison is appended to `server/data/osrm-comparisons.jsonl` (git-ignored), and the
     panel shows the running mean % difference for the report.
   - **First real runs** (Shaniwar Wada → Kothrud, 6.3 km): ours 460 s at free-flow and 492 s with live
     traffic, vs OSRM 408 s. Fire Station → Kothrud: ours 10 min 45 s vs OSRM 9 min 21 s (+15%). Our default
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
   - **On Pune (every road open):** 2,141 bridges and 1,797 articulation points in about 50 ms. Only
     **55 + 55 are critical**
     (cut off ≥ 50 junctions or any facility). The other ~3,800 are dead-end lanes; the Network tab hides
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
     Chhatrapati Shahu Setu, …).
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

## 3e. Flood realism and rerouting (Phase 5)

> **Simplified model, not a hydrological prediction.** It uses SRTM elevation, the OSM river line and a BFS
> spread. It answers "which roads would close in roughly which order if the Mutha rose by L metres", for a
> dispatch demo.

1. **Elevation:** `scripts/build_elevation.py` (Python `srtm.py`, which downloads the SRTM tile once and works
   offline after that) writes `server/data/elevation.json`. That file has every junction (535–662 m) and every
   river point. The server only reads it.
2. **Flood model** (`shared/sim/floodModel.js`)
   - **River profile:** the Mutha and Mula-Mutha lines are densified every 50 m. OSM draws waterways in flow
     direction, so their SRTM elevations are smoothed to never rise downstream.
   - **Eligibility:** each junction finds its nearest river point (k-d tree). It is eligible if it is within
     1.5 km of the river and lower than *river elevation + L*.
   - **Spread:** a **multi-source BFS** starts from eligible junctions within 100 m of the river and moves
     through eligible junctions only. A low hollow with no low path to the river stays dry.
   - **Timing:** BFS level k floods at k × 90 s of sim time, so the flood visibly grows.
   - **Road statuses:** roads touching flooded junctions → **BLOCKED**. Roads touching junctions about to
     flood, next to the flood, or within 1 m of the flood level → **HIGH_RISK**.
   - **Scale on Pune:** 10 m floods 124 junctions and closes 200 roads over about 8 sim-min. 12 m floods
     about 260.
3. **The flood on the live network** (`floodService.js`)
   - The "**Khadakwasla dam release**" slider (0–12 m) sets the level.
   - Each tick applies only the closures due at the current sim time. It touches only roads the flood itself
     changed, so a receding flood never reopens a manual or crowd closure.
   - Every flood change triggers rerouting, the Tarjan SCC trap-zone check and a (debounced) re-ranking of the
     river crossings. At 10 m, 6 of the 9 bridges go under water, New Sangam becomes the most critical
     remaining crossing (+9 s), and worst-case fire response grows from 12 min 53 s to about 22 min 40 s.
4. **Real trigger:** the **Open-Meteo Flood API** (GloFAS river discharge, free, no key) for the Mutha at the
   Sangam.
   - Today's peak over the past 3 and next 7 days is compared with that cell's own daily history since 1984.
   - **normal** (< p90) → 0 m, **elevated** (p90–p99) → 4 m, **flood alert** (≥ p99) → 8 m. This sets the
     initial level at startup; the slider can still override it.
   - Responses are cached to disk (history once; the current figure for 6 h), so it also works offline.
   - **On 12 Nov 2026:** normal (peak 10.2 m³/s vs p90 168 and p99 801).
   - **GloFAS is a coarse (~5 km) global model and does not capture Khadakwasla dam releases, which is why the
     manual slider exists.** The UI says this too.
5. **Dynamic rerouting:** when any closure (flood, crowd, crossing, manual) hits a road a moving unit has not
   reached yet, the unit finishes its current road, then re-plans with A* from the next junction.
   - The reroute is broadcast and shown as ↻ on the map, in the Reroutes log, and on the phone's ETA.
   - If the destination is unreachable: the incident returns to the priority queue, a patient goes to another
     hospital, or a returning unit waits.
   - Live check: closing a road on FT-7's route rerouted it immediately (+65 s).
6. **Crowd road reports:** the SOS page has a "Report a flooded road" button (GPS or tap, three languages).
   - The report is snapped to the nearest road (nearest-edge matching).
   - The road closes only after **3 reports from different phones within 15 min** (wall-clock time).
   - The dispatcher map shows reported roads in yellow, dashed until they close.
7. **Trap-zone warnings during a flood:** many flooded junctions end up as one-junction "components". The
   warning lists only zones of ≥ 3 junctions or with a facility inside (e.g. "Shaniwar Peth Police Chowki
   completely cut off") and counts the rest.

Socket events: `flood:set`, `flood:glofas`, `flood:updated`, `crowd:updated`, `unit:rerouted`.
REST: `GET /api/flood`, `/api/crowd`.

## 3f. Planning tools and the one-click demo (Phase 6)

1. **Shelters** (`scripts/build_shelters.py`)
   - **Why these buildings:** OSM rarely tags flood shelters in India. In practice Pune moves flood-affected
     families into schools and municipal halls, so OSM `amenity=school|college|university|community_centre|townhall`
     are used.
   - **Result:** 263 raw records merge into **254 shelters** (135 schools, 96 colleges/universities,
     21 community halls, 2 municipal halls), each snapped to a junction.
   - **Capacities are simulated** by type: school 300, college 500, community hall 150, municipal hall 200
     (92,050 in total). They are labelled "simulated" in the UI.
   - **Facilities:** shelters count as facilities in the Tarjan cut-off and trap-zone analyses (e.g. "contains
     3 shelters: COEP …").
   - **Other facilities untouched:** hospitals, stations and units are unchanged (the script only adds shelters).
2. **Coverage isochrones**
   - **Method:** multi-source Dijkstra from the 5 fire stations, and separately from the 42 ambulance bases, on
     the *current* network. Every road is coloured < 5 / 5–8 / 8–12 / > 12 min / unreachable / closed.
   - **% of road length within 8 min:** fire stations 89.5%, ambulances 100% (free-flow).
   - **Recomputed on every closure.** In the demo, fire coverage shrinks from 89.5% to about 81.5% as the
     water reaches 10 m, with a sparkline of the history.
3. **New station placement (greedy k-center)**
   - **Candidates:** Gonzalez farthest-first picks plus the worst-served junctions, about 120 (116 after
     duplicates are removed).
   - **Choice:** best-improvement greedy, i.e. the candidate with the smallest new worst case (one Dijkstra per
     candidate).
   - **Two scenarios:** run for **normal** (every road open) and for the **fully spread 10 m flood** (its exact
     BLOCKED / HIGH_RISK statuses, applied temporarily and restored). Both use the traffic state at startup.
   - **The suggestions differ:**

     | | Suggested site | Worst-case fire response | Roads ≤ 8 min |
     |---|---|---|---|
     | Normal | near Diversion (SPPU / north-west) | 12 min 53 s → 9 min 05 s | 88.2% → 99.1% |
     | 10 m flood | a different junction | 23 min 13 s → 22 min 24 s | 82.4% → 91.6% |

   - **Why the flood barely moves the worst case:** the slowest junction under the flood is cut off behind the
     water, so no single new station fixes it. The average and the coverage still improve.
4. **Evacuation feasibility (Edmonds-Karp)**
   - **Network:** super-source → the 351 junctions that the 10 m flood floods or endangers (250 people each,
     simulated; ~87,750 people) → roads → shelters → super-sink.
   - **Road capacities:** PLAN.md's vehicles/hour (trunk 2,000; primary/secondary 1,200; tertiary/residential
     400; HIGH_RISK 50%) × 4 people/vehicle × a 1-hour window. Two-way roads are two opposite edges.
   - **Shelter capacities:** the simulated values above.
   - **Results:**

     | | Evacuable | Boat-only | Min cut |
     |---|---|---|---|
     | Normal | 78,850 (89.9%) | 0 | 14 roads (35,200) + shelters (43,650) |
     | 10 m flood | 50,000 (57%) | 31,250 | 7 roads (7,200) + shelters + people already out |

   - **Bottlenecks:** the min-cut roads (Ganeshkhind Road, Karve Road, … normally; Sinhagad Road … under the
     flood) are drawn in magenta.
   - **Max-flow = min-cut** is asserted on the real data.
5. **▶ Monsoon flood demo** (`server/services/scenario.js`), one click:
   - **Setup:** reset incidents, closures, crowd reports and the flood; **free-flow** traffic; **10×** speed;
     Hungarian dispatch.
   - **Flood:** the Mutha rises **0 → 10 m** in 2 m steps every 2 sim-minutes.
   - **SOS calls:** **12 seeded calls on both banks** (250–900 m from the river, ≥ 300 m apart, so none merge)
     over 11 sim-minutes.
   - **Scripted event:** at sim 5:00, **police close New Sangam Bridge** as the Mula-Mutha rises. In this
     seeded run fire truck FT-2 is driving to INC-005 over it, so the demo always shows a reroute
     (+5 min 53 s).
   - **What it shows:** the flood spreading, bridges closing, rerouting, trap-zone warnings, and coverage
     shrinking, with no manual setup.
   - **Determinism:** the server now advances simulated time by a **fixed step per tick** (not measured wall
     time), so the scenario plays out identically every time. A test runs it twice headless and compares
     every incident, assignment, reroute and the flood state.

Socket events: `scenario:start`, `scenario:updated`, `coverage:updated`, `planning:updated`.
REST: `GET /api/coverage?kind=fire|ambulance`, `/api/geometry/roads`, `/api/placement`, `/api/evacuation`,
`/api/shelters`, `/api/scenario`.

## 3g. Evaluation: benchmarks, load test, event log and replay (Phase 7)

### Benchmarks

<!-- BENCHMARKS:START -->
Generated by `node scripts/bench.mjs` on 2026-11-12 (Intel(R) Core(TM) Ultra 5 225U, 14 threads, Node v24.21.0); took 162.4 s. Also shown on `/benchmarks`.

**Shortest paths: Dijkstra vs A\*** (mean time / mean junctions settled per query)

| Graph | Dijkstra | A* | A* settles | A* speed-up | Same cost |
|---|---|---|---|---|---|
| Central Pune (7,695 junctions, 500 pairs) | 7.34 ms / 3,742 | 4.94 ms / 2,161 | 57.8% | 1.49× | 500/500 |
| Full Pune | — | — | — | — | skipped: server/data/pune-full.graph.json not present (full-Pune OSMnx download did not finish within the 15-minute budget). |

**Nearest junction: k-d tree vs brute force** (10,000 queries over 7,695 junctions)

| k-d tree | Brute force | Speed-up | Same answer | Nodes visited per query | Build |
|---|---|---|---|---|---|
| 47.1 ms | 492.5 ms | 10.5× | 10,000/10,000 | 24.6 | 75.3 ms |

**Greedy vs Hungarian** (300 random 8-incident bursts; seconds of total ETA saved by Hungarian, over bursts where both serve the same incidents)

| Units | Comparable bursts | Hungarian better / equal / worse | Mean | Median | Max | Mean when better |
|---|---|---|---|---|---|---|
| All free | 300 | 116 / 184 / 0 | 31.1 s (1.6%) | 0 s | 451.9 s (18.4%) | 80.3 s |
| Half busy (seeded) | 300 (avg 7.4 served) | 167 / 133 / 0 | 59.6 s (2.7%) | 17 s | 404.3 s (20%) | 107.1 s |

Hungarian served more incidents than greedy in 0 (all free) and 0 (half busy) bursts. The demo burst (seed 92) is the clearest of the 300 (451.9 s). A 50 × 50 matrix takes 0.25 ms (Hungarian) vs 0.03 ms (greedy).

**Other algorithms on central Pune**

| Algorithm | Time | Result |
|---|---|---|
| Tarjan bridges + articulation points (iterative) | 45.9 ms | 2,141 bridges, 1,797 articulation points |
| Tarjan SCC (iterative) | 13.9 ms | 1 component(s) |
| Multi-source Dijkstra (5 fire stations) | 23.6 ms | every junction's time to the nearest station |
| Coverage isochrones (fire) | 25.6 ms | 89.5% of road length within 8 min |
| Edmonds-Karp evacuation, normal | 308 ms | 553 augmenting paths, 78,850 of 87,750 people |
| Edmonds-Karp evacuation, 10 m flood | 120 ms | 339 augmenting paths, 50,000 people |
| Greedy k-center placement (2 scenarios) | 12130 ms | 116 candidates each (one Dijkstra per candidate) |
<!-- BENCHMARKS:END -->

### Load test: 100 simulated phones (`scripts/sos-bots.mjs`)

**Setup:**
- 100 phones, each on its own Socket.IO connection, send one SOS from a seeded random road point within
  20 s, to a local server (TomTom disabled) running at 30× sim speed.
- 30% of them call about one of 10 "hotspots" (within 40 m), as several neighbours reporting the same
  emergency would.

<!-- SOSBOTS:START -->
Run on 2026-11-12: `node scripts/sos-bots.mjs 100` (calls spread over 20 s, sim speed 30×, observed for 90 s).

| Calls sent / accepted | Incidents created | Merged by clustering | Ack latency p50 / p95 | Assigned immediately | Assignment latency p50 / p95 (all) | Response time (SOS → on scene) |
|---|---|---|---|---|---|---|
| 100 / 100 | 87 | 13 calls (13%; 23 hotspot calls) | 58 / 241 ms | 81 (p50 64 ms, p95 243 ms) | 67 ms / 41.1 s | avg 376 sim-s, p95 1301 sim-s (84 incidents arrived) |

Incidents that found a free unit were assigned in tens of milliseconds. 19 calls had to wait in the priority queue until a unit came free (57 units for 87 incidents), which is what the long p95 shows; 0 were still waiting at the end.
<!-- SOSBOTS:END -->

### Event log and replay

- **What is logged:** every event the dispatcher sees, one JSON line each, stamped with **simulated** time,
  e.g. `{"t":300,"type":"unit:rerouted","data":{…}}`.
  - Road-closure lists are stored as ids (no shapes) and unit routes are rounded.
  - Logs go to `server/logs/` (git-ignored). A new file starts on server start, sim reset and scenario start.
- **`/replay`:** plays any log at **1× / 5× / 10×** (and 30×) of simulated time, with play, pause, a scrubber,
  the map (incidents, moving units, closures, flood) and an event feed.
- **Saved recording:** `server/data/replays/monsoon-demo.jsonl` is one full **Monsoon flood demo** run.
  - Recorded headless by `scripts/record-demo.mjs` with the same `simStep()` as the server; the scenario is
    seeded and deterministic.
  - 625 events over 30 sim-minutes: 12 SOS, flood to 10 m, the New Sangam closure, 3 reroutes.
  - It replays with no network, no TomTom and no phone; only the base map tiles need the internet.

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

**Duplicate merging** (union-find, so merging is transitive): records of the same kind are merged when:
- one point is inside the other's building outline, or
- they are within 150 m with the same or similar name (token sets equal, contained, or Jaccard ≥ 0.6), or
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
| A* (haversine ÷ V_MAX heuristic) | `astar.js` | O((V + E) log V) worst, far fewer nodes in practice |
| BFS (queue) / DFS (iterative, explicit stack) | `bfs.js`, `dfs.js` | O(V + E) |
| k-d tree (2-D, median split) | `kdtree.js` | build O(n log² n); nearest O(log n) avg |
| Haversine distance | `haversine.js` | O(1) |
| Emergency priority queue (binary max-heap) | `EmergencyPriorityQueue.js` | insert/extract O(log n) |
| Geohash encode/decode + 3×3 neighbour lookup (spatial hash grid) | `geohash.js` | O(precision); query O(1 + hits) |
| SOS clustering (geohash candidates + haversine, 100 m / 5 min) | `sosClusterer.js` | O(1 + calls in 9 cells) per call |
| Hungarian algorithm (potentials, rectangular, ∞ = impossible) | `hungarian.js` | O(n²·m), n ≤ m |
| Traffic-weighted edges (factor in [1, 4], snapshot apply) | `Graph.js`, `trafficService.js` | apply O(roads); routing unchanged |
| Nearest-edge matching (sampled shapes in a k-d tree + exact point-to-segment) | `edgeMatcher.js` | build O(S log² S); query O(log S + candidates) |
| Tarjan bridges + articulation points (iterative, with cut-off sizes/facilities) | `tarjan.js` | O(V + E) |
| Tarjan SCC (iterative) + trap-zone classification on the condensation | `tarjan.js` | O(V + E) |
| Multi-source Dijkstra (all sources at cost 0; forward or reverse) | `dijkstra.js` | O((V + E) log V) |
| River crossing importance (segment intersection + 3 multi-source runs per crossing) | `networkService.js` | O(C·(V + E) log V) |
| Flood spread: nearest river point (k-d tree) + multi-source BFS over low ground | `floodModel.js` | O(V log V) setup, O(V + E) per level |
| Dynamic rerouting (upcoming roads from the trip timeline, A* from the next junction) | `dispatchService.js` | O(U·R) + one A* per affected unit |
| Crowd report quorum (hash map of phone → time per road, 15-min sliding window) | `crowdReports.js` | O(log S) snap + O(1) avg |
| Coverage isochrones (multi-source Dijkstra + road bands) | `planningService.js` | O((V + E) log V) per source set |
| Greedy k-center (Gonzalez farthest-first + best-improvement over candidates) | `kcenter.js` | O(C · (V + E) log V) |
| Edmonds-Karp max flow + min cut (BFS augmenting paths, residual edge pairs) | `edmondsKarp.js` | O(V · E²) |
| Greedy assignment (priority order, nearest free unit) | `hungarian.js` | O(n·m) |
| Priority aging (heap rebuilt every tick) | `dispatchService.js` | O(p log p) per tick |
| Discrete-event queue (min-heap by time, FIFO ties) | `EventQueue.js` | push/pop O(log n) |
| Trip interpolation (prefix sums + binary search) | `trip.js` | build O(points), position O(log points) |

**Why A* is exact here:** V_MAX = max over all roads of (straight-line length ÷ baseTimeS), computed from the
data (85.2 km/h). Every road therefore costs at least `straight-line / V_MAX`, because traffic only slows
roads down and penalties are ≥ 0. With the triangle inequality, `h(v) = haversine(v, target) / V_MAX` is
consistent, so A* returns Dijkstra's optimal cost.

**Dijkstra early stop is optional:** it applies only when a `target` is given. A full run returns a
distance for all 7,695 junctions (tested).

## 7. Tests

`npm test` runs 139 tests in about 30 s. The 300-seed burst benchmark takes most of that time.

Phase 7 additions:
- the event log writes JSONL with simulated timestamps and compacts large payloads
- the saved Monsoon demo log is ordered in time and contains the whole story (12 SOS, flood to 10 m,
  closures, the New Sangam closure, a reroute, unit movement)

Phase 6 reference comparisons:
- **Edmonds-Karp:**
  - the CLRS figure 26.6 network gives max flow 23, with the hand-solved cut
  - a hand-solved evacuation-like network gives 140 of 160
  - **max flow = brute-force minimum cut over all 2ⁿ vertex subsets** on 300 random tiny networks, with
    flow conservation checked
- **k-center:**
  - with every junction as a candidate, the greedy pick equals the brute-force best single station
  - Gonzalez farthest-first stays within 2× the brute-force optimal k-center (k = 2, 3)
- **Coverage:** the % within 8 min equals an independent computation, and it never grows while the flood rises.
- **Placement:** improves the worst case in both scenarios, the graph is restored exactly, and the flood
  scenario equals the live fully spread flood.
- **Evacuation on Pune:**
  - cut capacity = flow
  - the flood evacuates no more than normal
  - boat-only people are counted
  - bottlenecks are open roads
- **Shelters:** capacities follow the documented types, are flagged simulated, and are counted by Tarjan.
- **TomTom:** with a key and a stale snapshot, nothing is fetched until the button is pressed, and a second
  refresh within 15 min needs `force`.
- **Monsoon demo:**
  - deterministic (two headless runs are identical)
  - all 12 calls arrive, on both banks, near the river
  - the scripted bridge closure reroutes a unit at exactly 300 s

Phase 5 reference comparisons:
- **Flood plan:** equals a brute-force connectivity search (eligible junctions reachable from river-side seeds
  through eligible junctions), including the exact BFS hop times, on 25 random graphs × 4 levels.
- **Flood monotonicity:** a higher level floods a superset, and level 0 floods nothing.
- **Road statuses:** BLOCKED exactly when touching a junction flooded by then, and growing over time.
- **GloFAS:**
  - percentile classification (normal / elevated / flood alert)
  - via a fake API: the suggested level, a 6 h disk cache, and an outage keeping the last result with a
    message
- **Pune flood:**
  - spreads over sim time, then recedes completely
  - a manual closure is never reopened
  - it re-ranks the crossings (bridges closed, response times up)
  - it changes the SCC analysis
- **Crowd quorum:**
  - the same phone counts once
  - reports older than 15 min expire
  - the third distinct phone closes the road
- **Rerouting:**
  - a closure ahead re-plans from the next junction, avoiding the road, and the unit arrives at the new ETA
  - fully cutting off an incident sends it back to PENDING

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
- **A* vs Dijkstra:** equal on 500 random Pune pairs with a traffic snapshot applied (factors 1–4 incl.
  clamped values). Traffic is shown to change some routes.
- **Traffic factor:** freeFlow/current is clamped to [1, 4] (0.83 → 1, 10 → 4, a closure or a stopped road → 4).
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
- **Hungarian vs brute force over all permutations, n ≤ 6:**
  - square matrices
  - rectangular matrices, with more units than incidents and fewer
  - impossible pairs (∞, wrong unit type), checking the number served and the total cost
- **Hungarian vs greedy:** never worse in 300 random cases, plus a hand-made counter-example where greedy loses.
- **Geohash:**
  - matches the published reference value
  - the 3×3 block contains every point within 100 m (2,000 random pairs)
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

- Map data and tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). Standard
  OSM raster tiles are used lightly. The dark look is a CSS filter (CARTO's dark basemap now requires an API
  key). Tiles are never bulk-downloaded.
- Road network and facilities downloaded with OSMnx via the Overpass API, cached in `scripts/.osm_cache`.
- Live traffic: **TomTom** Traffic Flow Segment Data (free tier, no card). The server-side key is in `.env`,
  calls are capped at 200/day, and `traffic-snapshot.json` contains TomTom-derived speeds.
- Comparison baseline: **OSRM** public demo server (`router.project-osrm.org`), max 1 request/s, cached,
  never presented as our route.
- River lines: OpenStreetMap `waterway=river` (`scripts/build_river.py`).
- Elevation: **SRTM** (NASA) via the `srtm.py` package, downloaded once.
- River discharge: **Open-Meteo Flood API** (GloFAS, Copernicus Emergency Management Service), free and with
  no key. The history and the latest result are cached in `server/data/flood-*.json`.

### Regenerating the map data (optional)

`server/data/*.json` is committed, so the app runs offline. To rebuild it:

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r scripts/requirements.txt   # Windows (macOS/Linux: .venv/bin/python)
npm run data:graph && npm run data:facilities
.venv\Scripts\python scripts/build_river.py && .venv\Scripts\python scripts/build_elevation.py
.venv\Scripts\python scripts/build_shelters.py
```

Some Python packages are pinned to older versions because Windows Application Control blocked the newest
pandas/pyproj DLLs on the development machine.

## 9. Limitations

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
- **Flood model:**
  - SRTM has a ~30–90 m grid with several metres of vertical error; the elevations are integers.
  - There is no flow or volume physics. It is a level-based "bathtub with connectivity", and the recede is
    instant.
  - A rerouted unit whose incident becomes unreachable stops at its next junction straight away.
- **Planning numbers are model outputs, not forecasts.** Population per junction (250), people per vehicle (4),
  the 1-hour window and the shelter capacities are simulated assumptions.
- **Station placement:** evaluates about 120 candidate junctions (not all 7,695) and is computed once at
  startup.
- **The fixed sim step is deterministic but can lag wall-clock time** slightly if the server is busy.
- **State lives in server memory:** restarting the server clears incidents. The event log keeps a record that
  `/replay` can play back, but the server cannot resume from it.
- **Full-Pune benchmark not run:** the OSMnx download of all of Pune timed out after the 15-minute budget
  (Nominatim answered 503, then one Overpass mirror timed out and another never answered). The script supports
  it: `scripts/build_graph.py --place "Pune, Maharashtra, India" --out pune-full.graph.json`, then
  `node scripts/bench.mjs`.
- The Marathi and Hindi texts were written for the demo and should be checked by a native speaker.
