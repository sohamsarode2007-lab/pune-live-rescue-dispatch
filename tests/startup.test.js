// Regression: at startup the crossing ranking (async, yields between crossings) overlaps the station
// placement, which temporarily applies the 10 m flood statuses and restores them. That used to bump
// graph.version, so rankCrossings() abandoned its run and resolved to null -> server/index.js crashed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FloodService } from '../server/services/floodService.js';
import { PlanningService } from '../server/services/planningService.js';
import { NetworkService } from '../server/services/networkService.js';
import { hasPuneData, loadPune, ROOT } from './helpers.js';

const D = (f) => path.join(ROOT, 'server', 'data', f);
const skip = !(hasPuneData && fs.existsSync(D('elevation.json'))) && 'Pune data not generated';
const json = (f) => JSON.parse(fs.readFileSync(D(f), 'utf8'));

async function setup() {
  const store = await loadPune();
  store.resetRoads();
  const rivers = json('river.json').rivers;
  const flood = new FloodService({ store, elevation: json('elevation.json'), rivers });
  return { store, planning: new PlanningService({ store, flood }), network: new NetworkService({ store, rivers }) };
}

test('station placement leaves graph.version unchanged, so a concurrent crossing ranking completes (startup overlap)',
  { skip }, async () => {
    const { store, planning, network } = await setup();
    const v = store.graph.version;
    const ranking = network.rankCrossings();          // starts now, yields between crossings
    await new Promise((r) => setImmediate(r));
    await planning.computePlacement();                 // applies + restores the 10 m flood statuses meanwhile
    assert.ok(planning.placementResult.flood.closedRoads > 0, 'the flood scenario really changed road statuses');
    assert.equal(store.graph.version, v, 'temporary scenario statuses do not count as a network change');
    const c = await ranking;
    assert.ok(c, 'rankCrossings() never resolves to null');
    assert.equal(c.status, 'ready');
    assert.equal(c.ranking.length, network.crossingDefs.length);
  });

test('a real network change mid-ranking reschedules and resolves to the (stale) state, not null', { skip }, async () => {
  const { store, network } = await setup();
  const road = network.crossingDefs[0].roadIds[0];
  const ranking = network.rankCrossings();
  await new Promise((r) => setImmediate(r));
  store.setRoadStatus(road, 'BLOCKED');
  try {
    const c = await ranking;
    assert.ok(c, 'rankCrossings() never resolves to null');
    assert.equal(c.status, 'computing');
    assert.ok(network.timer, 'a fresh ranking is scheduled');
    assert.equal(network.summary().crossings.stale, true);
  } finally {
    clearTimeout(network.timer);
    store.setRoadStatus(road, 'OPEN');
  }
});
