# Demo script (7–8 minutes)

## Before the demo (10 minutes earlier)

1. `npm run build`
2. Start the server in a terminal and leave it running:
   - **With live traffic available:** `npm start`. TomTom is only used if you press *Refresh traffic*.
   - **Without TomTom calls (rehearsals, or if in doubt):** PowerShell `$env:TOMTOM_DISABLED='1'; npm start`,
     bash `TOMTOM_DISABLED=1 npm start`.
3. Phone: run `ngrok http 3001` and open `https://<id>.ngrok-free.app/sos` on the phone. Tap **Visit Site** on
   ngrok's warning page and allow location when asked.
4. Laptop browser tabs, in this order:
   - `http://localhost:3001/` (dispatcher)
   - `/replay` (fallback)
   - `/benchmarks`
   - `/algorithms` (only if asked)
5. On the dispatcher:
   - **Live dispatch → Simulation → Reset**
   - **Traffic → Free-flow** (the burst numbers below are free-flow numbers)
   - **Dispatch → Hungarian (optimal)**
6. Zoom the map so the whole dashed box (central Pune) is visible.

Throughout: the red banner says *Demo simulation — in a real emergency call 112*. Say that once at the start.

---

## 1. Phone SOS (0:00–1:30)

**Click:** on the phone choose **Medical**, **Serious**, **2** people, then press **I'm in danger** and allow
location.

**Say:**
- "This is the SOS page, in English, Marathi and Hindi. GPS needs HTTPS, so it runs through ngrok."
- "On the dispatcher the pin appears immediately. Our k-d tree snaps it to the nearest of 7,695 real road
  junctions."
- "One reverse Dijkstra from the incident gives every unit's travel time to it; the nearest ambulance is
  assigned in well under a second."
- "The phone now shows the unit and a live ETA, moving along the real roads."

**If it fails:**
- **GPS denied, or you are outside central Pune:** the phone says so automatically. Tap a point inside the
  dashed box and press **Send SOS here**.
- **Phone or ngrok not working:** on the dispatcher, **Live dispatch → Test SOS → Place test SOS on map**,
  then click near Deccan. It goes through the same code path.

## 2. Burst: greedy vs Hungarian (1:30–2:45)

**Click:**
1. **Simulation → Reset** (OK), then **Dispatch → Burst: 8 simultaneous incidents**.
2. Scroll to **Greedy vs optimal** and open **Who goes where**.

**Say:**
- "Eight emergencies arrive at once. For every batch we plan *both* ways on the same travel-time matrix."
- "Greedy, nearest unit in priority order: 48 min 03 s of total response. Hungarian, the optimal assignment:
  40 min 31 s. That saves 7 min 32 s (15.7%): it swaps two pairs of rescue boats; the yellow rows."
- "Honest caveat: over 300 random bursts Hungarian is never worse, but usually equal. The average saving is
  31 s. This seed is the clearest of the 300. The benchmark is in the panel and on the Benchmarks page."

**If it fails:**
- **Numbers differ:** traffic was not on Free-flow or the simulation was not reset. Reset and burst again.
- **Burst says the calls were merged:** that is the 5-minute clustering. Press **Reset** first.
- **Anything else:** show the same numbers on `/benchmarks` (Greedy vs Hungarian table).

## 3. Monsoon flood demo (2:45–5:00)

**Click:** **Live dispatch → Simulation → ▶ Monsoon flood demo** → OK. The roads turn coverage colours by
themselves.

**Say, as it plays** (10×; the whole story takes about 2 real minutes):
- "One click: reset, free-flow, ten times speed. The Mutha rises from 0 to 10 m in 2 m steps, and twelve
  seeded SOS calls arrive on both banks."
- *(blue dots spread)* "The flood model is simplified: SRTM elevation plus the OSM river line. Water spreads
  outward from the river by BFS, only through low ground. Roads under water are blocked; roads next to it are
  high-risk."
