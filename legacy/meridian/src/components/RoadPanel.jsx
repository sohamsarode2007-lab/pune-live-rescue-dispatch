import React from 'react';
import { ROAD_STATUS } from '../algorithms/Graph.js';

export default function RoadPanel({ graph, selected, onChangeStatus }) {
  let body = <p className="muted">Click a road or location on the map to see its details.</p>;

  if (selected?.kind === 'road') {
    const r = graph.getRoad(selected.id);
    const a = graph.getLocation(r.from), b = graph.getLocation(r.to);
    const cost = graph.effectiveCost(r);
    body = (
      <>
        <h3>Road {r.id}</h3>
        <dl className="kv">
          <dt>Connects</dt><dd>{a.name} ↔ {b.name}</dd>
          <dt>Distance</dt><dd>{r.distanceKm} km</dd>
          <dt>Status</dt><dd><span className={`pill ${r.status}`}>{r.status.replace('_', ' ')}</span></dd>
          <dt>Risk level</dt><dd>{r.riskLevel}</dd>
          <dt>Risk penalty</dt><dd>{r.status === 'BLOCKED' ? 'n/a' : r.riskPenalty}</dd>
          <dt>Effective cost</dt><dd>{cost === null ? 'Not traversable' : cost}</dd>
        </dl>
        <div className="btn-row">
          <button onClick={() => onChangeStatus(r.id, ROAD_STATUS.OPEN)} disabled={r.status === 'OPEN'}>Reopen</button>
          <button onClick={() => onChangeStatus(r.id, ROAD_STATUS.HIGH_RISK)} disabled={r.status === 'HIGH_RISK'}>Mark high-risk</button>
          <button className="danger" onClick={() => onChangeStatus(r.id, ROAD_STATUS.BLOCKED)} disabled={r.status === 'BLOCKED'}>Block</button>
        </div>
      </>
    );
  } else if (selected?.kind === 'location') {
    const l = graph.getLocation(selected.id);
    const edges = graph.adjacency.get(l.id).map((e) => graph.getRoad(e.roadId));
    body = (
      <>
        <h3>{l.name}</h3>
        <dl className="kv">
          <dt>ID</dt><dd>{l.id}</dd>
          <dt>Type</dt><dd>{l.type}</dd>
          <dt>Affected</dt><dd>{l.affected ? 'Yes' : 'No'}</dd>
          <dt>Roads</dt>
          <dd>{edges.map((r) => {
            const other = graph.getLocation(r.from === l.id ? r.to : r.from);
            return <div key={r.id}>{r.id} → {other.id} ({r.distanceKm} km, <span className={`pill ${r.status}`}>{r.status.replace('_', ' ')}</span>)</div>;
          })}</dd>
        </dl>
      </>
    );
  }

  return (
    <section className="card" aria-labelledby="road-h">
      <h2 id="road-h">Road status controls</h2>
      {body}
    </section>
  );
}
