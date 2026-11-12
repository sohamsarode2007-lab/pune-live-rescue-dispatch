# VIVA notes: Pune Live Rescue Dispatch

Quick reference for the oral exam. Every number below comes from the code or the committed data and can be
re-checked with `npm test`, `node scripts/bench.mjs` or the `/benchmarks` page.

## 1. Algorithms and data structures (all our own code)

V = 7,695 junctions, E = 10,218 roads (about 18,000 directed arcs) on central Pune. External services provide
map tiles, OSM data, TomTom speeds and an OSRM comparison route only.

| # | Algorithm / structure | File | Complexity | Where it is used |
|---|---|---|---|---|
| 1 | Adjacency list graph, one shared road object for both directions | `shared/graph/Graph.js` | O(1) avg vertex lookup | Everything; one status change closes both directions |
| 2 | Binary min-heap | `shared/graph/MinHeap.js` | push / pop O(log n), peek O(1) | Dijkstra, A*, event queue |
| 3 | Dijkstra (lazy deletion; optional early stop; reverse; multi-source) | `shared/graph/dijkstra.js` | O((V + E) log V) | Unit ETAs (reverse, one run per incident), hospitals, coverage, crossing importance, routes home |
| 4 | A* (haversine ÷ V_MAX heuristic) | `shared/graph/astar.js` | O((V + E) log V) worst case | Route planner, rerouting, OSRM comparison |
| 5 | BFS (queue with head index) | `shared/graph/bfs.js` | O(V + E) | Reachability, /algorithms visualisation |
| 6 | DFS (iterative, explicit stack) | `shared/graph/dfs.js` | O(V + E) | Components, /algorithms visualisation |
| 7 | k-d tree (2-D, median split, pruning) | `shared/spatial/kdtree.js` | build O(n log² n), nearest O(log n) avg | Snapping SOS calls, clicks and facilities to junctions |
| 8 | Haversine distance | `shared/spatial/haversine.js` | O(1) | A* heuristic, snap distances |
| 9 | Nearest-edge matching (k-d tree over sampled road shapes + point-to-segment) | `shared/spatial/edgeMatcher.js` | O(log S + candidates) | TomTom segments → roads, crowd reports → roads |
| 10 | Geohash + 3×3 neighbour lookup (spatial hash grid) | `shared/spatial/geohash.js` | encode O(precision), query O(1 + hits) | SOS clustering |
| 11 | Emergency priority queue (binary max-heap) with aging | `shared/dispatch/EmergencyPriorityQueue.js` | insert / extract O(log n) | Waiting incidents; who is served when units are short |
| 12 | Hungarian algorithm (potentials; rectangular; ∞ = impossible) | `shared/dispatch/hungarian.js` | O(n²·m), n ≤ m | Optimal unit ↔ incident assignment per batch |
| 13 | Greedy assignment (priority order, nearest free unit) | `shared/dispatch/hungarian.js` | O(n·m) | Baseline, always planned on the same matrix |
| 14 | Discrete-event queue (min-heap by time, FIFO ties) | `shared/sim/EventQueue.js` | push / pop O(log n) | Arrive at scene, scene done, hospital, home |
| 15 | Trip interpolation (prefix sums + binary search) | `shared/sim/trip.js` | position O(log points) | Moving units on the map; rerouting from the next junction |
| 16 | Tarjan bridges + articulation points (iterative) | `shared/graph/tarjan.js` | O(V + E) | Single points of failure, with what each cuts off |
| 17 | Tarjan SCC (iterative) + condensation | `shared/graph/tarjan.js` | O(V + E) | Trap-zone warnings after every closure |
| 18 | River-crossing importance (segment intersection + 3 multi-source runs per crossing) | `server/services/networkService.js` | O(C · (V + E) log V) | Ranking of the 9 Mutha crossings |
| 19 | Flood spread: nearest river point (k-d tree) + multi-source BFS over low ground | `shared/sim/floodModel.js` | O(V log V) setup, O(V + E) per level | Flood, closures over time |
| 20 | Dynamic rerouting (upcoming roads of a trip, A* from the next junction) | `server/services/dispatchService.js` | O(U·R) + one A* per affected unit | Any closure in front of a moving unit |
| 21 | Crowd-report quorum (hash map + 15-min sliding window) | `server/services/crowdReports.js` | O(1) avg per report | "Report a flooded road" |
| 22 | Coverage isochrones (multi-source Dijkstra + bands) | `server/services/planningService.js` | O((V + E) log V) | % of roads within 8 min; shrinks with the flood |
| 23 | Greedy k-center (Gonzalez farthest-first + best-improvement) | `shared/graph/kcenter.js` | O(C · (V + E) log V) | New station suggestion (normal vs 10 m flood) |
| 24 | Edmonds-Karp max flow + min cut | `shared/flow/edmondsKarp.js` | O(V · E²) | Evacuation feasibility, bottleneck roads |
| 25 | Seeded PRNG (mulberry32) | `shared/sim/random.js` | O(1) | Bursts, scenario, benchmarks: reproducible |

