import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { fmtDuration, fmtKm, fmtInt, fmtClock, fmtTime } from '../format.js';
import { getSocket, emitAck, clientId } from '../socket.js';
import { useLiveDispatch } from '../useLiveDispatch.js';
import SafetyBanner from '../components/SafetyBanner.jsx';
import NavLinks from '../components/NavLinks.jsx';
import RescueMap from '../components/RescueMap.jsx';
import ComparisonPanel from '../components/ComparisonPanel.jsx';
import TrafficPanel from '../components/TrafficPanel.jsx';
import OsrmPanel from '../components/OsrmPanel.jsx';
import { TrapZoneWarning, SpofPanel, CrossingsPanel } from '../components/NetworkPanels.jsx';
import { UNIT_LABEL, TYPE_ICON } from '../components/mapParts.jsx';

const KIND_NAME = { fire_station: 'Fire stations', police: 'Police stations', hospital: 'Hospitals' };
const SPEEDS = [1, 5, 10, 30];
const UNIT_STATUSES = ['AVAILABLE', 'EN_ROUTE', 'ON_SCENE', 'TO_HOSPITAL', 'RETURNING'];

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
  const live = useLiveDispatch();
  const [tab, setTab] = useState('live');
  const [summary, setSummary] = useState(null);
  const [fac, setFac] = useState({ facilities: [], units: [], meta: null });
  const [loadError, setLoadError] = useState(null);
  const [layers, setLayers] = useState({ fire_station: true, police: true, hospital: true });
  const [showIdle, setShowIdle] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [selectedIncidentId, setSelectedIncidentId] = useState(null);
  // test SOS (dispatcher places an incident by clicking the map)
  const [testMode, setTestMode] = useState(false);
  const [testForm, setTestForm] = useState({ type: 'medical', severity: 'MEDIUM', people: 1 });
  const [testMsg, setTestMsg] = useState(null);
  // route planner (Phase 1 tool)
  const [originId, setOriginId] = useState('');
  const [customOrigin, setCustomOrigin] = useState(null);
  const [destination, setDestination] = useState(() => {
    const m = new URLSearchParams(window.location.search).get('incident')?.match(/^(-?[\d.]+),(-?[\d.]+)$/);
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
  });
  const [clickMode, setClickMode] = useState('destination');
  const [result, setResult] = useState(null);
  const [routeError, setRouteError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  // Phase 4: traffic colours and the OSRM comparison overlay
  const [showTraffic, setShowTraffic] = useState(false);
  const [trafficRoads, setTrafficRoads] = useState([]);
  const [compareResult, setCompareResult] = useState(null);
  const trafficKey = `${live.traffic?.mode}|${live.traffic?.snapshotAt}`;
  useEffect(() => { setCompareResult(null); }, [tab, selectedIncidentId]);

  // Network tab (Tarjan, trap zones, river crossings). Data refetched when the server's analysis changes.
  const [spof, setSpof] = useState(null);
  const [showAllSpof, setShowAllSpof] = useState(false);
  const [crossingState, setCrossingState] = useState(null);
  const [selectedCrossingId, setSelectedCrossingId] = useState(null);
  const [rivers, setRivers] = useState([]);
  const [zones, setZones] = useState([]);
  const netVersion = live.network?.version;
  const crossingStatus = `${live.network?.crossings?.status}|${live.network?.crossings?.stale}`;
  const zoneCount = live.network?.trapZones?.length ?? 0;
  useEffect(() => { api.rivers().then(setRivers).catch(() => {}); }, []);
  useEffect(() => { if (tab === 'network') api.spof().then(setSpof).catch(() => {}); }, [tab, netVersion]);
  useEffect(() => { if (tab === 'network') api.crossings().then(setCrossingState).catch(() => {}); }, [tab, crossingStatus, netVersion]);
  useEffect(() => {
    if (!zoneCount) { setZones([]); return; }
    api.scc().then((s) => setZones(s.zones)).catch(() => {});
  }, [zoneCount, netVersion]);
  const setCrossing = async (id, status) => {
    try { await api.setCrossingStatus(id, status); setVersion((v) => v + 1); } catch (e) { setRouteError(e.message); }
  };
  useEffect(() => {
    if (!showTraffic || !live.traffic?.snapshotAt) { setTrafficRoads([]); return undefined; }
    let cancelled = false;
    api.traffic().then((t) => { if (!cancelled) setTrafficRoads(t.roads); }).catch(() => {});
    return () => { cancelled = true; };
  }, [showTraffic, trafficKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (destination) setTab('planner');
    Promise.all([api.summary(), api.facilities()])
      .then(([s, f]) => {
        setSummary(s); setFac(f);
        const main = f.facilities.find((x) => x.kind === 'fire_station' && /main/i.test(x.name)) ?? f.facilities.find((x) => x.kind === 'fire_station');
        if (main) setOriginId(main.id);
      })
      .catch((e) => setLoadError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stations = useMemo(() => {
    const withUnits = new Set(fac.units.map((u) => u.stationId));
    return fac.facilities.filter((f) => withUnits.has(f.id)).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }, [fac]);
  const facById = useMemo(() => new Map(fac.facilities.map((f) => [f.id, f])), [fac]);

  const origin = useMemo(() => {
    if (customOrigin) return { ...customOrigin, label: 'Custom point' };
    const f = facById.get(originId);
    return f ? { lat: f.lat, lng: f.lng, label: f.name } : null;
  }, [customOrigin, originId, facById]);

  // Route planner: recompute whenever an endpoint or the road network changes.
  useEffect(() => {
    if (tab !== 'planner' || !origin || !destination) { setResult(null); return undefined; }
    let cancelled = false;
    setBusy(true); setRouteError(null);
    api.route(origin, destination)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => { if (!cancelled) { setResult(null); setRouteError(e.message); } })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [tab, origin, destination, version, live.closedRoads, trafficKey]);

  const setStatus = useCallback(async (roadIds, status) => {
    try { for (const id of roadIds) await api.setRoadStatus(id, status); } catch (e) { setRouteError(e.message); }
    setSummary(await api.summary());
    setVersion((v) => v + 1);
  }, []);
  const resetRoads = async () => { await api.resetRoads(); setVersion((v) => v + 1); };

  const sendTestSos = async (p) => {
    setTestMsg(null);
    try {
      const res = await emitAck('sos:new', { ...p, ...testForm, source: 'dispatcher', clientId: clientId() });
      if (!res.ok) setTestMsg({ bad: true, text: res.error === 'OUTSIDE_AREA' ? 'Outside the demo area.' : res.error === 'TOO_FAST' ? 'Wait a few seconds between test SOS.' : res.message ?? res.error });
      else if (res.merged) { setSelectedIncidentId(res.incident.id); setTestMsg({ text: `Merged into ${res.incident.id} (${res.merged.distanceM} m away, ${res.incident.calls} calls). Geohash checked ${res.merged.checked} nearby incident(s).` }); }
      else { setSelectedIncidentId(res.incident.id); setTestMsg({ text: `${res.incident.id} created${res.incident.unitId ? `, ${res.incident.unitId} dispatched` : ' — waiting in queue'}.` }); }
    } catch { setTestMsg({ bad: true, text: 'Server did not answer.' }); }
  };

  const [burstMsg, setBurstMsg] = useState(null);
  const sendBurst = async () => {
    setBurstMsg(null);
    try {
      const r = await emitAck('burst:create', {});
      if (!r.ok) { setBurstMsg({ bad: true, text: r.error }); return; }
      const c = r.comparison;
      const parts = [`${r.created.length} new incident${r.created.length === 1 ? '' : 's'}`];
      if (r.merged.length) parts.push(`${r.merged.length} call${r.merged.length === 1 ? '' : 's'} merged into open incidents (same place within 5 min)`);
      if (c) parts.push(`greedy ${fmtDuration(c.greedy.totalS)} vs Hungarian ${fmtDuration(c.hungarian.totalS)} total ETA`);
      else parts.push('no free unit could be planned');
      setBurstMsg({ text: `${parts.join(' · ')}.` });
    } catch { setBurstMsg({ bad: true, text: 'Server did not answer.' }); }
  };

  const onMapClick = (p) => {
    if (tab === 'live') { if (testMode) sendTestSos(p); return; }
    if (tab === 'network') return;
    if (clickMode === 'origin') { setCustomOrigin(p); setClickMode('destination'); } else setDestination(p);
  };
  const pickStation = (id) => { setCustomOrigin(null); setOriginId(id); setTab('planner'); };

  const incidents = [...live.incidents.values()];
  const units = [...live.units.values()];
  const active = incidents.filter((i) => i.status !== 'RESOLVED').sort((a, b) => a.createdS - b.createdS);
  const resolved = incidents.filter((i) => i.status === 'RESOLVED');
  const avgResponse = resolved.length ? resolved.reduce((s, i) => s + (i.responseS ?? 0), 0) / resolved.length : null;
  const unitCounts = Object.fromEntries(['ambulance', 'fire_truck', 'rescue_boat'].map((t) => [t,
    Object.fromEntries(UNIT_STATUSES.map((s) => [s, units.filter((u) => u.type === t && u.status === s).length]))]));
  const a = result?.results.astar, d = result?.results.dijkstra;
  const turnList = a?.reachable ? stretches(a.roads) : [];

  if (loadError) {
    return (<div className="page"><SafetyBanner /><div className="fatal">Could not reach the API server ({loadError}). Start it with <code>npm run dev</code>.</div></div>);
  }

  return (
    <div className="page">
      <SafetyBanner />
      <header className="topbar">
        <div>
          <h1>Pune Rescue Dispatch</h1>
          <NavLinks />
        </div>
        <div className="chips">
          <span className={`chip ${live.connected ? 'ok' : 'warn'}`}>{live.connected ? 'Live' : 'Reconnecting…'}</span>
          <span className="chip">Sim {fmtClock(live.simTimeS)} · {live.speed}×</span>
          {summary && <span className="chip">{fmtInt(summary.nodes)} junctions · {fmtInt(summary.roads)} roads</span>}
          {live.traffic && (
            <span className={`chip ${live.traffic.mode === 'live' ? 'ok' : 'warn'}`} title={live.traffic.message}>
              {live.traffic.mode === 'live' && live.traffic.snapshotAt
                ? `Traffic as of ${fmtTime(live.traffic.snapshotAt)}`
                : live.traffic.hasKey ? 'Free-flow traffic' : 'Free-flow · live traffic unavailable'}
            </span>
          )}
          {live.externalCalls && (
            <span className="chip" title="External API calls today (UTC); TomTom is capped at 200/day">
              TomTom {live.externalCalls.tomtom?.calls ?? 0}/{live.externalCalls.tomtom?.cap ?? 200} · OSRM {live.externalCalls.osrm?.calls ?? 0}{live.externalCalls.osrm?.cacheHits ? ` (+${live.externalCalls.osrm.cacheHits} cached)` : ''}
            </span>
          )}
        </div>
      </header>

      <main className="workspace">
        {summary ? (
          <RescueMap
            bbox={summary.bbox} facilities={fac.facilities} fleet={fac.units} layers={layers}
            origin={tab === 'planner' ? origin : null} destination={tab === 'planner' ? destination : null}
            route={tab === 'planner' ? a : null} closedRoads={live.closedRoads}
            onMapClick={onMapClick} onPickOrigin={pickStation} onReopenRoad={(id) => setStatus([id], 'OPEN')}
            incidents={incidents.filter((i) => showResolved || i.status !== 'RESOLVED')} liveUnits={units} showIdle={showIdle}
            selectedIncidentId={selectedIncidentId} onSelectIncident={setSelectedIncidentId} beds={live.beds}
            cursor={tab === 'live' && testMode ? 'crosshair' : ''}
            trafficRoads={trafficRoads} compare={compareResult}
            network={tab === 'network'
              ? { rivers, spof, showAll: showAllSpof, crossings: crossingState?.ranking ?? [], selectedCrossingId, onSelectCrossing: setSelectedCrossingId, onSetCrossingStatus: setCrossing, zones }
              : { zones }}
          />
        ) : <div className="map-shell loading">Loading road network…</div>}

        <aside className="side">
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'live'} className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>
              Live dispatch {active.length > 0 && <span className="pill BLOCKED">{active.length}</span>}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'planner'} className={tab === 'planner' ? 'on' : ''} onClick={() => setTab('planner')}>Route planner</button>
            <button type="button" role="tab" aria-selected={tab === 'network'} className={tab === 'network' ? 'on' : ''} onClick={() => setTab('network')}>
              Network {zoneCount > 0 && <span className="pill BLOCKED">{zoneCount}</span>}
            </button>
          </div>

          <TrapZoneWarning summary={live.network} />

          {tab === 'network' && (
            <>
              <CrossingsPanel state={crossingState} selectedId={selectedCrossingId} onSelect={setSelectedCrossingId} onSetStatus={setCrossing} />
              <SpofPanel spof={spof} showAll={showAllSpof} onShowAll={setShowAllSpof} />
            </>
          )}

          <TrafficPanel status={live.traffic} calls={live.externalCalls} showColours={showTraffic} onShowColours={setShowTraffic} />

          {tab === 'live' && (
            <>
              <section className="panel">
                <h2>Simulation</h2>
                <div className="btn-row">
                  {SPEEDS.map((s) => (
                    <button key={s} type="button" className={live.speed === s ? 'on' : ''} onClick={() => getSocket().emit('sim:speed', { speed: s })}>{s}×</button>
                  ))}
                  <button type="button" className="danger" onClick={() => { if (window.confirm('Clear all incidents and send every unit home?')) getSocket().emit('sim:reset'); }}>Reset</button>
                </div>
                <p className="note">Sim time {fmtClock(live.simTimeS)}. At 1× units move in real time. Phones open <a href="/sos">/sos</a> to send an SOS.</p>
              </section>

              <section className="panel">
                <h2>Dispatch</h2>
                <div className="tabs small">
                  {[['hungarian', 'Hungarian (optimal)'], ['greedy', 'Greedy (nearest unit)']].map(([m, label]) => (
                    <button key={m} type="button" className={live.mode === m ? 'on' : ''} onClick={() => getSocket().emit('dispatch:mode', { mode: m })}>{label}</button>
                  ))}
                </div>
                <button type="button" className="ghost burst" onClick={sendBurst}>Burst: 8 simultaneous incidents</button>
                {burstMsg && <p className={burstMsg.bad ? 'alert' : 'okmsg'}>{burstMsg.text}</p>}
                <p className="note">Both plans are computed for every batch; the mode only decides which one the units follow. The burst uses a fixed seeded pattern, so it is the same every time.</p>
              </section>

              <ComparisonPanel comparisons={live.comparisons} totals={live.comparisonTotals} mode={live.mode} />

              <section className="panel">
                <h2>Test SOS</h2>
                <div className="form-row">
                  <select aria-label="Type" value={testForm.type} onChange={(e) => setTestForm({ ...testForm, type: e.target.value })}>
                    <option value="medical">Medical</option><option value="fire">Fire</option><option value="flood">Flood</option>
                  </select>
                  <select aria-label="Severity" value={testForm.severity} onChange={(e) => setTestForm({ ...testForm, severity: e.target.value })}>
                    <option value="LOW">Minor</option><option value="MEDIUM">Serious</option><option value="HIGH">Life-threatening</option>
                  </select>
                  <input aria-label="People" type="number" min="1" max="50" value={testForm.people}
                    onChange={(e) => setTestForm({ ...testForm, people: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} />
                </div>
                <button type="button" className={`ghost ${testMode ? 'on' : ''}`} onClick={() => setTestMode(!testMode)}>
                  {testMode ? 'Click the map to place SOS… (click here to stop)' : 'Place test SOS on map'}
                </button>
                {testMsg && <p className={testMsg.bad ? 'alert' : 'okmsg'}>{testMsg.text}</p>}
              </section>

              <section className="panel">
                <h2>Waiting queue {live.queue.length > 0 && <span className="pill BLOCKED">{live.queue.length}</span>}</h2>
                {live.queue.length === 0 ? <p className="muted">No incident is waiting for a unit.</p> : (
                  <ol className="queue">
                    {live.queue.map((q) => {
                      const inc = live.incidents.get(q.id);
                      return inc && (
                        <li key={q.id}>
                          <button type="button" className="link" onClick={() => setSelectedIncidentId(q.id)}>{q.id}</button>{' '}
                          {TYPE_ICON[inc.type]} {inc.severity} · {inc.people} ppl · score {q.score} · waiting {fmtDuration(live.simTimeS - inc.createdS)}
                        </li>
                      );
                    })}
                  </ol>
                )}
                <p className="note">Order: emergency priority queue (max-heap), score = 5·severity + 2·min(people,10) + min(minutes waited,10). Aging: the waiting term grows with the sim clock and the queue is re-scored every tick.</p>
              </section>

              <section className="panel">
                <h2>Active incidents</h2>
                {active.length === 0 ? <p className="muted">None. Send one from a phone (/sos) or with Test SOS.</p> : (
                  <ul className="incidents">
                    {active.map((i) => {
                      const u = i.unitId ? live.units.get(i.unitId) : null;
                      const left = u?.phaseEndS != null ? Math.max(0, u.phaseEndS - live.simTimeS) : null;
                      return (
                        <li key={i.id} className={i.id === selectedIncidentId ? 'sel' : ''} onClick={() => setSelectedIncidentId(i.id)}>
                          <div>
                            <b>{i.id}</b> {TYPE_ICON[i.type]} {i.type} · {i.severity} · {i.people} ppl
                            {i.calls > 1 && <span className="pill merged" title="SOS calls merged by geohash clustering">{i.calls} calls</span>}
                            {i.source !== 'phone' && <span className="muted"> ({i.source === 'burst' ? 'burst' : 'test'})</span>}
                          </div>
                          <div className="muted">
                            <span className={`st ${i.status}`}>{i.status}</span>
                            {u && <> · {u.id} ({UNIT_LABEL[u.type]})</>}
                            {u && left != null && (i.status === 'EN_ROUTE' ? ` · ETA ${fmtDuration(left)}` : i.status === 'ON_SCENE' ? ` · on scene ${fmtDuration(left)} more` : i.status === 'TRANSPORTING' ? ` · to ${facById.get(i.hospitalId)?.name ?? i.hospitalId} in ${fmtDuration(left)}` : '')}
                          </div>
                          {i.plannedHospitalId && (i.status === 'EN_ROUTE' || i.status === 'ON_SCENE') && (
                            <div className="muted">Leg 2 (planned): {facById.get(i.plannedHospitalId)?.name ?? i.plannedHospitalId}{facById.get(i.plannedHospitalId)?.major ? ' (major)' : ''} · {fmtDuration(i.plannedHospitalLegS)}</div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="note">
                  Resolved: {resolved.length}{avgResponse != null && <> · average response {fmtDuration(avgResponse)}</>}
                  {' · '}<label className="check inline"><input type="checkbox" checked={showResolved} onChange={() => setShowResolved(!showResolved)} /> show on map</label>
                </p>
              </section>

              {(() => {
                const sel = selectedIncidentId ? live.incidents.get(selectedIncidentId) : null;
                return sel?.fromLat != null ? (
                  <OsrmPanel from={{ lat: sel.fromLat, lng: sel.fromLng }} to={{ lat: sel.lat, lng: sel.lng }}
                    label={`Dispatch ${sel.unitId} → ${sel.id}: same start junction and incident for both engines.`} onResult={setCompareResult} />
                ) : <p className="note panel-note">Select an assigned incident to compare its route with OSRM.</p>;
              })()}

              <section className="panel">
                <h2>Units (simulated)</h2>
                <table className="cmp">
                  <thead><tr><th></th><th title="available">Free</th><th>En route</th><th>On scene</th><th>To hosp.</th><th>Return</th></tr></thead>
                  <tbody>
                    {Object.entries(unitCounts).map(([t, c]) => (
                      <tr key={t}><th>{UNIT_LABEL[t]}</th>{UNIT_STATUSES.map((s) => <td key={s}>{c[s]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
                <label className="check"><input type="checkbox" checked={showIdle} onChange={() => setShowIdle(!showIdle)} /> Show idle units on the map</label>
                <p className="note">Nearest capable unit by ETA: one reverse Dijkstra from the incident gives every unit's travel time. Medical → ambulance, fire → fire truck, flood → rescue boat. Life-threatening medical cases go to a major hospital.</p>
              </section>
            </>
          )}

          {tab === 'planner' && (
            <>
              <section className="panel">
                <h2>Route planner</h2>
                <label>Start (station with simulated units)
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
                  {destination && <button type="button" onClick={() => setDestination(null)}>Clear destination</button>}
                </div>
                {!destination && <p className="hint">Click the map to set a destination. The nearest road junction is found with our k-d tree.</p>}
                {busy && <p className="muted">Routing…</p>}
                {routeError && <p className="alert" role="alert">{routeError}</p>}
                {a && !a.reachable && <p className="alert" role="alert">UNREACHABLE: no open road connects these points. Reopen a road to restore a route.</p>}
                {a?.reachable && (
                  <>
                    <div className="eta">
                      <span className="eta-label">ETA ({live.traffic?.mode === 'live' ? `live traffic, ${fmtTime(live.traffic.snapshotAt)}` : 'free-flow'})</span>
                      <span className="eta-value">{fmtDuration(a.totalCostS)}</span>
                      <span className="eta-sub">{fmtKm(a.totalLengthM)} · {a.roadCount} road segments</span>
                    </div>
                    <dl className="kv">
                      <dt>Driving time</dt><dd>{fmtDuration(a.totalTimeS)}</dd>
                      <dt>Risk penalty</dt><dd>{fmtDuration(a.totalRiskPenaltyS)}</dd>
                      <dt>Start snapped</dt><dd>{result.from.distanceM} m to junction {result.from.nodeId}</dd>
                      <dt>End snapped</dt><dd>{result.to.distanceM} m to junction {result.to.nodeId}</dd>
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
                </section>
              )}

              {a?.reachable && <OsrmPanel from={origin} to={destination} label="Route planner start and destination." onResult={setCompareResult} />}

              {turnList.length > 0 && (
                <section className="panel">
                  <h2>Roads on this route</h2>
                  <p className="note">Block a stretch to simulate a closure; the route is recomputed from the updated graph.</p>
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
            </>
          )}

          <section className="panel">
            <h2>Closures {live.closedRoads.length > 0 && <span className="pill BLOCKED">{live.closedRoads.length}</span>}</h2>
            {live.closedRoads.length === 0 ? <p className="muted">No closed roads.</p> : (
              <>
                <ul className="closed">
                  {live.closedRoads.map((r) => (
                    <li key={r.id}><span>{r.name || 'Unnamed road'} <span className="muted">({r.id})</span></span>
                      <button type="button" className="sm" onClick={() => setStatus([r.id], 'OPEN')}>Reopen</button></li>
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
            <p className="note">Facility names and locations are real (OpenStreetMap). <b>Hospital beds and all vehicles are simulated.</b> {fac.meta?.fleetRule}. Large pins = major hospitals ({fac.meta?.counts?.majorHospitals}).</p>
          </section>
        </aside>
      </main>
    </div>
  );
}
