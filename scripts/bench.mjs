// Algorithm benchmarks (Phase 7). Writes server/data/benchmarks.json (shown on /benchmarks) and replaces
// the section between <!-- BENCHMARKS:START --> and <!-- BENCHMARKS:END --> in README.md.
//   node scripts/bench.mjs            (about 2-4 minutes)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphStore, graphFromJson, loadJson } from '../server/services/graphStore.js';
import { FloodService } from '../server/services/floodService.js';
import { PlanningService } from '../server/services/planningService.js';
import { runBurstBenchmark } from '../server/services/burstBenchmark.js';
import { astar } from '../shared/graph/astar.js';
import { dijkstra, dijkstraAll } from '../shared/graph/dijkstra.js';
import { NodeIndex, projectLatLng } from '../shared/spatial/kdtree.js';
import { bridgesAndArticulationPoints, stronglyConnectedComponents } from '../shared/graph/tarjan.js';
import { hungarian, greedyAssignment } from '../shared/dispatch/hungarian.js';
import { mulberry32 } from '../shared/sim/random.js';
import { DATA_DIR, ELEVATION_FILE, FACILITIES_FILE, GRAPH_FILE, RIVER_FILE, ROOT } from '../server/config.js';

const FULL_FILE = path.join(DATA_DIR, 'pune-full.graph.json');
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const time = (fn) => { const t = performance.now(); const v = fn(); return [performance.now() - t, v]; };
const best = (n, fn) => { let b = Infinity, v; for (let i = 0; i < n; i++) { const [ms, x] = time(fn); if (ms < b) { b = ms; v = x; } } return [b, v]; };
const log = (...a) => console.log(...a);

// ---- Dijkstra vs A* on random pairs ----
function pairsBench(graph, n, seed) {
  const ids = [...graph.locations.keys()];
  const r = mulberry32(seed);
  const res = { d: [], a: [], ds: [], as: [], same: 0, reachable: 0 };
  for (let i = 0; i < n; i++) {
    const s = ids[Math.floor(r() * ids.length)], t = ids[Math.floor(r() * ids.length)];
    const [dm, d] = time(() => dijkstra(graph, s, t));
    const [am, a] = time(() => astar(graph, s, t));
    res.d.push(dm); res.a.push(am); res.ds.push(d.stats.settled); res.as.push(a.stats.settled);
    if (d.reachable) res.reachable++;
    if (d.reachable === a.reachable && (!d.reachable || Math.abs(d.totalCost - a.totalCost) < 1e-6)) res.same++;
  }
  const sum = (x) => x.reduce((p, q) => p + q, 0);
  return {
    junctions: graph.locations.size, roads: graph.roads.size, pairs: n, reachable: res.reachable, sameCost: res.same,
    dijkstra: { meanMs: r2(sum(res.d) / n), medianMs: r2(median(res.d)), settledMean: Math.round(sum(res.ds) / n) },
    astar: { meanMs: r2(sum(res.a) / n), medianMs: r2(median(res.a)), settledMean: Math.round(sum(res.as) / n) },
    settledRatioPct: r1((100 * sum(res.as)) / sum(res.ds)), speedup: r2(sum(res.d) / sum(res.a)),
  };
}

const t0 = performance.now();
const store = GraphStore.fromFiles(GRAPH_FILE, FACILITIES_FILE);
const g = store.graph;
const out = { generatedAt: new Date().toISOString(), machine: { node: process.version, cpu: os.cpus()[0]?.model?.trim(), cores: os.cpus().length, platform: `${os.platform()} ${os.release()}` } };

log('1/7 Dijkstra vs A* (central Pune, 500 pairs)');
out.pathCentral = pairsBench(g, 500, 1);

log('2/7 full Pune');
if (fs.existsSync(FULL_FILE)) {
  const [loadMs, full] = time(() => graphFromJson(loadJson(FULL_FILE)));
  out.pathFull = { ...pairsBench(full, 200, 2), loadMs: Math.round(loadMs), area: 'Pune, Maharashtra, India (OSM boundary)' };
} else {
  out.pathFull = { skipped: true, reason: 'server/data/pune-full.graph.json not present (full-Pune OSMnx download did not finish within the 15-minute budget).' };
}