**Reference tests (brute force or independent method):**
- Dijkstra and A* vs Bellman-Ford, and A* = Dijkstra on 500 Pune pairs, with and without traffic.
- k-d tree, nearest-edge matching and geohash vs brute force.
- Hungarian vs all permutations (n ≤ 6, rectangular, with ∞).
- Tarjan vs removing each road / junction; SCC vs mutual reachability.
- Edmonds-Karp vs brute-force min cut over all 2ⁿ subsets.
- k-center vs brute force (exact best single site; Gonzalez ≤ 2 × OPT).
- Flood BFS vs a brute-force connectivity search.
- Event queue vs sort, trip binary search vs linear scan.

## 2. Simulated values and assumptions (say "simulated" every time)

| What | Value | Where |
|---|---|---|
| Default free-flow speeds when OSM has no `maxspeed` | motorway 80, trunk 60, primary 50, secondary 40, tertiary 35, unclassified 30, residential 25, service 15 km/h (links lower) | `scripts/build_graph.py` |
| Edge cost | `baseTimeS × trafficFactor + riskPenaltyS` (seconds) | `Graph.js` |
| Risk penalties | HIGH_RISK +120 s; OPEN with moderate risk +30 s | `Graph.js` |
| Traffic factor | TomTom freeFlow ÷ current, clamped to [1, 4]; closure or stopped = 4 | `trafficService.js` |
| Hospital beds, all 57 units | simulated (seed 2026): fire station 2 trucks + 1 boat; police 1 ambulance; major hospital 1 ambulance | `facilities.json` |
| Major hospitals | top 12 by OSM evidence (beds, emergency=yes, specialities, footprint, well-known names) | `build_facilities.py` |
| Scene times | medical 4 min, fire 10 min, flood 8 min | `dispatchService.js` |
| Priority score | 5·severity + 2·min(people,10) + min(minutes waited,10) | `requestConstants.js` |
| SOS clustering | same type, ≤ 100 m, ≤ 5 min from the first call | `sosClusterer.js` |
| Shelter capacities | school 300, college 500, community hall 150, municipal hall 200 | `build_shelters.py` |
| Evacuation | 250 people per affected junction; 4 people per vehicle; 1-hour window; road capacity in vehicles/h: trunk 2,000, primary/secondary 1,200, tertiary/residential 400; HIGH_RISK 50% | `planningService.js` |
| Flood model | level above the smoothed river; buffer 1.5 km; seeds ≤ 100 m from the river; 90 s per BFS hop; 1 m freeboard = high risk | `floodModel.js` |
| GloFAS → level | normal (< p90) 0 m, elevated (p90–p99) 4 m, flood alert (≥ p99) 8 m | `floodService.js` |
| Coverage | "covered" = road entry reached within 8 min | `planningService.js` |
| Crowd reports | 3 different phones within 15 min close a road | `crowdReports.js` |
| Demo scenario | flood 0 → 10 m in 2 m steps every 2 sim-min; 12 seeded SOS on both banks; **scripted closure: police close New Sangam Bridge at sim 5:00** (FT-2 is driving over it, so the demo always shows a reroute) | `scenario.js` |
| Burst | 8 incidents, seed 92 = the clearest of 300 (not typical) | `burst.js` |
| Sim clock | fixed 0.5 s × speed per tick (deterministic) | `server/index.js` |

