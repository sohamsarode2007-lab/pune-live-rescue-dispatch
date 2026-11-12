import React from 'react';
import { compareToBaseline } from '../services/comparisonService.js';
import { fmt, signed } from '../format.js';

const routeText = (r) => (r.reachable ? r.path.join(' → ') : 'UNREACHABLE');

export default function ComparisonPanel({ sim, source, destination, onSave }) {
  const b = sim.baseline;
  const cmp = b ? compareToBaseline(sim.graph, b) : null;

  return (
    <section className="card" aria-labelledby="cmp-h">
      <h2 id="cmp-h">Before / after comparison</h2>
      <button onClick={onSave} disabled={!destination}>
        Save baseline ({source} → {destination || '…'})
      </button>
      {!destination && <p className="muted">Choose a destination in the routing panel first.</p>}
      {b && b.destination !== destination && <p className="muted">Baseline saved for {b.source} → {b.destination}.</p>}
      {!b && destination && <p className="muted">Save the current route as a baseline, then activate a scenario or edit roads.</p>}

      {cmp && (
        <>
          <table className="cmp">
            <thead><tr><th></th><th>Baseline</th><th>Now</th></tr></thead>
            <tbody>
              <tr><th>Route</th><td>{routeText(cmp.before)}</td><td className={cmp.after.reachable ? '' : 'bad'}>{routeText(cmp.after)}</td></tr>
              <tr><th>Distance</th><td>{cmp.before.reachable ? `${fmt(cmp.before.totalDistanceKm)} km` : '—'}</td><td>{cmp.after.reachable ? `${fmt(cmp.after.totalDistanceKm)} km` : '—'}</td></tr>
              <tr><th>Cost</th><td>{cmp.before.reachable ? fmt(cmp.before.totalCost) : '—'}</td><td>{cmp.after.reachable ? fmt(cmp.after.totalCost) : '—'}</td></tr>
              <tr><th>Status</th><td>{cmp.before.reachable ? 'Reachable' : 'Unreachable'}</td><td>{cmp.status === 'REACHABLE' ? 'Reachable' : 'UNREACHABLE'}</td></tr>
            </tbody>
          </table>
          <dl className="kv">
            <dt>Distance change</dt><dd>{signed(cmp.distanceChange)} km</dd>
            <dt>Cost change</dt><dd>{signed(cmp.costChange)}</dd>
            <dt>Route changed</dt><dd>{cmp.routeChanged ? 'Yes' : 'No'}</dd>
            <dt>Closed on old route</dt><dd>{cmp.closedRoads.length ? cmp.closedRoads.join(', ') : 'none'}</dd>
            <dt>Higher risk on old route</dt><dd>{cmp.riskRoads.length ? cmp.riskRoads.join(', ') : 'none'}</dd>
          </dl>
          {!cmp.routeChanged && cmp.status === 'REACHABLE' && <p className="muted">The route is unchanged on the current network.</p>}
        </>
      )}
    </section>
  );
}
