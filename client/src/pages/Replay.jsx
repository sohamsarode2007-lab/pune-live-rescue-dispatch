import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Polyline, CircleMarker, Popup } from 'react-leaflet';
import SafetyBanner from '../components/SafetyBanner.jsx';
import NavLinks from '../components/NavLinks.jsx';
import { AreaBox, BaseTiles, MapFrame, divIcon, TYPE_ICON, UNIT_LETTER } from '../components/mapParts.jsx';
import { fmtClock } from '../format.js';
import { trimRoute } from '../useLiveDispatch.js';

const SPEEDS = [1, 5, 10, 30];
const getJson = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); };

// Replay state, rebuilt by applying logged events in order (mutable for speed; React re-renders on a tick).
function emptyState() {
  return { incidents: new Map(), units: new Map(), closures: new Map(), floodPoints: [], flood: null, coverage: null, scenario: null, trapZones: 0, feed: [] };
}

function apply(s, ev) {
  const d = ev.data;
  const feed = (text, kind = '') => { s.feed.push({ t: ev.t, text, kind }); if (s.feed.length > 200) s.feed.shift(); };
  switch (ev.type) {
    case 'state:init':
      s.incidents = new Map(d.incidents.map((i) => [i.id, i]));
      s.units = new Map(d.units.map((u) => [u.id, u]));
      break;
    case 'incident:updated': {
      const prev = s.incidents.get(d.id);
      if (!prev) feed(`${d.id} ${TYPE_ICON[d.type] ?? ''} ${d.type} SOS (${d.severity}, ${d.people} ppl)`, 'sos');
      if (prev?.status !== d.status) {
        if (d.status === 'EN_ROUTE' && d.unitId) feed(`${d.unitId} dispatched to ${d.id}`);
        if (d.status === 'ON_SCENE') feed(`${d.unitId} on scene at ${d.id} (response ${Math.round(d.responseS)} s)`, 'ok');
        if (d.status === 'RESOLVED') feed(`${d.id} resolved`, 'ok');
      }
      s.incidents.set(d.id, d);
      break;
    }
    case 'unit:updated': s.units.set(d.id, { ...s.units.get(d.id), ...d }); break;
    case 'unit:position': for (const p of d.units) { const u = s.units.get(p.id); if (u) s.units.set(p.id, { ...u, lat: p.lat, lng: p.lng, status: p.status, route: trimRoute(u.route, p) }); } break;
    case 'unit:rerouted': feed(`↻ ${d.unitId} ${d.outcome === 'rerouted' ? `rerouted (+${Math.round(d.extraS)} s)` : d.outcome}`, 'warn'); break;
    case 'closures': s.closures = new Map(d.map(([id, status]) => [id, status])); break;
    case 'flood:updated':
      if (s.flood?.level !== d.level) feed(`≈ Mutha water level ${d.level} m`, 'flood');
      s.flood = d;
      break;
    case 'flood:points': s.floodPoints = d; break;
    case 'coverage:updated': s.coverage = d; break;
    case 'network:updated':
      if ((d.trapZones?.length ?? 0) > s.trapZones) feed(`⚠ trap zones: ${d.trapZones.length}`, 'warn');
      s.trapZones = d.trapZones?.length ?? 0;
      break;
    case 'scenario:updated':
      for (const e of d.events ?? []) if (!s.feed.some((f) => f.text === `⚠ ${e.text}`)) feed(`⚠ ${e.text}`, 'warn');
      s.scenario = d;
      break;
    default:
  }
}

