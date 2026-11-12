// Phase 7: event log (JSONL with simulated timestamps) and the saved Monsoon demo replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventLog, compactForLog, listReplays } from '../server/services/eventLog.js';
import { ROOT } from './helpers.js';

const SAVED = path.join(ROOT, 'server', 'data', 'replays', 'monsoon-demo.jsonl');

test('EventLog writes one JSON object per line with simulated time; big payloads are compacted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-'));
  const log = new EventLog({ dir, now: () => Date.parse('2026-11-12T10:00:00Z') });
  const file = log.open('test');
  log.write('incident:updated', { id: 'INC-001', status: 'PENDING' }, 12.34);
  log.write('hazard:updated', [{ id: 'e1', status: 'BLOCKED', source: 'flood', geometry: [[1, 2], [3, 4]] }], 15);
  log.close();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].type, 'meta');
  assert.deepEqual(lines[1], { t: 12.3, type: 'incident:updated', data: { id: 'INC-001', status: 'PENDING' } });
  assert.deepEqual(lines[2], { t: 15, type: 'closures', data: [['e1', 'BLOCKED', 'flood']] }, 'road shapes are not logged');
  assert.equal(compactForLog('coverage:updated', { fire: 1, history: [1, 2] }).data.history, undefined);
  assert.deepEqual(listReplays(dir, path.join(dir, 'none')).map((x) => x.kind), ['saved']);
});

test('the saved Monsoon demo log replays the whole story: ordered times, 12 SOS, flood to 10 m, closures, a reroute',
  { skip: !fs.existsSync(SAVED) && 'run node scripts/record-demo.mjs' }, () => {
    const evs = fs.readFileSync(SAVED, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    for (let i = 1; i < evs.length; i++) assert.ok(evs[i].t >= evs[i - 1].t, `line ${i + 1} goes back in time`);
    assert.equal(evs[0].type, 'meta');
    assert.equal(evs[0].data.deterministic, true);
    assert.ok(evs.some((e) => e.type === 'state:init'));
    const ids = new Set(evs.filter((e) => e.type === 'incident:updated').map((e) => e.data.id));
    assert.equal(ids.size, 12);
    assert.equal(Math.max(...evs.filter((e) => e.type === 'flood:updated').map((e) => e.data.level)), 10);
    assert.ok(evs.some((e) => e.type === 'closures' && e.data.some(([, s]) => s === 'BLOCKED')));
    assert.ok(evs.some((e) => e.type === 'unit:rerouted' && e.data.outcome === 'rerouted'));
    assert.ok(evs.filter((e) => e.type === 'unit:position').length > 100, 'unit movement is recorded');
    assert.ok(evs.some((e) => e.type === 'scenario:updated' && e.data.events?.some((x) => /New Sangam/.test(x.text))));
  });
