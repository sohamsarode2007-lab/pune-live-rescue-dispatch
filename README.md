# Smart Urban Disaster Rescue Network and Evacuation Routing System

An interactive classroom simulation of a **fictional city ("Meridian")** during a flood or fire.
Roads can be blocked or become hazardous; rescue requests are prioritised; routes are computed with
**real implementations** of BFS, DFS and Dijkstra (binary min-heap). Data Structures / Discrete Mathematics (Graph Theory) course project.

> This is a simulation. Disasters, closures and risk penalties are predefined parameters, **not** real
> emergency-response data or safety standards. The app does not predict real flood/fire behaviour.

## 1. Setup and run

Requires Node.js 18+ (developed on Node 22).

```bash
npm install
npm run dev      # open the printed URL (usually http://localhost:5173)
npm test         # 64 automated algorithm/service tests (no extra dependencies)
npm run build    # production build into dist/
```

## 2. Project structure

```
src/
  algorithms/   Graph.js  MinHeap.js  bfs.js  dfs.js  dijkstra.js
                EmergencyPriorityQueue.js  hashLookup.js        (pure JS, no React)
  data/         cityData.js  disasterScenarios.js  requestConstants.js  algorithmInfo.js
  services/     scenarioService.js  routingService.js  comparisonService.js
                requestService.js  statisticsService.js          (glue between algorithms and UI)
  components/   CityMap  RoutingPanel  ScenarioControls  ComparisonPanel  RescueRequestPanel
                RoadPanel  SearchPanel  AlgorithmPanel  StatisticsPanel
  tests/        *.test.js  (node:test)
  App.jsx  main.jsx  styles.css
scripts/ui-check.mjs   optional automated click-through of the UI
```

## 3. Architecture

- **Graph and routing engine are independent of the map.** `cityData.js` is plain data; `Graph` stores it;
  `CityMap.jsx` only *draws* whatever the graph contains (27 locations, 48 roads).
- **One source of truth.** A road is a single object shared by both directions of the adjacency list, so a
  status change (block / high-risk / reopen) is immediately seen by every algorithm and by the map.
- **Nothing is cached.** After every change the UI bumps a version counter and recomputes routes, alternative
  routes, reachability, traversals and metrics from the current graph, so a stale route cannot be displayed.
- `createSimulation()` bundles graph + requests + active scenario + saved baseline; `resetScenario()` restores all of it.

## 4. Data model and cost model

- **Location:** `id, name, type, x, y, affected`. Types: Intersection, Residential Area, Commercial Area, Hospital, Shelter, Rescue Station, Disaster Site.
- **Road:** `id, from, to, distanceKm, status (OPEN | HIGH_RISK | BLOCKED), riskLevel, riskPenalty`. Two-way roads are stored in both directions; one-way (directed) roads are supported.
- **Edge cost** = `distanceKm + riskPenalty`. Penalties (illustrative): OPEN low 0, OPEN moderate 2, HIGH_RISK 8, BLOCKED not traversable.
- Distance and penalty are kept separate, so results show distance, penalty and total cost.
- The minimum-cost route is optimal **under this cost model**; it is not claimed to be the safest real-world route.

## 5. Algorithms and data structures

| Item | Where | Complexity |
|---|---|---|
| Adjacency list (`Map` of arrays) | `Graph.js` | O(1) average vertex lookup |
| BFS (queue, index pointer) | `bfs.js` | O(V + E) |
| DFS (recursive) | `dfs.js` | O(V + E) |
| Dijkstra (adjacency list + binary min-heap, lazy deletion, predecessor map) | `dijkstra.js`, `MinHeap.js` | O((V + E) log V) |
| Routing min-heap: push / pop / peek | `MinHeap.js` | O(log n) / O(log n) / O(1) |
| Emergency priority queue (binary **max**-heap, separate from the routing heap) | `EmergencyPriorityQueue.js` | insert / extractMax O(log n) |
| ID lookup with built-in `Map` | `hashLookup.js` | O(1) average |

Notes for a viva:
- Blocked roads are excluded in `graph.neighbors()`, which all three graph algorithms use, so none can traverse them.
- Dijkstra needs non-negative weights; every traversable weight is `distance >= 0` plus a penalty `>= 0`.
- The hash lookups use JavaScript's built-in `Map`. **Hashing and collision handling are done by the JavaScript engine; they are not implemented here.**
- **Alternative route** = cheapest route that avoids at least one road of the primary route (Dijkstra re-run with that road excluded, for each road of the primary route; the best result is shown).
- **Priority score** = `5*severity + 2*min(people,10) + min(waiting,10)`. Ties: longer waiting time, then request ID (natural order). Weights are in `requestConstants.js` and are demonstration values, not triage criteria.
- The request queue is rebuilt from **pending** requests only, so assigned/completed requests are never selected.

## 6. Scenarios (predefined, deterministic)