export default function Replay() {
  const [list, setList] = useState([]);
  const [name, setName] = useState(null);
  const [events, setEvents] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [geom, setGeom] = useState(null);
  const [bbox, setBbox] = useState(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [, setFrame] = useState(0);
  const st = useRef({ s: emptyState(), i: 0, t: 0, applied: 0 });

  useEffect(() => {
    getJson('/api/replays').then((l) => { setList(l); setName((l.find((x) => x.name === 'monsoon-demo.jsonl') ?? l[0])?.name ?? null); }).catch((e) => setError(e.message));
    getJson('/api/summary').then((s) => setBbox(s.bbox)).catch(() => {});
    getJson('/api/geometry/roads').then(setGeom).catch(() => {});
  }, []);

  useEffect(() => {
    if (!name) return;
    setPlaying(false); setError(null);
    fetch(`/api/replays/${encodeURIComponent(name)}`).then((r) => {
      if (!r.ok) throw new Error(`Replay not found (${r.status})`);
      return r.text();
    }).then((text) => {
      const evs = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      setMeta(evs.find((e) => e.type === 'meta')?.data ?? null);
      setEvents(evs);
      st.current = { s: emptyState(), i: 0, t: 0, applied: 0 };
      setCursor(0);
    }).catch((e) => setError(e.message));
  }, [name]);

  const endT = events.length ? events.at(-1).t : 0;

  // Apply every event up to time t. Going backwards (scrubber) rebuilds the state from the first event.
  const seek = (t) => {
    const r = st.current;
    if (t < r.applied) { r.s = emptyState(); r.i = 0; }
    while (r.i < events.length && events[r.i].t <= t) apply(r.s, events[r.i++]);
    r.applied = t;
    r.t = t;
    setCursor(t);
    setFrame((f) => f + 1);
  };

  useEffect(() => {
    if (!playing) return undefined;
    let last = performance.now(), raf = 0, sinceRender = 0;
    const step = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      const t = Math.min(endT, st.current.t + dt * speed);
      st.current.t = t;                            // the clock always advances
      sinceRender += dt;
      if (sinceRender > 0.08 || t >= endT) { sinceRender = 0; seek(t); }   // apply + render ~12 times a second
      if (t >= endT) { setPlaying(false); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, events]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = st.current.s;
  const geomIndex = useMemo(() => (geom ? new Map(geom.ids.map((id, i) => [id, i])) : null), [geom]);
  const closureLines = { BLOCKED: [], HIGH_RISK: [] };
  if (geomIndex) for (const [id, status] of s.closures) { const i = geomIndex.get(id); if (i !== undefined && closureLines[status]) closureLines[status].push(geom.lines[i]); }

  return (
    <div className="page">
      <SafetyBanner />
      <header className="topbar">
        <div><h1>Replay</h1><NavLinks /></div>
        <div className="chips">
          <span className="chip">Sim {fmtClock(cursor)} / {fmtClock(endT)}</span>
          {s.flood && <span className="chip">Water {s.flood.level} m</span>}
          {s.coverage && <span className="chip">Fire coverage ≤ 8 min {s.coverage.fire.pct8}%</span>}
        </div>
      </header>
      <main className="workspace">
        {bbox ? (
          <MapFrame>
            {(setTileErrors) => (
              <MapContainer bounds={[[bbox.south, bbox.west], [bbox.north, bbox.east]]} className="map" preferCanvas zoomSnap={0.25}>
                <BaseTiles onErrorsChange={setTileErrors} />
                <AreaBox bbox={bbox} />
                {closureLines.HIGH_RISK.length > 0 && <Polyline positions={closureLines.HIGH_RISK} interactive={false} pathOptions={{ color: '#f59e0b', weight: 4, opacity: 0.8 }} />}
                {closureLines.BLOCKED.length > 0 && <Polyline positions={closureLines.BLOCKED} interactive={false} pathOptions={{ color: '#ef4444', weight: 5, dashArray: '2 8' }} />}
                {s.floodPoints.map((p, i) => <CircleMarker key={`f${i}`} center={p} radius={7} interactive={false} pathOptions={{ stroke: false, fillColor: '#3b82f6', fillOpacity: 0.55 }} />)}
                {[...s.incidents.values()].map((i) => (
                  <Marker key={i.id} position={[i.lat, i.lng]} icon={divIcon(`inc ${i.status}`, TYPE_ICON[i.type], i.status === 'RESOLVED' ? 16 : 24)}>
                    <Popup><b>{i.id}</b> {i.type} · {i.status}{i.unitId ? ` · ${i.unitId}` : ''}</Popup>
                  </Marker>
                ))}
                {[...s.units.values()].filter((u) => u.status !== 'AVAILABLE' && u.route?.length > 1).map((u) => (
                  <Polyline key={`r-${u.id}`} positions={u.route} interactive={false} pathOptions={{ color: '#2563eb', weight: 3, opacity: 0.7 }} />
                ))}
                {[...s.units.values()].filter((u) => u.status !== 'AVAILABLE').map((u) => (
                  <Marker key={u.id} position={[u.lat, u.lng]} zIndexOffset={1000} icon={divIcon(`unit ${u.status}`, UNIT_LETTER[u.type], 20)} />
                ))}
              </MapContainer>
            )}
          </MapFrame>
        ) : <div className="map-shell loading">{error ?? 'Loading…'}</div>}
        <aside className="side">
          <section className="panel">
            <h2>Event log replay</h2>
            <label>Log
              <select value={name ?? ''} onChange={(e) => setName(e.target.value)}>
                {list.map((l) => <option key={l.name} value={l.name}>{l.kind === 'saved' ? '★ ' : ''}{l.name} ({Math.round(l.bytes / 1024)} KB)</option>)}
              </select>
            </label>
            {meta && <p className="note" style={{ marginTop: 0 }}>{meta.name ?? meta.label} · {events.length.toLocaleString('en-IN')} events{meta.deterministic ? ' · deterministic recording' : ''}</p>}
            <div className="btn-row">
              <button type="button" onClick={() => { if (cursor >= endT) seek(0); setPlaying(!playing); }} disabled={!events.length}>{playing ? 'Pause' : cursor >= endT && endT > 0 ? 'Replay' : 'Play'}</button>
              <button type="button" onClick={() => { setPlaying(false); seek(0); }}>⏮ Start</button>
              {SPEEDS.map((x) => <button key={x} type="button" className={`sm ${speed === x ? 'on' : ''}`} onClick={() => setSpeed(x)}>{x}×</button>)}
            </div>
            <input className="scrub" type="range" min="0" max={endT || 1} step="1" value={cursor} aria-label="Replay position"
              onChange={(e) => { setPlaying(false); seek(Number(e.target.value)); }} />
            <dl className="kv">
              <dt>Incidents</dt><dd>{s.incidents.size} ({[...s.incidents.values()].filter((i) => i.status === 'RESOLVED').length} resolved)</dd>
              <dt>Units moving</dt><dd>{[...s.units.values()].filter((u) => ['EN_ROUTE', 'TO_HOSPITAL', 'RETURNING'].includes(u.status)).length}</dd>
              <dt>Roads closed</dt><dd>{[...s.closures.values()].filter((x) => x === 'BLOCKED').length} blocked · {[...s.closures.values()].filter((x) => x === 'HIGH_RISK').length} high-risk</dd>
              <dt>Flooded junctions</dt><dd>{s.floodPoints.length}</dd>
              <dt>Trap zones</dt><dd>{s.trapZones}</dd>
            </dl>
            <p className="note">Speed is relative to simulated time (1× = real time). The log is JSONL with simulated timestamps. Works offline: only the base map tiles need the internet.</p>
          </section>
          <section className="panel">
            <h2>Event feed</h2>
            <ul className="feed">
              {[...s.feed].reverse().slice(0, 16).map((f, i) => <li key={`${f.t}-${i}`} className={f.kind}><span className="muted">{fmtClock(f.t)}</span> {f.text}</li>)}
            </ul>
          </section>
        </aside>
      </main>
    </div>
  );
}
