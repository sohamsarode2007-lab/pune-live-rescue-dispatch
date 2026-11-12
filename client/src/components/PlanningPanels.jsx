import React, { useState } from 'react';
import { emitAck } from '../socket.js';
import { fmtDuration, fmtInt } from '../format.js';

export const COVERAGE_BANDS = [
  { label: '< 5 min', color: '#22c55e' }, { label: '5–8 min', color: '#a3e635' }, { label: '8–12 min', color: '#f59e0b' },
  { label: '> 12 min', color: '#ef4444' }, { label: 'unreachable', color: '#a855f7' }, { label: 'closed', color: '#475569' },
];

// Small line chart of coverage % over simulated time (history from the server).
function Sparkline({ history, field, color }) {
  if (!history || history.length < 2) return null;
  const w = 300, h = 46, xs = history.map((p) => p.simS), ys = history.map((p) => p[field]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys) - 1, y1 = Math.max(...ys) + 1;
  const pts = history.map((p) => `${((p.simS - x0) / Math.max(1, x1 - x0)) * (w - 4) + 2},${h - 2 - ((p[field] - y0) / Math.max(0.1, y1 - y0)) * (h - 4)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${field} coverage over time`}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}

// One-click demo: reset, free-flow, 10x, flood 0 -> 10 m, seeded SOS on both banks.
export function ScenarioControl({ scenario, onStarted }) {
  const [msg, setMsg] = useState(null);
  const start = async () => {
    if (!window.confirm('Start the "Monsoon flood" demo? This resets incidents, closures and the flood.')) return;
    const r = await emitAck('scenario:start', { id: 'monsoon' });
    setMsg(r.ok ? null : r.error ?? 'Could not start');
    if (r.ok) onStarted?.();
  };
  const s = scenario ?? {};
  return (
    <div className="scenario">
      <button type="button" className="scenario-btn" onClick={start}>▶ Monsoon flood demo</button>
      {s.id && (
        <p className="note">
          {s.running ? 'Running' : 'Finished'}: flood step {s.levelStep}/{s.levelSteps}{s.nextLevel ? ` (next ${s.nextLevel.level} m at sim ${fmtDuration(s.nextLevel.atS)})` : ''}
          {' · '}SOS calls {s.callsSent}/{s.calls}
          {s.events?.map((e) => <span key={e.atS} className="scenario-event"><br />⚠ sim {fmtDuration(e.atS)}: {e.text}</span>)}
        </p>
      )}
      {msg && <p className="alert">{msg}</p>}
    </div>
  );
}

export function CoverageMini({ coverage }) {
  if (!coverage) return null;
  const h = coverage.history ?? [];
  const first = h[0];
  return (
    <div className="coverage-mini">
      <div><b>Fire coverage ≤ 8 min: {coverage.fire.pct8}%</b>{first && first.fire !== coverage.fire.pct8 && <span className="muted"> (was {first.fire}%)</span>}
        {' · '}ambulance {coverage.ambulance.pct8}%</div>
      <Sparkline history={h} field="fire" color="#f97316" />
    </div>
  );
}

export function CoveragePanel({ coverage, kind, onKind, show, onShow }) {
  if (!coverage) return null;
  const c = coverage[kind];
  return (
    <section className="panel">
      <h2>Coverage isochrones</h2>
      <div className="tabs small">
        <button type="button" className={kind === 'fire' ? 'on' : ''} onClick={() => onKind('fire')}>Fire stations ({coverage.fire.stations})</button>
        <button type="button" className={kind === 'ambulance' ? 'on' : ''} onClick={() => onKind('ambulance')}>Ambulance bases ({coverage.ambulance.stations})</button>
      </div>
      <p className="okmsg"><b>{c.pct8}%</b> of road length is reached within 8 min · average {fmtDuration(c.avgS)} · worst {fmtDuration(c.worstS)}{c.unreachableJunctions ? ` · ${fmtInt(c.unreachableJunctions)} junctions unreachable` : ''}</p>
      <label className="check"><input type="checkbox" checked={show} onChange={() => onShow(!show)} /> Colour every road by response time</label>
      <div className="legend-row">{COVERAGE_BANDS.map((b) => <span key={b.label}><i className="swatch" style={{ background: b.color }} />{b.label}</span>)}</div>
      <Sparkline history={coverage.history} field={kind === 'fire' ? 'fire' : 'ambulance'} color={kind === 'fire' ? '#f97316' : '#38bdf8'} />
      <p className="note">Multi-source Dijkstra from every {kind === 'fire' ? 'fire station' : 'ambulance base'} at once on the current network. It updates when roads close, so it shrinks as the flood rises. A road counts as reached when the vehicle reaches its entry junction.</p>
    </section>
  );
}

