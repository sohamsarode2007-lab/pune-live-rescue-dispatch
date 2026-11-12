// Greedy vs Hungarian on many random burst patterns, every unit at its station, free-flow traffic.
// Each seed's 8 calls are planned once (same ETA matrix for both methods); nothing is executed.
import { DispatchService } from './dispatchService.js';
import { burstPattern, BURST_SEED } from './burst.js';
import { mulberry32 } from '../../shared/sim/random.js';

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null;
};
const r1 = (x) => {
  if (x == null) return null;
  const v = Math.round(x * 10) / 10;
  return v === 0 ? 0 : v;       // no "-0"
};

// busyFraction: share of units marked busy (ON_SCENE) before each burst, chosen with a seeded shuffle
// (per seed), to compare the two methods when units are scarce.
export function runBurstBenchmark(store, seeds = 300, { busyFraction = 0 } = {}) {
  const svc = new DispatchService(store);
  const rows = [];
  for (let seed = 1; seed <= seeds; seed++) {
    svc.reset();
    if (busyFraction > 0) {
      const r = mulberry32(seed * 7919 + 17);
      const units = [...svc.units.values()];
      for (let i = units.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [units[i], units[j]] = [units[j], units[i]]; }
      units.slice(0, Math.round(units.length * busyFraction)).forEach((u) => { u.status = 'ON_SCENE'; });
    }
    let created = 0;
    for (const c of burstPattern(seed, store.meta.bbox)) {
      if (!svc.submitCall({ ...c, source: 'burst' }, { dispatch: false }).merged) created++;
    }
    const p = svc.plan();
    rows.push({
      seed, created,
      greedyAssigned: p.greedy.assigned, hungarianAssigned: p.optimal.assigned,
      greedyS: r1(p.greedy.totalCost), hungarianS: r1(p.optimal.totalCost),
      savingS: r1(p.greedy.totalCost - p.optimal.totalCost),
      savingPct: r1((100 * (p.greedy.totalCost - p.optimal.totalCost)) / p.greedy.totalCost),
    });
  }
  // Summary over seeds where both methods serve the same number of incidents (the same incidents: priority
  // picks who is served when units are short), so the totals are directly comparable. With every unit free
  // that is all 8; with half the units busy it is often fewer.
  const valid = rows.filter((r) => r.created === 8 && r.greedyAssigned === r.hungarianAssigned && r.greedyAssigned > 0);
  const s = valid.map((r) => r.savingS), pct = valid.map((r) => r.savingPct);
  const best = valid.reduce((a, b) => (b.savingS > a.savingS ? b : a), valid[0]);          // by seconds saved
  const bestPct = valid.reduce((a, b) => (b.savingPct > a.savingPct ? b : a), valid[0]);   // by percentage
  const demo = rows.find((r) => r.seed === BURST_SEED);
  return {
    generatedAt: new Date().toISOString(),
    seeds, validSeeds: valid.length, busyFraction,
    servedMean: r1(valid.reduce((a, r) => a + r.hungarianAssigned, 0) / Math.max(1, valid.length)),
    hungarianServedMore: rows.filter((r) => r.hungarianAssigned > r.greedyAssigned).length,
    greedyWorse: valid.filter((r) => r.savingS > 0.05).length,
    equal: valid.filter((r) => Math.abs(r.savingS) <= 0.05).length,
    hungarianWorse: rows.filter((r) => r.hungarianAssigned < r.greedyAssigned || (r.hungarianAssigned === r.greedyAssigned && r.savingS < -0.05)).length,
    savingS: { mean: r1(s.reduce((a, b) => a + b, 0) / s.length), median: r1(median(s)), min: r1(Math.min(...s)), max: r1(Math.max(...s)) },
    savingPct: { mean: r1(pct.reduce((a, b) => a + b, 0) / pct.length), median: r1(median(pct)), min: r1(Math.min(...pct)), max: r1(Math.max(...pct)) },
    demo: { seed: BURST_SEED, ...demo, isClearest: best?.seed === BURST_SEED },
    whenGreedyWorse: (() => {
      const w = valid.filter((r) => r.savingS > 0.05);
      return w.length ? { meanS: r1(w.reduce((a, r) => a + r.savingS, 0) / w.length), meanPct: r1(w.reduce((a, r) => a + r.savingPct, 0) / w.length) } : null;
    })(),
    clearestSeed: best?.seed ?? null,
    highestPctSeed: bestPct ? { seed: bestPct.seed, savingS: bestPct.savingS, savingPct: bestPct.savingPct } : null,
    rows,
  };
}
