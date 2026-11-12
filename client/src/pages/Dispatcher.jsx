import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { fmtDuration, fmtKm, fmtInt } from '../format.js';
import SafetyBanner from '../components/SafetyBanner.jsx';
import RescueMap from '../components/RescueMap.jsx';

const KIND_NAME = { fire_station: 'Fire stations', police: 'Police stations', hospital: 'Hospitals' };

// Consecutive roads with the same name become one "stretch" in the turn list.
function stretches(roads) {
  const out = [];
  for (const r of roads) {
    const name = r.name || `Unnamed ${r.highway} road`;
    const last = out.at(-1);
    if (last && last.name === name) { last.lengthM += r.lengthM; last.roadIds.push(r.id); }
    else out.push({ name, highway: r.highway, lengthM: r.lengthM, roadIds: [r.id] });
  }
  return out;
}

export default function Dispatcher() {
  const [summary, setSummary] = useState(null);
  const [fac, setFac] = useState({ facilities: [], units: [], meta: null });
  const [loadError, setLoadError] = useState(null);
  const [originId, setOriginId] = useState('');
  const [customOrigin, setCustomOrigin] = useState(null);
  // Optional deep link for demos: /?incident=18.5074,73.8077
  const [destination, setDestination] = useState(() => {
    const m = new URLSearchParams(window.location.search).get('incident')?.match(/^(-?[\d.]+),(-?[\d.]+)$/);
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
  });
  const [clickMode, setClickMode] = useState('destination');
  const [result, setResult] = useState(null);
  const [routeError, setRouteError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [closedRoads, setClosedRoads] = useState([]);
  const [layers, setLayers] = useState({ fire_station: true, police: true, hospital: true });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    Promise.all([api.summary(), api.facilities(), api.closedRoads()])
      .then(([s, f, c]) => {
        setSummary(s); setFac(f); setClosedRoads(c);
        const main = f.facilities.find((x) => x.kind === 'fire_station' && /main/i.test(x.name))
          ?? f.facilities.find((x) => x.kind === 'fire_station');
        if (main) setOriginId(main.id);
      })
      .catch((e) => setLoadError(e.message));
  }, []);

  const stations = useMemo(() => {
    const withUnits = new Set(fac.units.map((u) => u.stationId));
    return fac.facilities.filter((f) => withUnits.has(f.id))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }, [fac]);

  const origin = useMemo(() => {
    if (customOrigin) return { ...customOrigin, label: 'Custom point' };
    const f = fac.facilities.find((x) => x.id === originId);
    return f ? { lat: f.lat, lng: f.lng, label: f.name } : null;
  }, [customOrigin, originId, fac]);

  // Recompute whenever an endpoint or the road network changes, so a stale route is never shown.
  useEffect(() => {
    if (!origin || !destination) { setResult(null); return; }
    let cancelled = false;
    setBusy(true); setRouteError(null);
    api.route(origin, destination)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => { if (!cancelled) { setResult(null); setRouteError(e.message); } })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [origin, destination, version]);

  const refreshRoads = useCallback(async () => {
    setClosedRoads(await api.closedRoads());
    setSummary(await api.summary());
    setVersion((v) => v + 1);
  }, []);

  const setStatus = async (roadIds, status) => {
    try {
      for (const id of roadIds) await api.setRoadStatus(id, status);
    } catch (e) { setRouteError(e.message); }
    await refreshRoads();
  };
  const resetRoads = async () => { await api.resetRoads(); await refreshRoads(); };

  const onMapClick = (p) => {
    if (clickMode === 'origin') { setCustomOrigin(p); setClickMode('destination'); }
    else setDestination(p);
  };
  const pickStation = (id) => { setCustomOrigin(null); setOriginId(id); };

  const a = result?.results.astar, d = result?.results.dijkstra;
  const turnList = a?.reachable ? stretches(a.roads) : [];

  if (loadError) {
    return (
      <div className="page">
        <SafetyBanner />
        <div className="fatal">Could not reach the API server ({loadError}). Start it with <code>npm run dev</code>.</div>
      </div>
    );
  }

  return (
    <div className="page">
      <SafetyBanner />
      <header className="topbar">
        <div>
          <h1>Pune Rescue Dispatch</h1>
          <p className="sub">Central Pune road network · routing by our own A* and Dijkstra</p>
        </div>
        <div className="chips">
          {summary && <>
            <span className="chip">{fmtInt(summary.nodes)} junctions</span>
            <span className="chip">{fmtInt(summary.roads)} roads · {summary.roadKm} km</span>
            <span className="chip">{fmtInt(summary.oneWayRoads)} one-way</span>
            <span className={`chip ${summary.traffic.live ? 'ok' : 'warn'}`} title={summary.traffic.message}>
              {summary.traffic.live ? 'Live traffic' : 'Live traffic unavailable · free-flow'}
            </span>
          </>}
        </div>
      </header>

      <main className="workspace">
        {summary ? (
          <RescueMap
            bbox={summary.bbox} facilities={fac.facilities} units={fac.units} layers={layers}
            origin={origin} destination={destination} route={a} closedRoads={closedRoads}
            onMapClick={onMapClick} onPickOrigin={pickStation}
            onReopenRoad={(id) => setStatus([id], 'OPEN')}
          />
        ) : <div className="map-shell loading">Loading road network…</div>}

        <aside className="side">
          <section className="panel">
            <h2>Route planner</h2>
            <label>Dispatch from (station with simulated units)
              <select value={customOrigin ? '' : originId} onChange={(e) => pickStation(e.target.value)}>
                {customOrigin && <option value="">Custom point on map</option>}
                {['fire_station', 'police', 'hospital'].map((k) => (
                  <optgroup key={k} label={KIND_NAME[k]}>
                    {stations.filter((s) => s.kind === k).map((s) => <option key={s.id} value={s.id}>{s.id} – {s.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <div className="btn-row">
              <button type="button" className={clickMode === 'origin' ? 'on' : ''} onClick={() => setClickMode(clickMode === 'origin' ? 'destination' : 'origin')}>
                {clickMode === 'origin' ? 'Click the map to set the start…' : 'Pick start on map'}
              </button>
              {destination && <button type="button" onClick={() => setDestination(null)}>Clear incident</button>}
            </div>
            {!destination && <p className="hint">Click anywhere on the map to place an incident. The nearest road junction is found with our k-d tree.</p>}
            {busy && <p className="muted">Routing…</p>}
            {routeError && <p className="alert" role="alert">{routeError}</p>}

            {a && !a.reachable && (
              <p className="alert" role="alert">UNREACHABLE: no open road connects these points. Reopen a road to restore a route.</p>
            )}
            {a?.reachable && (
              <>
                <div className="eta">
                  <span className="eta-label">ETA (free-flow)</span>
                  <span className="eta-value">{fmtDuration(a.totalCostS)}</span>
                  <span className="eta-sub">{fmtKm(a.totalLengthM)} · {a.roadCount} road segments</span>
                </div>
                <dl className="kv">
                  <dt>Driving time</dt><dd>{fmtDuration(a.totalTimeS)}</dd>
                  <dt>Risk penalty</dt><dd>{fmtDuration(a.totalRiskPenaltyS)}</dd>
                  <dt>Start snapped</dt><dd>{result.from.distanceM} m to junction {result.from.nodeId}</dd>
                  <dt>Incident snapped</dt><dd>{result.to.distanceM} m to junction {result.to.nodeId}</dd>
                </dl>
              </>
            )}
          </section>

          {a?.reachable && d && (
            <section className="panel">
              <h2>A* vs Dijkstra</h2>
              <table className="cmp">
                <thead><tr><th></th><th>A*</th><th>Dijkstra</th></tr></thead>
                <tbody>
                  <tr><th>Cost</th><td>{a.totalCostS.toFixed(1)} s</td><td>{d.totalCostS.toFixed(1)} s</td></tr>
                  <tr><th>Nodes settled</th><td><b>{fmtInt(a.settled)}</b></td><td>{fmtInt(d.settled)}</td></tr>
                  <tr><th>Heap pops</th><td>{fmtInt(a.heapExtractions)}</td><td>{fmtInt(d.heapExtractions)}</td></tr>
                  <tr><th>Run time</th><td>{a.ms} ms</td><td>{d.ms} ms</td></tr>
                </tbody>
              </table>
              <p className={Math.abs(a.totalCostS - d.totalCostS) < 1e-6 ? 'okmsg' : 'alert'}>
                {Math.abs(a.totalCostS - d.totalCostS) < 1e-6 ? 'Same optimal cost.' : 'Costs differ: check the heuristic.'}
                {' '}A* settled {Math.round((100 * a.settled) / Math.max(1, d.settled))}% of the junctions Dijkstra did.
              </p>
              <p className="note">Heuristic: straight-line distance ÷ {summary?.heuristicMaxSpeedKmh} km/h (fastest road in the data), so it never overestimates.</p>
            </section>
          )}

          {turnList.length > 0 && (
            <section className="panel">
              <h2>Roads on this route</h2>
              <p className="note">Block a stretch to simulate a closure. The route is recomputed from the updated graph.</p>
              <ol className="turns">
                {turnList.map((s, i) => (
                  <li key={`${s.name}-${i}`}>
                    <span className="turn-name">{s.name}</span>
                    <span className="turn-len">{Math.round(s.lengthM)} m</span>
                    <button type="button" className="danger sm" onClick={() => setStatus(s.roadIds, 'BLOCKED')}>Block</button>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="panel">
            <h2>Closures {closedRoads.length > 0 && <span className="pill BLOCKED">{closedRoads.length}</span>}</h2>
            {closedRoads.length === 0 ? <p className="muted">No closed roads.</p> : (
              <>
                <ul className="closed">
                  {closedRoads.map((r) => (
                    <li key={r.id}>
                      <span>{r.name || 'Unnamed road'} <span className="muted">({r.id})</span></span>
                      <button type="button" className="sm" onClick={() => setStatus([r.id], 'OPEN')}>Reopen</button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="ghost" onClick={resetRoads}>Reopen all roads</button>
              </>
            )}
          </section>

          <section className="panel">
            <h2>Map layers</h2>
            <div className="layers">
              {Object.keys(layers).map((k) => (
                <label key={k} className="check">
                  <input type="checkbox" checked={layers[k]} onChange={() => setLayers({ ...layers, [k]: !layers[k] })} />
                  <i className={`dot ${k}`} /> {KIND_NAME[k]} ({fac.facilities.filter((f) => f.kind === k).length})
                </label>
              ))}
            </div>
            <p className="note">
              Facility names and locations are real (OpenStreetMap). <b>Hospital beds and all vehicles are simulated.</b>{' '}
              {fac.meta?.fleetRule}
            </p>
            {summary && <p className="note">Road data: {summary.source}. Snapshot {summary.generatedAt?.slice(0, 10)}.</p>}
          </section>
        </aside>
      </main>
    </div>
  );
}
