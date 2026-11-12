import React, { useMemo } from 'react';
import { createSimulation } from '../services/scenarioService.js';
import { computeMetrics, routeMetrics } from '../services/statisticsService.js';
import { compareToBaseline } from '../services/comparisonService.js';
import { fmt } from '../format.js';

export default function StatisticsPanel({ sim, route }) {
  const original = useMemo(() => computeMetrics(createSimulation()), []);   // untouched city: the comparison reference
  const now = computeMetrics(sim);

  // Route rows: use the saved baseline's source/destination when there is one, so both columns describe the same trip.
  let routeLabel = null, before = null, after = null;
  if (sim.baseline) {
    const cmp = compareToBaseline(sim.graph, sim.baseline);
    routeLabel = `${sim.baseline.source} → ${sim.baseline.destination}`;
    before = routeMetrics(cmp.before); after = routeMetrics(cmp.after);
  } else if (route) {
    routeLabel = `${route.source} → ${route.destination}`;
    after = routeMetrics(route);
  }
  const val = (n) => (n === null || n === undefined ? '—' : fmt(n));
  const sev = (m) => ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((k) => `${k[0] + k.slice(1).toLowerCase()} ${m.requestsBySeverity[k]}`).join(' · ');

  const rows = [
    ['Affected locations', original.affectedLocations, now.affectedLocations],
    ['Blocked roads', original.blockedRoads, now.blockedRoads],
    ['High-risk roads', original.highRiskRoads, now.highRiskRoads],
    ['Reachable affected locations', original.reachableAffected, now.reachableAffected],
    ['Unreachable affected locations', original.unreachableAffected, now.unreachableAffected],
    ['Active requests', original.activeRequests, now.activeRequests],
    ['Completed requests', original.completedRequests, now.completedRequests],
  ];

  return (
    <section className="card" aria-labelledby="st-h">
      <h2 id="st-h">Results / statistics</h2>
      <table className="cmp">
        <thead><tr><th>Metric</th><th>Original network</th><th>Current</th></tr></thead>
        <tbody>
          {rows.map(([label, a, b]) => <tr key={label}><th>{label}</th><td>{a}</td><td className={b !== a ? 'chg' : ''}>{b}</td></tr>)}
          <tr><th>Active requests by level</th><td>{sev(original)}</td><td>{sev(now)}</td></tr>
          <tr><th>Route {routeLabel ?? ''}</th><td colSpan="2" className="muted">{routeLabel ? (sim.baseline ? 'baseline vs now (saved baseline)' : 'current selection') : 'select a destination or save a baseline'}</td></tr>
          {routeLabel && (
            <>
              <tr><th>– Status</th><td>{before?.status ?? '—'}</td><td className={after?.status === 'UNREACHABLE' ? 'bad' : ''}>{after?.status ?? '—'}</td></tr>
              <tr><th>– Distance (km)</th><td>{val(before?.distanceKm)}</td><td>{val(after?.distanceKm)}</td></tr>
              <tr><th>– Effective cost</th><td>{val(before?.cost)}</td><td>{val(after?.cost)}</td></tr>
            </>
          )}
        </tbody>
      </table>
      <p className="note">All values are counted from the current simulation state. The simulation does not measure lives saved, real evacuation time or disaster severity.</p>
    </section>
  );
}
