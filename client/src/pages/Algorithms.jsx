import React, { useEffect, useRef, useState } from 'react';
import { fmtInt } from '../format.js';
import SafetyBanner from '../components/SafetyBanner.jsx';
import NavLinks from '../components/NavLinks.jsx';
import AlgoMap, { rampColor } from '../components/AlgoMap.jsx';
import { ALGORITHMS } from '../data/algorithmInfo.js';

const ANIM_SECONDS = { slow: 20, normal: 8, fast: 3 };

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// /algorithms: run BFS or DFS from any junction on the real Pune graph and watch the visit order,
// plus an explanation card for every algorithm and data structure in the project.
export default function Algorithms() {
  const [bbox, setBbox] = useState(null);
  const [algo, setAlgo] = useState('bfs');
  const [point, setPoint] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pace, setPace] = useState('normal');
  const [colorBy, setColorBy] = useState('order');
  const raf = useRef(0);

  useEffect(() => {
    getJson('/api/summary').then((s) => {
      setBbox(s.bbox);
      // deep link for demos: /algorithms?algo=dfs&at=18.5167,73.8414
      const q = new URLSearchParams(window.location.search);
      const m = q.get('at')?.match(/^(-?[\d.]+),(-?[\d.]+)$/);
      const k = q.get('algo') === 'dfs' ? 'dfs' : 'bfs';
      if (m) { const p = { lat: Number(m[1]), lng: Number(m[2]) }; setAlgo(k); setPoint(p); run(k, p); }
    }).catch((e) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (kind = algo, p = point) => {
    if (!p) return;
    setError(null);
    try {
      const r = await getJson(`/api/traverse?algo=${kind}&atLat=${p.lat}&atLng=${p.lng}`);
      setResult(r); setShown(0); setPlaying(true);
    } catch (e) { setError(e.message); }
  };

  // Animation: reveal the visit order over ANIM_SECONDS[pace] seconds.
  useEffect(() => {
    if (!playing || !result) return undefined;
    let last = performance.now();
    const perMs = result.order.length / (ANIM_SECONDS[pace] * 1000);
    let acc = shown;
    const step = (now) => {
      acc = Math.min(result.order.length, acc + (now - last) * perMs);
      last = now;
      setShown(Math.floor(acc));
      if (acc < result.order.length) raf.current = requestAnimationFrame(step);
      else setPlaying(false);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, result, pace]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (p) => { setPoint(p); run(algo, p); };
  const done = result && shown >= result.order.length;
  const startNode = result?.start;

  return (
    <div className="page">
      <SafetyBanner />
      <header className="topbar">
        <div>
          <h1>Algorithms</h1>
          <NavLinks />
        </div>
        <div className="chips"><span className="chip">BFS / DFS on the real central-Pune road graph</span></div>
      </header>

      <main className="workspace">
        {bbox ? (
          <AlgoMap bbox={bbox} result={result} shown={shown} colorBy={colorBy} onPick={pick}
            start={startNode ? { lat: startNode.lat, lng: startNode.lng } : null} />
        ) : <div className="map-shell loading">{error ? `API not reachable: ${error}` : 'Loading…'}</div>}

        <aside className="side">
          <section className="panel">
            <h2>Graph traversal</h2>
            <div className="btn-row">
              {[['bfs', 'BFS'], ['dfs', 'DFS']].map(([k, label]) => (
                <button key={k} type="button" className={algo === k ? 'on' : ''} onClick={() => { setAlgo(k); if (point) run(k, point); }}>{label}</button>
              ))}
            </div>
            {!point && <p className="hint">Click any point on the map. The nearest junction (k-d tree) becomes the start and {algo.toUpperCase()} runs from it.</p>}
            {error && <p className="alert">{error}</p>}
            {result && (
              <>
                <dl className="kv">
                  <dt>Start junction</dt><dd>{result.start.nodeId} ({result.start.distanceM} m from click)</dd>
                  <dt>Junctions reached</dt><dd><b>{fmtInt(result.reached)}</b> of {fmtInt(result.total)}</dd>
                  <dt>Shown so far</dt><dd>{fmtInt(shown)}</dd>
                  <dt>{result.algorithm === 'bfs' ? 'Levels (max roads from start)' : 'Max DFS-tree depth'}</dt><dd>{fmtInt(result.maxDepth)}</dd>
                  {result.maxStack != null && <><dt>Max stack size</dt><dd>{fmtInt(result.maxStack)}</dd></>}
                  <dt>Run time (server)</dt><dd>{result.ms} ms</dd>
                  <dt>Blocked roads</dt><dd>{result.blockedRoads} (BFS/DFS never cross them)</dd>
                </dl>
                {result.reached < result.total && <p className="alert">{fmtInt(result.total - result.reached)} junctions are unreachable from here (closures or one-way streets).</p>}
                <div className="btn-row">
                  <button type="button" onClick={() => setPlaying(!playing)} disabled={done && !playing}>{playing ? 'Pause' : 'Play'}</button>
                  <button type="button" onClick={() => { setShown(0); setPlaying(true); }}>Replay</button>
                  <button type="button" onClick={() => { setPlaying(false); setShown(result.order.length); }}>Show all</button>
                </div>
                <input className="scrub" type="range" min="0" max={result.order.length} value={shown} aria-label="Visit order position"
                  onChange={(e) => { setPlaying(false); setShown(Number(e.target.value)); }} />
                <div className="btn-row">
                  <span className="muted">Speed</span>
                  {Object.keys(ANIM_SECONDS).map((k) => <button key={k} type="button" className={`sm ${pace === k ? 'on' : ''}`} onClick={() => setPace(k)}>{k}</button>)}
                </div>
                <div className="btn-row">
                  <span className="muted">Colour by</span>
                  <button type="button" className={`sm ${colorBy === 'order' ? 'on' : ''}`} onClick={() => setColorBy('order')}>visit order</button>
                  <button type="button" className={`sm ${colorBy === 'depth' ? 'on' : ''}`} onClick={() => setColorBy('depth')}>{result.algorithm === 'bfs' ? 'level' : 'depth'}</button>
                </div>
                <div className="ramp" style={{ background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map(rampColor).join(',')})` }} />
                <div className="ramp-labels"><span>{colorBy === 'order' ? 'first visited' : 'depth 0'}</span><span>{colorBy === 'order' ? 'last visited' : `depth ${result.maxDepth}`}</span></div>
                <p className="note">
                  {result.algorithm === 'bfs'
                    ? 'BFS spreads out in rings: every junction k roads away is visited before any junction k+1 roads away.'
                    : 'DFS dives down one long path before backtracking, so the colours run along long snaking chains.'}
                  {' '}Lines show the search tree (each junction joined to the one it was discovered from).
                </p>
              </>
            )}
          </section>
        </aside>
      </main>

      <section className="cards-section">
        <h2>How each algorithm works</h2>
        <div className="algo-cards">
          {ALGORITHMS.map((a) => (
            <article key={a.id} className="panel algo-card" id={a.id}>
              <h3>{a.name}</h3>
              <p className="muted mono">{a.file} · {a.phase}</p>
              <dl className="kv">
                <dt>Purpose</dt><dd>{a.purpose}</dd>
                <dt>Input</dt><dd>{a.input}</dd>
                <dt>Output</dt><dd>{a.output}</dd>
              </dl>
              <h4>Steps</h4>
              <ol>{a.steps.map((s) => <li key={s}>{s}</li>)}</ol>
              <p><b>Complexity:</b> {a.complexity}</p>
              <p className="muted">Used for: {a.use}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
