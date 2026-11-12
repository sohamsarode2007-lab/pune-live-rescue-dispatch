// Finds a burst seed where, starting with every unit at its station, the Hungarian assignment beats
// greedy by a clear margin while both serve all 8 incidents. Usage: node scripts/find-burst-seed.mjs [maxSeed]
import path from 'node:path';
import { GraphStore } from '../server/services/graphStore.js';
import { DispatchService } from '../server/services/dispatchService.js';
import { ROOT } from '../server/config.js';

const store = GraphStore.fromFiles(path.join(ROOT, 'server/data/pune-central.graph.json'), path.join(ROOT, 'server/data/facilities.json'));
const svc = new DispatchService(store);
const max = Number(process.argv[2] ?? 300);
const results = [];
for (let seed = 1; seed <= max; seed++) {
  svc.reset();
  const { created, comparison: c } = svc.createBurst(seed);
  if (created.length !== 8 || c.greedy.assigned !== 8 || c.hungarian.assigned !== 8) continue;
  const saving = Math.round((c.greedy.totalS - c.hungarian.totalS) * 10) / 10;
  results.push({ seed, greedy: c.greedy.totalS, hungarian: c.hungarian.totalS, saving, pct: (100 * saving) / c.greedy.totalS });
}
results.sort((a, b) => b.saving - a.saving);
console.table(results.slice(0, 10).map((r) => ({ ...r, pct: r.pct.toFixed(1) })));
console.log(`${results.filter((r) => r.saving > 0.05).length} of ${results.length} valid seeds have greedy worse than optimal`);