log('3/7 k-d tree vs brute force (10,000 queries)');
{
  const idx = new NodeIndex(g);
  const pts = [...g.locations.values()].map((l) => ({ id: l.id, ...projectLatLng(l.lat, l.lng, idx.refLat) }));
  const r = mulberry32(3);
  const { north, south, east, west } = store.meta.bbox;
  const qs = Array.from({ length: 10000 }, () => projectLatLng(south + r() * (north - south), west + r() * (east - west), idx.refLat));
  let agree = 0, visited = 0;
  const [treeMs, treeHits] = time(() => qs.map((q) => { const h = idx.tree.nearest(q.x, q.y); visited += h.visited; return h.dist; }));
  const [bruteMs, bruteHits] = time(() => qs.map((q) => { let b = Infinity; for (const p of pts) { const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2; if (d < b) b = d; } return Math.sqrt(b); }));
  treeHits.forEach((d, i) => { if (Math.abs(d - bruteHits[i]) < 1e-9) agree++; });
  const [buildMs] = best(3, () => new NodeIndex(g));
  out.kdtree = { points: pts.length, queries: qs.length, buildMs: r1(buildMs), treeMs: r1(treeMs), bruteMs: r1(bruteMs), speedup: r1(bruteMs / treeMs), agree, visitedMean: r1(visited / qs.length) };
}

log('4/7 greedy vs Hungarian (300 bursts, all units free; then half the units busy)');
const burstSummary = (b) => { const { rows, ...s } = b; return s; };
out.burstFree = burstSummary(runBurstBenchmark(store, 300));
out.burstHalfBusy = burstSummary(runBurstBenchmark(store, 300, { busyFraction: 0.5 }));
{
  const r = mulberry32(4);
  const m = Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => (r() < 0.2 ? Infinity : r() * 1000)));
  const [hm] = best(10, () => hungarian(m));
  const [gm] = best(10, () => greedyAssignment(m));
  out.hungarian50 = { size: '50 x 50 (20% impossible pairs)', hungarianMs: r2(hm), greedyMs: r2(gm) };
}

log('5/7 Tarjan');
{
  const [bm, b] = best(5, () => bridgesAndArticulationPoints(g));
  const [sm, s] = best(5, () => stronglyConnectedComponents(g));
  out.tarjan = { bridgesApMs: r1(bm), bridges: b.bridges.length, articulationPoints: b.articulationPoints.length, sccMs: r1(sm), components: s.components.length };
}

log('6/7 multi-source Dijkstra, coverage, Edmonds-Karp, k-center');
{
  const flood = new FloodService({ store, elevation: loadJson(ELEVATION_FILE), rivers: loadJson(RIVER_FILE).rivers });
  const planning = new PlanningService({ store, flood });
  const [mm] = best(5, () => dijkstraAll(g, planning.fireNodes));
  const [cm, cov] = best(3, () => { planning.cache.clear(); return planning.coverage('fire'); });
  const ev = await planning.computeEvacuation();
  const [pm, pl] = await (async () => { const t = performance.now(); const v = await planning.computePlacement(); return [performance.now() - t, v]; })();
  out.planning = {
    multiSourceMs: r1(mm), coverageMs: r1(cm), coveragePct8: cov.pct8,
    edmondsKarp: { normal: { ms: ev.normal.ms, augmentations: ev.normal.augmentations, evacuable: ev.normal.evacuable, total: ev.normal.totalPeople }, flood: { ms: ev.flood.ms, augmentations: ev.flood.augmentations, evacuable: ev.flood.evacuable } },
    kcenter: { totalMs: Math.round(pm), candidates: pl.normal.candidates, scenarios: 2 },
  };
}

log('7/7 writing results');
out.totalS = r1((performance.now() - t0) / 1000);
fs.writeFileSync(path.join(DATA_DIR, 'benchmarks.json'), JSON.stringify(out, null, 1));

