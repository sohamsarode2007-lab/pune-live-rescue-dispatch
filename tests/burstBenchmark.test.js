// Greedy vs Hungarian on all 300 random burst seeds (every unit at its station, free-flow).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBurstBenchmark } from '../server/services/burstBenchmark.js';
import { BURST_SEED } from '../server/services/burst.js';
import { hasPuneData, loadPune } from './helpers.js';

test('Hungarian total is never worse than greedy on any of the 300 burst seeds; the demo seed has the largest saving',
  { skip: !hasPuneData && 'Pune graph not generated' }, async () => {
    const store = await loadPune();
    store.resetRoads();
    const b = runBurstBenchmark(store, 300);
    assert.equal(b.rows.length, 300);
    for (const r of b.rows) {
      assert.ok(r.hungarianAssigned >= r.greedyAssigned, `seed ${r.seed}: Hungarian served fewer`);
      if (r.hungarianAssigned === r.greedyAssigned) assert.ok(r.savingS >= -0.05, `seed ${r.seed}: Hungarian worse by ${-r.savingS} s`);
    }
    assert.equal(b.hungarianWorse, 0);
    assert.ok(b.greedyWorse > 0, 'greedy is sometimes worse');
    assert.equal(b.clearestSeed, BURST_SEED, 'the demo pattern is the clearest (largest seconds saved) of the 300');
    assert.ok(b.savingS.min >= 0 && b.savingS.max >= b.savingS.mean && b.savingS.mean >= b.savingS.median);
  });
