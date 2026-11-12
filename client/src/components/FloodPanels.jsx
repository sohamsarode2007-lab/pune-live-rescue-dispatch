import React, { useEffect, useState } from 'react';
import { emitAck } from '../socket.js';
import { fmtDuration, fmtInt, fmtTime } from '../format.js';

const STATUS_CLASS = { normal: 'okmsg', elevated: 'hint', 'flood alert': 'alert' };

// "Khadakwasla dam release" slider + GloFAS river discharge (Open-Meteo Flood API).
export function FloodPanel({ flood }) {
  const [level, setLevel] = useState(0);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (flood) setLevel(flood.level); }, [flood?.level]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!flood) return null;
  if (!flood.available) return <section className="panel"><h2>Flood</h2><p className="muted">Flood model unavailable: run scripts/build_elevation.py.</p></section>;
  const g = flood.glofas;
  const apply = async (l) => {
    setMsg(null);
    const r = await emitAck('flood:set', { level: l });
    if (!r.ok) setMsg({ bad: true, text: r.message });
  };
  const refresh = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await emitAck('flood:glofas', { apply: true }, 40000);
      setMsg(r.ok ? { text: `GloFAS refreshed: ${r.status}; level set to ${r.suggestedLevel} m.` } : { bad: true, text: r.error });
    } catch { setMsg({ bad: true, text: 'Server did not answer.' }); }
    setBusy(false);
  };
  const rising = flood.level > 0 && flood.floodedNow < flood.predictedFlooded;
  return (
    <section className="panel flood-panel">
      <h2>Mutha flood {flood.level > 0 && <span className="pill BLOCKED">{flood.level} m</span>}</h2>
      {g && (g.status || g.error) && (
        <div className={STATUS_CLASS[g.status] ?? 'muted'} style={{ marginTop: 0 }}>
          {g.status ? <>GloFAS river discharge: <b>{g.status}</b> · peak {g.peak?.m3s?.toFixed(1)} m³/s (next days) vs history p90 {g.p90?.toFixed(1)}, p99 {g.p99?.toFixed(1)} → suggests {g.suggestedLevel} m. <span className="muted">As of {fmtTime(g.fetchedAt)}.</span></> : null}
          {g.error && <div>{g.error}</div>}
        </div>
      )}
      <label className="slider-label">Khadakwasla dam release: water level above the river
        <div className="slider-row">
          <input type="range" min="0" max={flood.maxLevel} step="0.5" value={level} onChange={(e) => setLevel(Number(e.target.value))} aria-label="Water level in metres" />
          <b>{level.toFixed(1)} m</b>
        </div>
      </label>
      <div className="btn-row">
        <button type="button" className="danger" onClick={() => apply(level)} disabled={level === flood.level}>Set level</button>
        <button type="button" onClick={() => apply(0)} disabled={flood.level === 0}>Recede (0 m)</button>
        <button type="button" onClick={refresh} disabled={busy}>{busy ? 'Asking GloFAS…' : 'Use GloFAS level'}</button>
      </div>
      {msg && <p className={msg.bad ? 'alert' : 'okmsg'}>{msg.text}</p>}
      {flood.level > 0 && (
        <dl className="kv">
          <dt>Source</dt><dd>{flood.levelSource === 'glofas' ? 'GloFAS suggestion' : 'manual slider'}</dd>
          <dt>Flooded junctions</dt><dd><b>{fmtInt(flood.floodedNow)}</b> of {fmtInt(flood.predictedFlooded)} predicted{rising ? ' · rising' : ''}</dd>
          <dt>Roads</dt><dd>{fmtInt(flood.blockedRoads)} blocked · {fmtInt(flood.highRiskRoads)} high-risk</dd>
          <dt>Spread</dt><dd>{fmtDuration(flood.spreadS)} of simulated time (BFS outward from the river)</dd>
        </dl>
      )}
      <p className="note">{flood.note} GloFAS is a coarse (~5 km) global model and does not capture Khadakwasla dam releases, which is why the slider can override it. Units on flooded routes are rerouted automatically.</p>
    </section>
  );
}

// Recent reroutes (Phase 5 dynamic rerouting).
export function RerouteLog({ reroutes }) {
  if (!reroutes.length) return null;
  const OUT = {
    rerouted: (r) => `rerouted (+${fmtDuration(Math.max(0, r.extraS))})`,
    'incident-unreachable': () => 'incident unreachable, back to the queue',
    'other-hospital': () => 'hospital unreachable, going to another',
    'no-hospital-reachable': () => 'no hospital reachable',
    'home-unreachable': () => 'home unreachable, waiting',
  };
  return (
    <section className="panel">
      <h2>Reroutes <span className="pill merged">{reroutes.length}</span></h2>
      <ul className="zones">
        {[...reroutes].reverse().slice(0, 8).map((r, i) => (
          <li key={`${r.unitId}-${r.atS}-${i}`}><b>{r.unitId}</b>{r.incidentId ? ` → ${r.incidentId}` : ''}: {OUT[r.outcome]?.(r) ?? r.outcome} <span className="muted">({r.closedRoadIds.length} closed road{r.closedRoadIds.length > 1 ? 's' : ''} ahead, sim {fmtDuration(r.atS)})</span></li>
        ))}
      </ul>
      <p className="note">When a road ahead of a moving unit closes, it finishes its current road and re-plans with A* from the next junction.</p>
    </section>
  );
}

export function CrowdPanel({ crowd }) {
  if (!crowd.length) return null;
  return (
    <section className="panel">
      <h2>Crowd road reports</h2>
      <ul className="zones">
        {crowd.slice(0, 8).map((c) => (
          <li key={c.roadId}><b>{c.name}</b>: {c.reports}/{c.needed} phones {c.blocked ? <span className="pill BLOCKED">closed</span> : <span className="muted">(not closed yet)</span>}</li>
        ))}
      </ul>
      <p className="note">A road closes after 3 reports from different phones within 15 minutes.</p>
    </section>
  );
}
