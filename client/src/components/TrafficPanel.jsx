import React, { useState } from 'react';
import { emitAck } from '../socket.js';
import { fmtTime } from '../format.js';

export const TRAFFIC_COLORS = [[1.25, '#22c55e', 'free / light'], [2, '#f59e0b', 'slow'], [Infinity, '#ef4444', 'heavy']];
export const trafficColor = (f) => TRAFFIC_COLORS.find(([max]) => f < max)[1];

const REASONS = {
  NO_KEY: 'No TomTom key on the server (.env TOMTOM_API_KEY): live traffic unavailable, free-flow is used.',
  DAILY_CAP: 'Daily TomTom cap reached (200 calls). The last snapshot is kept.',
  FETCH_FAILED: 'TomTom could not be reached. The last snapshot is kept.',
};

// Live traffic controls: snapshot time, live / free-flow toggle, manual refresh, colour toggle, call budget.
export default function TrafficPanel({ status, calls, showColours, onShowColours }) {
  const [msg, setMsg] = useState(null);
  if (!status) return null;
  const tomtom = calls?.tomtom;
  const refresh = async () => {
    setMsg(null);
    const left = tomtom ? tomtom.cap - tomtom.calls : 200;
    if (!window.confirm(`Fetch live traffic from TomTom now? This uses ${status.samples} of today's ${left} remaining calls.`)) return;
    try {
      let r = await emitAck('traffic:refresh', {}, 120000);
      if (r.reason === 'TOO_SOON' && window.confirm(`${r.message} Refresh anyway?`)) r = await emitAck('traffic:refresh', { force: true }, 120000);
      setMsg(r.ok
        ? { text: `Fetched ${r.fetched} of ${status.samples} sample points${r.failed ? `, ${r.failed} failed` : ''}${r.capReached ? ' (daily cap reached part-way)' : ''}; ${r.matchedRoads} roads updated.` }
        : { bad: true, text: REASONS[r.reason] ?? r.message ?? r.reason });
    } catch { setMsg({ bad: true, text: 'Server did not answer.' }); }
  };
  const setMode = async (mode) => {
    const r = await emitAck('traffic:mode', { mode });
    if (!r.ok) setMsg({ bad: true, text: r.message });
  };
  const live = status.mode === 'live';
  return (
    <section className="panel">
      <h2>Traffic</h2>
      <p className={live ? 'okmsg' : 'muted'} style={{ marginTop: 0 }}>
        {live && status.snapshotAt
          ? <>Traffic as of <b>{fmtTime(status.snapshotAt)}</b>{status.snapshotSource === 'disk' ? ' (saved snapshot)' : ''}{status.partial ? ' · partial' : ''} · {status.fetchedSamples} samples, {status.matchedRoads} roads</>
          : <>Free-flow{!status.hasKey && ' · live traffic unavailable (no TomTom key)'}{status.hasKey && !status.snapshotAt && ' · no snapshot yet'}</>}
      </p>
      <div className="tabs small">
        <button type="button" className={live ? 'on' : ''} disabled={!status.snapshotAt} onClick={() => setMode('live')}>Live traffic</button>
        <button type="button" className={!live ? 'on' : ''} onClick={() => setMode('free-flow')}>Free-flow</button>
      </div>
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button type="button" onClick={refresh} disabled={!status.hasKey || status.refreshing || (tomtom && tomtom.calls >= tomtom.cap)}
          title={status.hasKey ? 'Fetch all sample points from TomTom' : 'Needs TOMTOM_API_KEY in .env'}>
          {status.refreshing ? 'Refreshing…' : 'Refresh traffic'}
        </button>
        <label className="check inline"><input type="checkbox" checked={showColours} onChange={() => onShowColours(!showColours)} disabled={!status.snapshotAt} /> Colour sampled roads</label>
      </div>
      {showColours && status.snapshotAt && (
        <div className="legend-row">{TRAFFIC_COLORS.map(([max, c, label], i) => (
          <span key={c}><i className="swatch" style={{ background: c }} />{label} ({i === 0 ? '< 1.25' : i === 1 ? '1.25–2' : '≥ 2'}×)</span>
        ))}</div>
      )}
      {msg && <p className={msg.bad ? 'alert' : 'okmsg'}>{msg.text}</p>}
      <p className="note">
        TomTom calls today: <b>{tomtom?.calls ?? 0}/{tomtom?.cap ?? 200}</b> (one refresh = {status.samples} calls; the cap is enforced on the server).
        Factor = free-flow speed ÷ current speed, clamped to 1–4 so A* stays exact. TomTom is only called when you press this button (never automatically).
      </p>
    </section>
  );
}
