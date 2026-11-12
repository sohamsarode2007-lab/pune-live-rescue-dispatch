import React from 'react';
import { SCENARIOS } from '../data/disasterScenarios.js';
import { getAffectedReachability } from '../services/scenarioService.js';

export default function ScenarioControls({ sim, onActivate, onReset }) {
  const active = sim.activeScenario ? SCENARIOS[sim.activeScenario] : null;
  const { reachable, unreachable } = getAffectedReachability(sim.graph);
  const nameOf = (id) => `${id} (${sim.graph.getLocation(id).name})`;

  return (
    <section className="card" aria-labelledby="sc-h">
      <h2 id="sc-h">Disaster scenarios</h2>
      <div className="btn-row">
        <button onClick={() => onActivate('FLOOD')} disabled={sim.activeScenario === 'FLOOD'}>Activate Flood</button>
        <button onClick={() => onActivate('FIRE')} disabled={sim.activeScenario === 'FIRE'}>Activate Fire</button>
        <button className="danger" onClick={onReset}>Reset Scenario</button>
      </div>
      {!active && <p className="muted">No scenario active. Save a baseline route first if you want a before/after comparison.</p>}
      {active && (
        <>
          <h3>{active.name}</h3>
          <p className="muted">{active.description}</p>
          <dl className="kv">
            <dt>Roads changed</dt><dd>{sim.lastChanges.length}</dd>
            <dt>Affected</dt><dd>{reachable.length + unreachable.length} locations</dd>
            <dt>Reachable</dt><dd>{reachable.length ? reachable.map(nameOf).join(', ') : 'none'}</dd>
            <dt>Unreachable</dt><dd className={unreachable.length ? 'bad' : ''}>{unreachable.length ? unreachable.map(nameOf).join(', ') : 'none'}</dd>
          </dl>
          <h3>Generated requests</h3>
          <ul className="reqs">
            {sim.requests.list().map((r) => (
              <li key={r.id}><b>{r.id}</b> {r.locationId} · {r.severity} · {r.peopleAffected} people</li>
            ))}
          </ul>
        </>
      )}
      <p className="note">Scenarios use fixed, predefined data. They do not predict real flood or fire behaviour. Switching or resetting a scenario also restores any manual road edits.</p>
    </section>
  );
}