Real data: the road network, facility names and locations, river lines (OSM), elevations (SRTM), TomTom
speeds (when fetched) and GloFAS discharge. Everything in the table above is an assumption or a simulated value.

## 3. Likely questions with short answers

1. **Why A* and Dijkstra both, if A* is faster?**
   A* needs a target and an admissible heuristic. Dijkstra answers one-to-all questions (reverse ETA of
   every unit to an incident, coverage, the nearest hospital) in one run, which A* cannot do.
2. **Why is the A* heuristic admissible with traffic?**
   h = straight-line distance ÷ V_MAX, where V_MAX is the fastest free-flow speed in the data. Traffic
   factors are clamped to ≥ 1 and penalties are ≥ 0, so no road is ever cheaper than straight-line ÷ V_MAX.
   It is consistent by the triangle inequality, and the tests show A* = Dijkstra on 500 pairs with traffic
   applied.
3. **How do you find the nearest unit for an incident quickly?**
   One *reverse* Dijkstra from the incident gives every junction's travel time *to* it. Each unit's ETA is a
   lookup: one run per incident instead of one per unit.
4. **What does the Hungarian algorithm optimise, and when does greedy lose?**
   It minimises the total ETA over a batch (after serving as many incidents as possible). Greedy lets an
   early incident take the only good unit for a later one. Over 300 random bursts Hungarian was never worse,
   and better in 116 of them; the mean saving is small and the demo seed is the largest.
5. **How are impossible pairs handled?**
   A wrong unit type or an unreachable unit gets cost ∞, replaced by BIG = (sum of finite costs) + 1, so one
   impossible pair always costs more than any set of possible ones. Pairs left on BIG are reported unassigned.
6. **Why geohash plus neighbours?**
   A precision-7 cell is about 145 × 153 m, larger than the 100 m merge radius. So every call within 100 m is
   in the 3×3 block around the call's cell, even across a cell boundary (tested). That checks 9 cells instead
   of every open incident.
7. **Why are Tarjan and DFS iterative?**
   The DFS depth on Pune exceeds 500 levels, and recursion risks a stack overflow. The explicit stack visits
   in exactly the same order (tested).
8. **Why are most bridges "trivial"?**
   A dead-end lane is a bridge in the graph sense. We report what each cut off contains: only 55 + 55 of
   2,141 + 1,797 cut off ≥ 50 junctions or a facility.
9. **What is a trap zone?**
   A strongly connected component, other than the main one, that can be entered but not left (or the
   reverse), found from the condensation. One-way streets plus closures create them.
10. **Why do single river crossings matter so little?**
    There are 9 parallel crossings, so losing one changes the average fire response by seconds. The flood
    closes six together, and then the worst case almost doubles (12:53 → about 22:40).
11. **Is the flood model a prediction?**
    No. It is a level-based "bathtub with connectivity" on SRTM (90 m grid, metres of error). GloFAS is a
    coarse 5 km global model and does not see Khadakwasla dam releases, hence the manual slider.
12. **How does rerouting work?**
    When a road a moving unit has not reached closes, the unit finishes its current road, then A* runs from
    the next junction to the same destination. If that destination is unreachable, the incident goes back to
    the priority queue.
13. **What does the max flow / min cut tell a planner?**
    The flow is how many people can reach shelters within an hour. The min cut lists the saturated roads
    (and shelters) that limit it: widening or protecting those raises the maximum. Under the 10 m flood,
    31,250 people are on fully flooded junctions and need boats.
14. **Is greedy k-center optimal?**
    No, k-center is NP-hard. Gonzalez farthest-first is a 2-approximation on symmetric distances (tested
    against brute force). We then pick, among ~120 candidates (116 after duplicates), the one with the smallest new worst case
    (tested equal to brute force when every junction is a candidate).
15. **How do you know the code is right, and how do you keep external costs at zero?**
    Every algorithm has a brute-force or reference test, 139 tests in total. TomTom is called only from a
    button, capped at 200 per day in code, and saved to disk. OSRM is limited to 1 request per second and
    cached. No credit card was registered anywhere. The demo can be replayed from the saved log with no
    network.