- *(at about 30 s, the ⚠ line "Police close New Sangam Bridge" and the Reroutes panel)* "The police close New
  Sangam Bridge. Fire truck FT-2 was driving over it: it finishes its current road and re-plans with A* from
  the next junction. That's the ↻ marker."
- *(orange trap-zone box)* "After every closure Tarjan's SCC algorithm checks for areas you can enter but not
  leave. Here a shelter at COEP is cut off."
- *(Simulation panel)* "Fire coverage within 8 minutes drops from 89.5% towards 81%, live."

**If it fails:**
- **Live run breaks:** open the `/replay` tab. The ★ `monsoon-demo.jsonl` log is preselected. Choose **10×**
  and **Play**. It is a recording of exactly this scenario (the scenario is deterministic) and needs no
  network, no TomTom and no phone.

## 4. River crossings (5:00–5:40)

**Click:** **Network** tab → the **River crossing importance** table → click a row (e.g. Raveendra Mhatre
Bridge).

**Say:**
- "Nine real Mutha crossings, found from OSM bridge tags crossing the river line."
- "For each, we remove it alone and rerun multi-source Dijkstra from the 5 fire stations."
- "Normally losing one bridge costs only seconds, because they back each other up."
- "Now that the flood has closed six, the ranking has been recomputed: the remaining crossings matter much
  more."

**If it fails:**
- **Ranking still "updating…":** it recomputes about 1.5 s after closures. Wait a moment.
- **Otherwise:** click a numbered crossing pin on the map instead.

## 5. Coverage (5:40–6:15)

**Click:**
- **Coverage isochrones** → **Fire stations**, then **Ambulance bases**.
- Make sure **Colour every road by response time** is ticked.

**Say:**
- "Multi-source Dijkstra from every station at once colours every road: green under 5 minutes, then 8, 12,
  and red beyond."
- "The north-west, around Aundh and the university, is the weak spot for fire response."
- "The line chart is coverage over simulated time: it shrank as the water rose."

**If it fails:** if the colours don't appear, untick and tick the checkbox (the road shapes load once,
about 2 MB). The percentages are in the panel either way.

## 6. Evacuation and station placement (6:15–7:15)

**Click:**
- **Evacuation feasibility** → tick **Show the bottleneck roads**, then click the **Normal** and **10 m flood**
  rows.
- **New fire station placement** → tick **Show both suggestions**.

**Say:**
- "Edmonds-Karp max flow, with people from the flood zone as supply, roads with capacity by road type, and
  schools and halls as shelters (simulated capacities)."
- "Normally 90% can be evacuated in an hour. Under the 10 m flood only 57%: 31,250 people are on junctions
  where every road is under water, so they need boats."
- "The magenta roads are the minimum cut: the bottleneck."
- "Greedy k-center suggests where one more fire station would cut the worst case most: near Diversion
  normally (12:53 → 9:05). Under the flood the best site is a different one."

**If it fails:** if the panels say "Computing…", wait about 10 s after server start; they are computed once
in the background.

## 7. Benchmarks and close (7:15–8:00)

**Click:** the `/benchmarks` tab.

**Say:**
- "Everything is our own code, and every algorithm has a brute-force or reference test, 139 tests in total."
- "A* finds the same optimal routes as Dijkstra while settling fewer junctions."
- "The k-d tree is far faster than a brute-force nearest search over 10,000 queries."
- "Hungarian versus greedy, also with half the units busy."
- "A load test: 100 phones in 20 seconds."
- "Total external spend: zero."

**If it fails:** the same tables are in README.md under *Benchmarks*.

---

## If the examiner asks for something specific

| Request | Where |
|---|---|
| "Show BFS / DFS" | `/algorithms` → click the map → BFS / DFS → Play |
| "Why should we trust it?" | `npm test` (about 30 s), VIVA.md |
| "Route between two points / compare with OSRM" | **Route planner** tab → click a destination → **Compare with OSRM** |
| "Live traffic" | **Traffic → Refresh traffic**. Uses about 60 of 200 daily TomTom calls; there is a confirmation. |
| "Crowd reports" | phone: **Report a flooded road**. 3 different phones within 15 min close a road. |