- **Flood – Riverside district:** 4 locations affected, 4 roads blocked, 3 high-risk, 4 requests. Riverside Colony (R1) becomes unreachable; the others stay reachable.
- **Fire – Old Market:** 3 locations affected, 2 roads blocked, 4 high-risk, 3 requests; the incident site stays reachable with a risk penalty and an alternative route exists.
- Activating the same scenario again does nothing (no duplicate requests). Switching replaces the scenario's roads and requests. Manual requests are kept. **Reset Scenario** restores roads, affected flags, requests, scenario, and the saved baseline.

## 7. Using the app

1. **Routing:** choose a rescue station and destination → route, distance, risk penalty, cost, alternative route and per-station comparison (cheapest reachable station is recommended; none if unreachable).
2. **Save baseline**, then activate a scenario or block roads → **Before / after comparison** (routes, distance and cost change, reachability, closed roads on the old route). Unreachable shows `UNREACHABLE`.
3. **Rescue Requests:** priority view, select next, assign (chosen or recommended station), complete, add a request.
4. **Algorithm Demonstrations:** run BFS / DFS from any location (map rings + visit order); purpose, input, output, steps, complexity and current graph state for all six structures/algorithms.
5. **Results / Statistics:** original vs current metrics. **Dashboard:** search any location, road or request by ID.

## 8. Testing

```bash
npm test
```

| Requirement | Test file / name |
|---|---|
| 1–5 Dijkstra: lower cost, avoids blocked, alternative after block, unreachable, high-risk penalty | `dijkstra.test.js` (tests "1." to "5.") |
| 6 BFS ignores blocked roads | `bfs.test.js` |
| 7 DFS ignores blocked roads | `dfs.test.js` |
| 8 Highest-scoring pending request chosen | `priorityQueue.test.js` ("8.") |
| 9 Deterministic tie-breaking | `priorityQueue.test.js` ("9." and natural ID order) |
| 10 Reset restores the original graph | `scenarios.test.js` ("10.") |
| 11 Activating twice does not duplicate requests | `scenarios.test.js`, `requests.test.js` ("11.") |
| 12 Route results update after graph changes | `scenarios.test.js` ("12."), `dijkstra.test.js` ("3.") |
| 13 Location / request lookup correctness | `hashLookup.test.js`, `graph.test.js`, `requests.test.js` ("13.") |
| 14 Displayed routes use valid, traversable edges | `dijkstra.test.js` ("14.") |

Extra checks: Dijkstra is compared with a test-only Bellman-Ford on every source/destination pair, before and after closures; the priority queue is compared with a sort on 200 pseudo-random requests; metrics are checked against the graph and request store.

**Optional automated UI check** (clicks through the whole app in a simulated DOM; extra packages not saved in `package.json`):

```bash
npm install --no-save jsdom @testing-library/react @testing-library/dom
npm run test:ui
```

### Manual UI test checklist

- [ ] Map shows the city; legend visible; hospitals, shelters, stations, residential and commercial markers distinguishable.
- [ ] Routing: RS1 → H2 highlights a blue route; cost matches the panel.
- [ ] Click a road → details appear; **Block** turns it red/dotted and the counts change; **Reopen** restores it.
- [ ] Block every road on the current route → route disappears and `UNREACHABLE` is shown (no stale route).
- [ ] Save baseline (RS1 → H2), Activate Flood → new route, positive distance/cost change, closed roads listed.
- [ ] Flood panel: R1 listed as unreachable; cards show 3 / 4 reachable affected locations.
- [ ] Rescue Requests: FLOOD-1 ranks first; its Assign shows a "no route" message and it stays pending.
- [ ] Assign FLOOD-2 to the recommended station; mark completed; it no longer appears as next.
- [ ] Add a request; it receives `REQ-001`; the priority order updates.
- [ ] Activate Fire → alternative route drawn as a green dashed line for RS1 → C1.
- [ ] Algorithm Demonstrations: Run BFS and DFS; unreachable locations listed during the flood.
- [ ] Search `h1`, `rd7`, `flood-2`, and an unknown ID.
- [ ] Results: original vs current metrics differ after a scenario.
- [ ] Reset Scenario: all cards return to original values.

## 9. Assumptions

- The city, scenarios and risk penalties are fictional and predefined; behaviour is deterministic for demonstrations.
- One rescue team per request at most. A station can serve several requests (no capacity model).
- A location counts as "reachable" if at least one rescue station can reach it over open or high-risk roads.
- Request IDs: scenario requests use fixed IDs (`FLOOD-1`, …); manual requests use `REQ-001`, `REQ-002`, …

## 10. Limitations

- No real map, GPS, live data, database, authentication or real dispatch integration.
- The graph is edited in code (`cityData.js`), not in the UI; roads between existing locations can be added there.
- No simulation of time, flood/fire spread, traffic or vehicle capacity; the waiting-time score is a static input.
- Metrics are counts from the simulation state; they do not measure lives saved, real evacuation time or disaster severity.
- Tests cover algorithms and services; UI behaviour is covered by the manual checklist and the optional script.
