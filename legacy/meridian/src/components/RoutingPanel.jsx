import React from 'react';
import { fmt } from '../format.js';

export default function RoutingPanel({ graph, source, destination, setSource, setDestination, route, altRoute, stations }) {
  const all = [...graph.locations.values()];
  const rescue = all.filter((l) => l.type === 'Rescue Station');
  const name = (id) => graph.getLocation(id).name;

  return (
    <section className="card" aria-labelledby="route-h">
      <h2 id="route-h">Routing (Dijkstra)</h2>
      <label>Rescue station
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          {rescue.map((s) => <option key={s.id} value={s.id}>{s.id} – {s.name}</option>)}
        </select>
      </label>
      <label>Destination
        <select value={destination} onChange={(e) => setDestination(e.target.value)}>
          <option value="">Select destination…</option>
          {all.filter((l) => l.type !== 'Intersection').map((l) => <option key={l.id} value={l.id}>{l.id} – {l.name}</option>)}
          <optgroup label="Intersections">
            {all.filter((l) => l.type === 'Intersection').map((l) => <option key={l.id} value={l.id}>{l.id}</option>)}
          </optgroup>
        </select>
      </label>

      {!route && <p className="muted">Choose a destination to calculate the minimum-cost route.</p>}
      {route && !route.reachable && (
        <p className="alert" role="alert">UNREACHABLE – no route currently exists from {name(route.source)} to {name(route.destination)} over the available roads.</p>
      )}
      {route?.reachable && (
        <>
          <p className="route-path">{route.path.join(' → ')}</p>
          <dl className="kv">
            <dt>Status</dt><dd>Reachable</dd>
            <dt>Distance</dt><dd>{fmt(route.totalDistanceKm)} km</dd>
            <dt>Risk penalty</dt><dd>{fmt(route.totalRiskPenalty)}</dd>
            <dt>Effective cost</dt><dd><b>{fmt(route.totalCost)}</b></dd>
            <dt>Roads used</dt><dd>{route.roadCount}</dd>
          </dl>
          {altRoute ? (
            <p className="alt">Alternative (green dashed): <b>{altRoute.path.join(' → ')}</b> – {fmt(altRoute.totalDistanceKm)} km, cost {fmt(altRoute.totalCost)} (avoids {altRoute.avoidsRoad}).</p>
          ) : route.roadCount > 0 && <p className="muted">No alternative route exists: every other path is blocked.</p>}
        </>
      )}

      {stations && (
        <>
          <h3>Station comparison for {destination}</h3>
          <ul className="reqs">
            {stations.results.map(({ stationId, route: r }) => (
              <li key={stationId}>
                <b>{stationId}</b>: {r.reachable ? `cost ${fmt(r.totalCost)}` : 'unreachable'}
                {stationId === stations.recommended && <span className="pill REC">recommended</span>}
              </li>
            ))}
          </ul>
          {!stations.recommended && <p className="alert" role="alert">No station can currently reach {name(destination)}, so none is recommended.</p>}
        </>
      )}
      <p className="note">Minimum cost under the simulation's cost model (distance + risk penalty), not a guaranteed safest real-world route.</p>
    </section>
  );
}
