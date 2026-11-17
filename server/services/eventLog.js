// Event log (Phase 7): every event the dispatcher sees, one JSON object per line (JSONL), stamped with the
// SIMULATED time: { "t": 123.5, "type": "incident:updated", "data": {...} }. A new log file starts on
// server start, sim reset and scenario start. The /replay page plays these files back at 1x / 5x / 10x.
// Writes are buffered and flushed once per second (appendFile), so logging never blocks the sim loop.
import fs from 'node:fs';
import path from 'node:path';

export const LOG_VERSION = 1;

// Shrinks payloads that are large but derivable at replay time.
export function compactForLog(type, data) {
  if (type === 'hazard:updated') return { type: 'closures', data: data.map((r) => [r.id, r.status, r.source ?? null]) };
  if (type === 'unit:updated') return { type, data: { ...data, route: data.route?.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]) } };
  if (type === 'coverage:updated') { const { history, ...rest } = data; return { type, data: rest }; }
  return { type, data };
}

export class EventLog {
  constructor({ dir, now = () => Date.now(), flushMs = 1000 }) {
    this.dir = dir;
    this.now = now;
    this.file = null;
    this.buffer = [];
    this.lines = 0;
    this.opened = 0;
    fs.mkdirSync(dir, { recursive: true });
    this.timer = setInterval(() => this.flush(), flushMs);
    this.timer.unref?.();
  }

  open(label, meta = {}) {
    this.flush();
    const d = new Date(this.now());
    const stamp = d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    // milliseconds + a counter: two resets inside one second must not append to the same file
    const uniq = `${String(d.getMilliseconds()).padStart(3, '0')}${this.opened++ ? `-${this.opened}` : ''}`;
    this.file = path.join(this.dir, `events-${stamp}${uniq}-${label}.jsonl`);
    this.lines = 0;
    this.write('meta', { version: LOG_VERSION, label, startedAt: new Date(this.now()).toISOString(), ...meta }, 0);
    return this.file;
  }

  write(type, data, simS) {
    if (!this.file) return;
    const c = compactForLog(type, data);
    this.buffer.push(JSON.stringify({ t: Math.round(simS * 10) / 10, type: c.type, data: c.data }));
    this.lines++;
  }

  flush() {
    if (!this.file || !this.buffer.length) return;
    const chunk = `${this.buffer.join('\n')}\n`;
    this.buffer = [];
    fs.appendFileSync(this.file, chunk);               // sync: an async append could land after a later flushSync()
  }

  flushSync() {
    if (!this.file || !this.buffer.length) return;
    fs.appendFileSync(this.file, `${this.buffer.join('\n')}\n`);
    this.buffer = [];
  }

  close() { this.flushSync(); clearInterval(this.timer); }
}

// Lists replayable logs: the saved demo logs (committed) and recent session logs.
export function listReplays(savedDir, logDir) {
  const list = [];
  for (const [dir, kind] of [[savedDir, 'saved'], [logDir, 'session']]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const st = fs.statSync(path.join(dir, f));
      if (st.size < 200) continue;
      list.push({ name: f, kind, bytes: st.size, modified: st.mtime.toISOString() });
    }
  }
  return list.sort((a, b) => (a.kind === b.kind ? b.modified.localeCompare(a.modified) : a.kind === 'saved' ? -1 : 1)).slice(0, 30);
}
