// Greedy vs Hungarian on 300 random burst seeds (every unit at its station, free-flow).
// Writes server/data/burst-benchmark.json (shown in the dispatcher's burst panel and in the README).
//   node scripts/bench-burst.mjs [seeds]
import fs from 'node:fs';
import path from 'node:path';
import { GraphStore } from '../server/services/graphStore.js';
import { runBurstBenchmark } from '../server/services/burstBenchmark.js';
import { DATA_DIR, FACILITIES_FILE, GRAPH_FILE } from '../server/config.js';

const store = GraphStore.fromFiles(GRAPH_FILE, FACILITIES_FILE);
const t0 = performance.now();
const b = runBurstBenchmark(store, Number(process.argv[2] ?? 300));
fs.writeFileSync(path.join(DATA_DIR, 'burst-benchmark.json'), JSON.stringify(b, null, 1));
console.log(`${b.seeds} seeds in ${((performance.now() - t0) / 1000).toFixed(1)} s; ${b.validSeeds} with all 8 served by both`);
console.log(`greedy worse: ${b.greedyWorse}, equal: ${b.equal}, Hungarian worse: ${b.hungarianWorse}`);
console.log('saving (s):', b.savingS, ' saving (%):', b.savingPct);
console.log(`demo seed ${b.demo.seed}: ${b.demo.savingS} s (${b.demo.savingPct}%), clearest of all: ${b.demo.isClearest}`);
