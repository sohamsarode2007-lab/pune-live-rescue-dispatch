import React from 'react';
import { fmtDuration, fmtInt } from '../format.js';

const KIND_TEXT = {
  trap: 'can be entered but not left',
  'no-entry': 'can be left but not entered',
  isolated: 'completely cut off',
  passage: 'one-way passage only',
};
const FAC_LABEL = { hospital: 'hospital', fire_station: 'fire station', police: 'police station', shelter: 'shelter' };

const facText = (f) => Object.entries(f).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${FAC_LABEL[k]}${n > 1 ? 's' : ''}`).join(', ');

// Warning shown on every dispatcher tab when closures create trap zones (Tarjan SCC).
export function TrapZoneWarning({ summary }) {
  const zones = summary?.trapZones ?? [];
  if (!zones.length) return null;
  return (
    <section className="panel warn-panel" role="alert">
      <h2>⚠ Closures created {zones.length} trap zone{zones.length > 1 ? 's' : ''}</h2>
      <ul className="zones">
        {zones.slice(0, 6).map((z) => (
          <li key={z.id}>
            <b>{z.id}</b>: {fmtInt(z.junctions)} junction{z.junctions > 1 ? 's' : ''} {KIND_TEXT[z.kind]}
            {z.facilitiesTotal > 0 && <> · contains {facText(z.facilities)}{z.facilityList?.length ? ` (${z.facilityList.map((f) => f.name).slice(0, 3).join(', ')})` : ''}</>}
          </li>
        ))}
      </ul>
      {summary.trivialZones > 0 && <p className="note">Not listed: {fmtInt(summary.trivialJunctions)} junction{summary.trivialJunctions > 1 ? 's' : ''} in {fmtInt(summary.trivialZones)} tiny zone{summary.trivialZones > 1 ? 's' : ''} (1–2 junctions, e.g. under flood water, no facility).</p>}
      <p className="note">Strongly connected components of the directed road graph (Tarjan SCC), recomputed after every closure. Units cannot get out of a trap, and nobody can get into a no-entry zone. Zones with ≥ 3 junctions or a facility are listed.</p>
    </section>
  );
}

export function SpofPanel({ spof, showAll, onShowAll }) {
  if (!spof) return <section className="panel"><h2>Single points of failure</h2><p className="muted">Computing…</p></section>;
  const c = spof.counts;
  const crit = spof.bridges.filter((b) => b.critical);
  const critAp = spof.articulationPoints.filter((a) => a.critical);
  return (
    <section className="panel">
      <h2>Single points of failure</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Tarjan (iterative) on the undirected road graph, {spof.ms} ms. <b>{c.criticalBridges}</b> critical roads (bridges) and <b>{c.criticalArticulationPoints}</b> critical
        junctions (articulation points): losing one cuts off ≥ 50 junctions or a facility.
        Filtered out as trivial (mostly dead-end lanes): {fmtInt(c.bridges - c.criticalBridges)} bridges, {fmtInt(c.articulationPoints - c.criticalArticulationPoints)} junctions.
      </p>
      <label className="check"><input type="checkbox" checked={showAll} onChange={() => onShowAll(!showAll)} /> Show all {fmtInt(c.bridges)} bridges and {fmtInt(c.articulationPoints)} junctions on the map</label>
      <table className="cmp">
        <thead><tr><th>Road</th><th>Cuts off</th><th>Facilities inside</th></tr></thead>
        <tbody>
          {crit.slice(0, 8).map((b) => (
            <tr key={b.roadId}>
              <th>{b.name || 'Unnamed road'}</th>
              <td>{fmtInt(b.cutJunctions)}</td>
              <td>{b.facilitiesCutOffTotal ? facText(b.facilitiesCutOff) : '—'}{b.losesAccessTo.length > 0 && <div className="muted">loses: {b.losesAccessTo.map((k) => FAC_LABEL[k]).join(', ')}</div>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {critAp.length > 0 && <p className="note">Largest critical junction: {critAp[0].nodeId} splits the network into {critAp[0].pieces} parts, cutting off {fmtInt(critAp[0].cutJunctions)} junctions{critAp[0].facilitiesCutOffTotal ? ` incl. ${facText(critAp[0].facilitiesCutOff)}` : ''}.</p>}
    </section>
  );
}

export function crossingText(c) {
  return `If this floods: +${fmtDuration(c.fire.avgIncreaseS)} average and +${fmtDuration(c.fire.worstIncreaseS)} worst-case fire-station response, `
    + `up to +${fmtDuration(c.fire.maxJunctionIncreaseS)} at the worst-hit junction; ${c.lostMajorHospitalWithin8} junction${c.lostMajorHospitalWithin8 === 1 ? ' loses' : 's lose'} major-hospital access within 8 min.`;
}

export function CrossingsPanel({ state, selectedId, onSelect, onSetStatus }) {
  if (!state || state.status === 'idle') return null;
  const sel = state.ranking?.find((c) => c.id === selectedId);
  return (
    <section className="panel">
      <h2>River crossing importance {state.status === 'computing' && <span className="muted">· updating…</span>}</h2>
      {state.baseline && (
        <p className="note" style={{ marginTop: 0 }}>
          Each Mutha / Mula-Mutha crossing removed alone; multi-source Dijkstra from the {state.baseline.fireStations} fire stations (fire trucks and boats) and from all {state.baseline.stations} unit bases.
          Baseline fire response: average {fmtDuration(state.baseline.fire.avgS)}, worst {fmtDuration(state.baseline.fire.worstS)}.
        </p>
      )}
      <table className="cmp crossings">
        <thead><tr><th>#</th><th>Crossing</th><th title="increase in average fire-station response">+avg</th><th title="increase in worst-case fire-station response">+worst</th><th title="junctions losing major-hospital access within 8 min">−8 min</th></tr></thead>
        <tbody>
          {(state.ranking ?? []).map((c) => (
            <tr key={c.id} className={c.id === selectedId ? 'sel' : ''} onClick={() => onSelect(c.id)}>
              <td>{c.rank}</td>
              <th>{c.name}{c.closed && <span className="pill BLOCKED">closed</span>}</th>
              <td>{fmtDuration(c.fire.avgIncreaseS)}</td>
              <td>{fmtDuration(c.fire.worstIncreaseS)}</td>
              <td>{c.lostMajorHospitalWithin8}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sel && (
        <div className="subnote">
          <b>{sel.name}</b> ({sel.river}, {sel.roadIds.length} road{sel.roadIds.length > 1 ? 's' : ''})<br />
          {crossingText(sel)}
          <br /><span className="muted">All unit bases: +{fmtDuration(sel.allBases.avgIncreaseS)} average. {sel.fire.newlyUnreachable > 0 ? `${sel.fire.newlyUnreachable} junction(s) (bridge ramps) only reachable over this crossing.` : ''}</span>
          <div className="btn-row" style={{ marginTop: 6 }}>
            {sel.closed
              ? <button type="button" className="sm" onClick={() => onSetStatus(sel.id, 'OPEN')}>Reopen this crossing</button>
              : <button type="button" className="danger sm" onClick={() => onSetStatus(sel.id, 'BLOCKED')}>Close this crossing (flood)</button>}
          </div>
        </div>
      )}
      <p className="note">Worst-case = the slowest junction anywhere. It rarely changes for one crossing because the 9 crossings back each other up. The ranking updates automatically after closures and traffic changes.</p>
    </section>
  );
}
