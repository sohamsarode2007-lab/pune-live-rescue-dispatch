import React, { useEffect, useState } from 'react';
import { fmtDuration, fmtKm, fmtTime } from '../format.js';

// "Our engine vs OSRM" for one origin/destination. OSRM is fetched only on request (light use, 1 req/s
// server-side, cached). onResult(result|null) lets the page draw both routes on the map.
export default function OsrmPanel({ from, to, label, onResult }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const key = from && to ? `${from.lat},${from.lng}>${to.lat},${to.lng}` : '';

  useEffect(() => { setRes(null); setError(null); onResult?.(null); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!from || !to) return null;
  const run = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/compare?fromLat=${from.lat}&fromLng=${from.lng}&toLat=${to.lat}&toLng=${to.lng}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || r.statusText);
      setRes(body); onResult?.(body);
    } catch (e) { setError(e.message); onResult?.(null); }
    setBusy(false);
  };
  const o = res?.ours, x = res?.osrm;
  return (
    <section className="panel">
      <h2>Our engine vs OSRM</h2>
      <p className="note" style={{ marginTop: 0 }}>{label}</p>
      <button type="button" className="ghost" onClick={run} disabled={busy}>{busy ? 'Asking OSRM…' : res ? 'Compare again' : 'Compare with OSRM'}</button>
      {error && <p className="alert">{error}</p>}
      {res && (
        <>
          <table className="cmp">
            <thead><tr><th></th><th><i className="swatch" style={{ background: '#22d3ee' }} />Ours</th><th><i className="swatch" style={{ background: '#c084fc' }} />OSRM</th></tr></thead>
            <tbody>
              <tr><th>Traffic</th><td>{o.trafficMode === 'live' ? `live (${fmtTime(o.trafficAt)})` : 'free-flow'}</td><td>normal (OSRM profile)</td></tr>
              <tr><th>ETA</th><td><b>{fmtDuration(o.etaS)}</b></td><td>{x.available ? <b>{fmtDuration(x.durationS)}</b> : '—'}</td></tr>
              <tr><th>Distance</th><td>{fmtKm(o.lengthM)}</td><td>{x.available ? fmtKm(x.distanceM) : '—'}</td></tr>
              <tr><th>Same route, free-flow</th><td>{fmtDuration(o.freeFlowS)}</td><td></td></tr>
            </tbody>
          </table>
          {x.available
            ? <p className="okmsg">Our ETA is <b>{res.diffPct >= 0 ? '+' : ''}{res.diffPct.toFixed(1)}%</b> vs OSRM{x.cached ? ' (OSRM answer from cache)' : ''}.</p>
            : <p className="alert">OSRM comparison unavailable: {x.reason}. Our route is still shown.</p>}
          {res.summary?.all?.n > 0 && (
            <p className="note">Logged comparisons: {res.summary.all.n}; mean difference {res.summary.all.meanDiffPct}% (mean absolute {res.summary.all.meanAbsDiffPct}%)
              {res.summary.live.n > 0 && <> · with live traffic: {res.summary.live.meanDiffPct}% over {res.summary.live.n}</>}.</p>
          )}
        </>
      )}
      <p className="note">OSRM (public demo server) is a baseline only: its route uses normal traffic. Ours uses live traffic when a snapshot is applied. Same snapped start and end junctions for both.</p>
    </section>
  );
}