// ---- markdown ----
const c = out.pathCentral, f = out.pathFull, k = out.kdtree, bf = out.burstFree, bb = out.burstHalfBusy, p = out.planning;
const fullRow = f.skipped ? `| Full Pune | — | — | — | — | skipped: ${f.reason} |` : `| Full Pune (${f.junctions.toLocaleString('en-IN')} junctions, ${f.pairs} pairs) | ${f.dijkstra.meanMs} ms / ${f.dijkstra.settledMean.toLocaleString('en-IN')} | ${f.astar.meanMs} ms / ${f.astar.settledMean.toLocaleString('en-IN')} | ${f.settledRatioPct}% | ${f.speedup}× | ${f.sameCost}/${f.pairs} |`;
const md = `<!-- BENCHMARKS:START -->
Generated by \`node scripts/bench.mjs\` on ${out.generatedAt.slice(0, 10)} (${out.machine.cpu}, ${out.machine.cores} threads, Node ${out.machine.node}); took ${out.totalS} s. Also shown on \`/benchmarks\`.

**Shortest paths: Dijkstra vs A\\*** (mean time / mean junctions settled per query)

| Graph | Dijkstra | A* | A* settles | A* speed-up | Same cost |
|---|---|---|---|---|---|
| Central Pune (${c.junctions.toLocaleString('en-IN')} junctions, ${c.pairs} pairs) | ${c.dijkstra.meanMs} ms / ${c.dijkstra.settledMean.toLocaleString('en-IN')} | ${c.astar.meanMs} ms / ${c.astar.settledMean.toLocaleString('en-IN')} | ${c.settledRatioPct}% | ${c.speedup}× | ${c.sameCost}/${c.pairs} |
${fullRow}

**Nearest junction: k-d tree vs brute force** (${k.queries.toLocaleString('en-IN')} queries over ${k.points.toLocaleString('en-IN')} junctions)

| k-d tree | Brute force | Speed-up | Same answer | Nodes visited per query | Build |
|---|---|---|---|---|---|
| ${k.treeMs} ms | ${k.bruteMs} ms | ${k.speedup}× | ${k.agree.toLocaleString('en-IN')}/${k.queries.toLocaleString('en-IN')} | ${k.visitedMean} | ${k.buildMs} ms |

**Greedy vs Hungarian** (300 random 8-incident bursts; seconds of total ETA saved by Hungarian, over bursts where both serve the same incidents)

| Units | Comparable bursts | Hungarian better / equal / worse | Mean | Median | Max | Mean when better |
|---|---|---|---|---|---|---|
| All free | ${bf.validSeeds} | ${bf.greedyWorse} / ${bf.equal} / ${bf.hungarianWorse} | ${bf.savingS.mean} s (${bf.savingPct.mean}%) | ${bf.savingS.median} s | ${bf.savingS.max} s (${bf.savingPct.max}%) | ${bf.whenGreedyWorse?.meanS ?? '—'} s |
| Half busy (seeded) | ${bb.validSeeds} (avg ${bb.servedMean} served) | ${bb.greedyWorse} / ${bb.equal} / ${bb.hungarianWorse} | ${bb.savingS.mean} s (${bb.savingPct.mean}%) | ${bb.savingS.median} s | ${bb.savingS.max} s (${bb.savingPct.max}%) | ${bb.whenGreedyWorse?.meanS ?? '—'} s |

Hungarian served more incidents than greedy in ${bf.hungarianServedMore} (all free) and ${bb.hungarianServedMore} (half busy) bursts. The demo burst (seed ${bf.demo.seed}) is the clearest of the 300 (${bf.demo.savingS} s). A 50 × 50 matrix takes ${out.hungarian50.hungarianMs} ms (Hungarian) vs ${out.hungarian50.greedyMs} ms (greedy).

**Other algorithms on central Pune**

| Algorithm | Time | Result |
|---|---|---|
| Tarjan bridges + articulation points (iterative) | ${out.tarjan.bridgesApMs} ms | ${out.tarjan.bridges.toLocaleString('en-IN')} bridges, ${out.tarjan.articulationPoints.toLocaleString('en-IN')} articulation points |
| Tarjan SCC (iterative) | ${out.tarjan.sccMs} ms | ${out.tarjan.components} component(s) |
| Multi-source Dijkstra (5 fire stations) | ${p.multiSourceMs} ms | every junction's time to the nearest station |
| Coverage isochrones (fire) | ${p.coverageMs} ms | ${p.coveragePct8}% of road length within 8 min |
| Edmonds-Karp evacuation, normal | ${p.edmondsKarp.normal.ms} ms | ${p.edmondsKarp.normal.augmentations} augmenting paths, ${p.edmondsKarp.normal.evacuable.toLocaleString('en-IN')} of ${p.edmondsKarp.normal.total.toLocaleString('en-IN')} people |
| Edmonds-Karp evacuation, 10 m flood | ${p.edmondsKarp.flood.ms} ms | ${p.edmondsKarp.flood.augmentations} augmenting paths, ${p.edmondsKarp.flood.evacuable.toLocaleString('en-IN')} people |
| Greedy k-center placement (2 scenarios) | ${p.kcenter.totalMs} ms | ${p.kcenter.candidates} candidates each (one Dijkstra per candidate) |
<!-- BENCHMARKS:END -->`;
fs.writeFileSync(path.join(DATA_DIR, 'benchmarks.md'), md);
const readmeFile = path.join(ROOT, 'README.md');
const readme = fs.readFileSync(readmeFile, 'utf8');
if (readme.includes('<!-- BENCHMARKS:START -->')) {
  fs.writeFileSync(readmeFile, readme.replace(/<!-- BENCHMARKS:START -->[\s\S]*<!-- BENCHMARKS:END -->/, md));
  log('README benchmark section updated');
}
log(md);
