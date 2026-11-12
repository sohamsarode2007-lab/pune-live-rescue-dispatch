import React, { useState } from 'react';
import { PRIORITY_WEIGHTS as W } from '../data/requestConstants.js';
import {
  SEVERITY, createRequest, assignRequest, completeRequest, requestStats,
  buildPriorityQueue, selectNextRequest, priorityScore,
} from '../services/requestService.js';

const EMPTY = { locationId: '', disasterType: 'FLOOD', severity: 'MEDIUM', peopleAffected: '1', waitingTimeScore: '0' };

export default function RescueRequestPanel({ sim, selectedId, onSelect, source, onChange }) {
  const { graph, requests } = sim;
  const [view, setView] = useState('priority');
  const [form, setForm] = useState(EMPTY);
  const [msg, setMsg] = useState(null);          // { kind: 'ok' | 'error', text }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const stats = requestStats(requests);
  const queue = buildPriorityQueue(requests);
  const ranked = queue.toSortedArray();                                   // pending only, highest priority first
  const others = requests.list().filter((r) => r.status !== 'PENDING');
  const rows = view === 'priority'
    ? [...ranked.map((r, i) => ({ r, rank: i + 1 })), ...others.map((r) => ({ r, rank: null }))]
    : requests.list().map((r) => ({ r, rank: null }));
  const sel = selectedId ? requests.get(selectedId) : null;

  const run = (result, okText) => {
    setMsg(result.ok ? { kind: 'ok', text: okText(result) } : { kind: 'error', text: result.error });
    if (result.ok) onChange();
  };
  const selectNext = () => {
    const next = selectNextRequest(requests);
    if (!next) return setMsg({ kind: 'error', text: 'No pending requests to select.' });
    onSelect(next.id);
    setMsg({ kind: 'ok', text: `Next by priority: ${next.id} (score ${priorityScore(next)}).` });
  };
  const submit = (e) => {
    e.preventDefault();
    const res = createRequest(requests, graph, {
      ...form, peopleAffected: Number(form.peopleAffected), waitingTimeScore: Number(form.waitingTimeScore),
    });
    run(res, (x) => `Added ${x.request.id}.`);
    if (res.ok) { onSelect(res.request.id); setForm({ ...EMPTY, locationId: form.locationId }); }
  };

  const locs = [...graph.locations.values()];
  const loc = (id) => graph.getLocation(id)?.name ?? id;

  return (
    <section className="card" aria-labelledby="rq-h">
      <h2 id="rq-h">Rescue requests</h2>
      <p className="muted">
        {stats.active} active ({stats.pending} pending, {stats.assigned} assigned) · {stats.completed} completed ·
        by level: {Object.entries(stats.bySeverity).reverse().map(([k, n]) => `${k[0] + k.slice(1).toLowerCase()} ${n}`).join(', ')}
      </p>
      <div className="btn-row">
        <button onClick={selectNext}>Select next request</button>
        <button onClick={() => setView('priority')} aria-pressed={view === 'priority'} className={view === 'priority' ? 'on' : ''}>Priority order</button>
        <button onClick={() => setView('all')} aria-pressed={view === 'all'} className={view === 'all' ? 'on' : ''}>All requests</button>
      </div>
      {msg && <p className={msg.kind === 'error' ? 'alert' : 'okmsg'} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</p>}

      {rows.length === 0 ? (
        <p className="muted">No requests yet. Activate a scenario or add one below.</p>
      ) : (
        <div className="scroll-x">
          <table className="cmp req-table">
            <thead><tr><th>#</th><th>ID</th><th>Location</th><th>Sev.</th><th>People</th><th>Wait</th><th>Score</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map(({ r, rank }) => (
                <tr key={r.id} className={r.id === selectedId ? 'sel' : ''}>
                  <td>{rank ?? '–'}</td>
                  <td><button className="link" onClick={() => onSelect(r.id)} aria-pressed={r.id === selectedId}>{r.id}</button></td>
                  <td>{r.locationId}</td>
                  <td>{r.severity}</td>
                  <td>{r.peopleAffected}</td>
                  <td>{r.waitingTimeScore}</td>
                  <td>{priorityScore(r)}</td>
                  <td>{r.status}{r.assignedStation ? ` (${r.assignedStation})` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view === 'priority' && ranked.length > 0 && <p className="note">Ranked by score, then longer waiting time, then request ID. Only pending requests are ranked.</p>}

      {sel && (
        <div className="subcard">
          <h3>{sel.id} – {loc(sel.locationId)}</h3>
          <p className="formula">
            {W.severity}×{SEVERITY[sel.severity]} + {W.people}×min({sel.peopleAffected},{W.peopleCap}) + min({sel.waitingTimeScore},{W.waitingCap})
            {' '}= <b>{priorityScore(sel)}</b>
          </p>
          <div className="btn-row">
            <button disabled={sel.status !== 'PENDING'} onClick={() => run(assignRequest(requests, graph, sel.id, source), (x) => `${sel.id} assigned to ${x.stationId} (route cost ${x.route.totalCost}).`)}>
              Assign {source}
            </button>
            <button disabled={sel.status !== 'PENDING'} onClick={() => run(assignRequest(requests, graph, sel.id), (x) => `${sel.id} assigned to recommended station ${x.stationId} (route cost ${x.route.totalCost}).`)}>
              Assign recommended
            </button>
            <button disabled={sel.status === 'COMPLETED'} onClick={() => run(completeRequest(requests, sel.id), () => `${sel.id} marked completed.`)}>
              Mark completed
            </button>
          </div>
        </div>
      )}

      <details>
        <summary>Priority queue internals (max-heap)</summary>
        <p className="note">Array order of the heap (index 0 is the root = next request). Parent of index i is ⌊(i−1)/2⌋.</p>
        <p className="mono">{queue.heapArray().map((r, i) => `[${i}] ${r.id}:${priorityScore(r)}`).join('  ') || '(empty)'}</p>
      </details>

      <h3>Add a request</h3>
      <form onSubmit={submit} className="form-grid">
        <label>Incident location
          <select value={form.locationId} onChange={set('locationId')} required>
            <option value="">Select…</option>
            {locs.map((l) => <option key={l.id} value={l.id}>{l.id} – {l.name}</option>)}
          </select>
        </label>
        <label>Disaster type
          <select value={form.disasterType} onChange={set('disasterType')}>
            {['FLOOD', 'FIRE', 'OTHER'].map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label>Severity
          <select value={form.severity} onChange={set('severity')}>
            {Object.keys(SEVERITY).map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label>People affected
          <input type="number" min="1" step="1" value={form.peopleAffected} onChange={set('peopleAffected')} />
        </label>
        <label>Waiting-time score
          <input type="number" min="0" step="1" value={form.waitingTimeScore} onChange={set('waitingTimeScore')} />
        </label>
        <button type="submit">Add request</button>
      </form>
      <p className="note">The priority formula and its weights are illustrative demonstration parameters, not validated emergency triage criteria.</p>
    </section>
  );
}