export function PlacementPanel({ placement, show, onShow }) {
  if (!placement || placement.computing) return <section className="panel"><h2>New station placement</h2><p className="muted">Computing greedy k-center…</p></section>;
  const row = (label, p) => (
    <tr>
      <th>{label}</th>
      <td>{fmtDuration(p.before.worstS)} → <b>{fmtDuration(p.suggestion.worstS)}</b></td>
      <td>{p.before.pct8}% → <b>{p.suggestion.pct8}%</b></td>
    </tr>
  );
  return (
    <section className="panel">
      <h2>New fire station placement</h2>
      <table className="cmp">
        <thead><tr><th></th><th>Worst-case fire response</th><th>Roads ≤ 8 min</th></tr></thead>
        <tbody>
          {row('Normal', placement.normal)}
          {row(`${placement.flood.level} m flood`, placement.flood)}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: 0 }}>
        Suggested: <b>N</b> near {placement.normal.suggestion.near ?? 'an unnamed road'} (normal) {placement.sameSuggestion ? 'and the same site for the flood.' : <>and <b>F</b> near {placement.flood.suggestion.near ?? 'an unnamed road'} under the flood: the best site differs.</>}
        {' '}Average response: {fmtDuration(placement.normal.before.avgS)} → {fmtDuration(placement.normal.suggestion.avgS)} (normal), {fmtDuration(placement.flood.before.avgS)} → {fmtDuration(placement.flood.suggestion.avgS)} (flood).
      </p>
      <label className="check"><input type="checkbox" checked={show} onChange={() => onShow(!show)} /> Show both suggestions on the map</label>
      <p className="note">Greedy k-center: Gonzalez farthest-first picks + the worst-served junctions give {placement.normal.candidates} candidates. Each one is scored by the new worst case (one Dijkstra per candidate), and the best is suggested. The flood scenario uses the road statuses of the fully spread {placement.flood.level} m flood ({fmtInt(placement.flood.closedRoads)} roads closed).</p>
    </section>
  );
}

export function EvacuationPanel({ evac, scenario, onScenario, show, onShow }) {
  if (!evac || evac.computing) return <section className="panel"><h2>Evacuation feasibility</h2><p className="muted">Computing max flow…</p></section>;
  const col = (x) => (
    <>
      <td><b>{fmtInt(x.evacuable)}</b> of {fmtInt(x.totalPeople)} ({x.pct}%)</td>
      <td>{x.stranded ? fmtInt(x.stranded) : '—'}</td>
      <td>{x.bottlenecks.length} roads{x.cut.shelters ? ` + shelters` : ''}</td>
    </>
  );
  const a = evac.assumptions;
  return (
    <section className="panel">
      <h2>Evacuation feasibility (max flow)</h2>
      <table className="cmp">
        <thead><tr><th></th><th>People evacuable</th><th>Boat only</th><th>Min cut</th></tr></thead>
        <tbody>
          <tr className={scenario === 'normal' ? 'exec' : ''} onClick={() => onScenario('normal')}><th>Normal</th>{col(evac.normal)}</tr>
          <tr className={scenario === 'flood' ? 'exec' : ''} onClick={() => onScenario('flood')}><th>{evac.level} m flood</th>{col(evac.flood)}</tr>
        </tbody>
      </table>
      <label className="check"><input type="checkbox" checked={show} onChange={() => onShow(!show)} /> Show the {scenario === 'flood' ? `${evac.level} m flood` : 'normal'} bottleneck roads (min cut) on the map</label>
      <p className="note">
        Edmonds-Karp from the {fmtInt(evac.affectedJunctions)} junctions the {evac.level} m flood floods or endangers ({a.peoplePerJunction} people each, simulated) over the roads
        (vehicles/h: trunk 2000, primary/secondary 1200, tertiary/residential 400; high-risk 50%; × {a.peoplePerVehicle} people per vehicle × {a.windowH} h) to {fmtInt(evac.normal.shelters)} shelters
        (schools, colleges, halls; capacity simulated). The min cut, the saturated edges leaving the source side, is the bottleneck. Normal: roads {fmtInt(evac.normal.cut.roads)} + shelters {fmtInt(evac.normal.cut.shelters)}.
        Flood: roads {fmtInt(evac.flood.cut.roads)} + shelters {fmtInt(evac.flood.cut.shelters)} + people already out {fmtInt(evac.flood.cut.supply)}.
      </p>
    </section>
  );
}
