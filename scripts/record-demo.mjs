// Records one full "Monsoon flood demo" run, headless, into server/data/replays/monsoon-demo.jsonl.
// It uses the same simStep() as the server and the scenario is deterministic, so this log is exactly what
// the live demo produces (free-flow traffic, 10x). /replay plays it with no network, no TomTom, no phone.
//   node scripts/record-demo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { GraphStore, loadJson } from '../server/services/graphStore.js';
import { DispatchService } from '../server/services/dispatchService.js';
import { FloodService } from '../server/services/floodService.js';
import { NetworkService } from '../server/services/networkService.js';
import { PlanningService } from '../server/services/planningService.js';
import { ScenarioRunner, monsoonScenario, simStep } from '../server/services/scenario.js';
import { EventLog } from '../server/services/eventLog.js';
import { ELEVATION_FILE, FACILITIES_FILE, GRAPH_FILE, REPLAY_DIR, RIVER_FILE } from '../server/config.js';

const OUT = path.join(REPLAY_DIR, 'monsoon-demo.jsonl');
const TICK_MS = 500;
const MAX_SIM_S = 30 * 60;

const store = GraphStore.fromFiles(GRAPH_FILE, FACILITIES_FILE);
const log = new EventLog({ dir: REPLAY_DIR });
fs.writeFileSync(OUT, '');
log.file = OUT;
let now = () => 0;
const dispatch = new DispatchService(store, { emit: (event, payload, rooms) => { if (rooms.includes('dispatch')) log.write(event, payload, now()); } });
now = () => dispatch.now;
const flood = new FloodService({ store, elevation: loadJson(ELEVATION_FILE), rivers: loadJson(RIVER_FILE).rivers });
const network = NetworkService.fromFile(store, RIVER_FILE);
const planning = new PlanningService({ store, flood });
const runner = new ScenarioRunner();
const def = monsoonScenario(flood.riverPoints, store.meta.bbox, network.crossingDefs);

dispatch.setSpeed(def.speed);
dispatch.setMode(def.dispatchMode);
runner.start(def, 0);
log.write('meta', { version: 1, label: 'monsoon', scenario: def.id, name: def.name, recordedBy: 'scripts/record-demo.mjs', deterministic: true, tickMs: TICK_MS, speed: def.speed }, 0);
log.write('state:init', dispatch.snapshot(), 0);
log.write('sim:speed', { speed: def.speed }, 0);
log.write('scenario:updated', runner.status(), 0);
log.write('flood:updated', flood.status(), 0);
log.write('coverage:updated', planning.coverageSummary(0), 0);

let floodKey = '';
for (;;) {
  const { roadsChanged, scenarioChanged } = simStep({ dispatch, flood, runner }, TICK_MS);
  const t = dispatch.now;
  if (roadsChanged) {
    log.write('hazard:updated', store.closedRoads(), t);
    log.write('coverage:updated', planning.coverageSummary(t), t);
    log.write('network:updated', network.summary(), t);
  }
  if (scenarioChanged) log.write('scenario:updated', runner.status(), t);
  const key = `${flood.level}|${flood.floodedNow}|${flood.applied.size}`;
  if (key !== floodKey) {
    floodKey = key;
    log.write('flood:updated', flood.status(), t);
    log.write('flood:points', flood.floodedPoints(t), t);
  }
  const done = !runner.status().running && [...dispatch.incidents.values()].every((i) => i.status === 'RESOLVED' || i.status === 'PENDING')
    && [...dispatch.units.values()].every((u) => u.status === 'AVAILABLE');
  if (done || t >= MAX_SIM_S) break;
}
log.write('meta:end', { simS: dispatch.now, incidents: dispatch.incidents.size, resolved: [...dispatch.incidents.values()].filter((i) => i.status === 'RESOLVED').length, reroutes: dispatch.reroutes.length }, dispatch.now);
log.close();
const size = fs.statSync(OUT).size;
console.log(`Recorded ${log.lines} events, ${Math.round(dispatch.now)} s of simulated time, ${(size / 1e6).toFixed(2)} MB -> ${OUT}`);
console.log(`incidents ${dispatch.incidents.size}, reroutes ${dispatch.reroutes.length}, flooded junctions ${flood.floodedNow}, fire coverage ${planning.coverageSummary().fire.pct8}%`);
