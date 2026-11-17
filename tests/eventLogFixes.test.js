import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventLog } from '../server/services/eventLog.js';

test('two logs opened within the same second get different files, and lines stay in order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evlog-'));
  const log = new EventLog({ dir, now: () => 1_700_000_000_000, flushMs: 60_000 });
  const a = log.open('reset'), b = log.open('reset');
  assert.notEqual(a, b);
  for (let i = 0; i < 5; i++) { log.write('tick', { i }, i); if (i === 2) log.flush(); }
  log.flushSync(); log.close();
  const ticks = fs.readFileSync(b, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'tick').map((e) => e.data.i);
  assert.deepEqual(ticks, [0, 1, 2, 3, 4]);
});
