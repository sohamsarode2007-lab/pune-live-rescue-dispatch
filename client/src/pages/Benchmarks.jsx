import React, { useEffect, useState } from 'react';
import SafetyBanner from '../components/SafetyBanner.jsx';
import NavLinks from '../components/NavLinks.jsx';

const n = (x) => (x == null ? '—' : Number(x).toLocaleString('en-IN'));

// /benchmarks: results of scripts/bench.mjs (server/data/benchmarks.json).
export default function Benchmarks() {
  const [b, setB] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    fetch('/api/benchmarks').then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }).then(setB).catch((e) => setError(e.message));
  }, []);
  const path = (label, x) => (x.skipped
    ? <tr><th>{label}</th><td colSpan="5" className="muted">skipped: {x.reason}</td></tr>
    : <tr><th>{label} ({n(x.junctions)} junctions, {x.pairs} pairs)</th><td>{x.dijkstra.meanMs} ms · {n(x.dijkstra.settledMean)}</td><td>{x.astar.meanMs} ms · {n(x.astar.settledMean)}</td><td>{x.settledRatioPct}%</td><td>{x.speedup}×</td><td>{x.sameCost}/{x.pairs}</td></tr>);
  const burst = (label, x) => (
    <tr><th>{label}</th><td>{x.validSeeds}{x.busyFraction ? ` (avg ${x.servedMean} served)` : ''}</td><td>{x.greedyWorse} / {x.equal} / {x.hungarianWorse}</td>
      <td>{x.savingS.mean} s ({x.savingPct.mean}%)</td><td>{x.savingS.median} s</td><td>{x.savingS.max} s ({x.savingPct.max}%)</td></tr>
  );
  return (
    <div className="page">
      <SafetyBanner />
      <header className="topbar"><div><h1>Benchmarks</h1><NavLinks /></div>
        {b && <div className="chips"><span className="chip">{b.machine.cpu} · {b.machine.cores} threads · Node {b.machine.node}</span><span className="chip">{b.generatedAt.slice(0, 10)}</span></div>}
      </header>
      <main className="bench">
        {error && <p className="alert">{error}</p>}
        {!b && !error && <p className="muted">Loading…</p>}
        {b && (
          <>
            <section className="panel"><h2>Shortest paths: Dijkstra vs A* (mean time · junctions settled per query)</h2>
              <table className="cmp"><thead><tr><th>Graph</th><th>Dijkstra</th><th>A*</th><th>A* settles</th><th>Speed-up</th><th>Same cost</th></tr></thead>
                <tbody>{path('Central Pune', b.pathCentral)}{path('Full Pune', b.pathFull)}</tbody></table>
            </section>
            <section className="panel"><h2>Nearest junction: k-d tree vs brute force ({n(b.kdtree.queries)} queries, {n(b.kdtree.points)} junctions)</h2>
              <table className="cmp"><thead><tr><th>k-d tree</th><th>Brute force</th><th>Speed-up</th><th>Same answer</th><th>Visited / query</th><th>Build</th></tr></thead>
                <tbody><tr><td>{b.kdtree.treeMs} ms</td><td>{b.kdtree.bruteMs} ms</td><td>{b.kdtree.speedup}×</td><td>{n(b.kdtree.agree)}/{n(b.kdtree.queries)}</td><td>{b.kdtree.visitedMean}</td><td>{b.kdtree.buildMs} ms</td></tr></tbody></table>
            </section>
            <section className="panel"><h2>Greedy vs Hungarian: 300 random 8-incident bursts (seconds of total ETA saved by Hungarian)</h2>
              <table className="cmp"><thead><tr><th>Units</th><th>Comparable bursts</th><th>Better / equal / worse</th><th>Mean</th><th>Median</th><th>Max</th></tr></thead>
                <tbody>{burst('All free', b.burstFree)}{burst('Half busy (seeded)', b.burstHalfBusy)}</tbody></table>
              <p className="note">The demo burst (seed {b.burstFree.demo.seed}, {b.burstFree.demo.savingS} s) is the clearest of the 300. A 50 × 50 matrix: Hungarian {b.hungarian50.hungarianMs} ms, greedy {b.hungarian50.greedyMs} ms.</p>
            </section>
            <section className="panel"><h2>Other algorithms (central Pune)</h2>
              <table className="cmp"><thead><tr><th>Algorithm</th><th>Time</th><th>Result</th></tr></thead><tbody>
                <tr><th>Tarjan bridges + articulation points</th><td>{b.tarjan.bridgesApMs} ms</td><td>{n(b.tarjan.bridges)} bridges, {n(b.tarjan.articulationPoints)} articulation points</td></tr>
                <tr><th>Tarjan SCC</th><td>{b.tarjan.sccMs} ms</td><td>{b.tarjan.components} component(s)</td></tr>
                <tr><th>Multi-source Dijkstra (5 fire stations)</th><td>{b.planning.multiSourceMs} ms</td><td>time to nearest station for every junction</td></tr>
                <tr><th>Coverage isochrones</th><td>{b.planning.coverageMs} ms</td><td>{b.planning.coveragePct8}% of roads within 8 min</td></tr>
                <tr><th>Edmonds-Karp, normal</th><td>{b.planning.edmondsKarp.normal.ms} ms</td><td>{b.planning.edmondsKarp.normal.augmentations} augmenting paths, {n(b.planning.edmondsKarp.normal.evacuable)} of {n(b.planning.edmondsKarp.normal.total)} people</td></tr>
                <tr><th>Edmonds-Karp, 10 m flood</th><td>{b.planning.edmondsKarp.flood.ms} ms</td><td>{b.planning.edmondsKarp.flood.augmentations} augmenting paths, {n(b.planning.edmondsKarp.flood.evacuable)} people</td></tr>
                <tr><th>Greedy k-center (2 scenarios)</th><td>{n(b.planning.kcenter.totalMs)} ms</td><td>{b.planning.kcenter.candidates} candidates each</td></tr>
              </tbody></table>
              <p className="note">Generated by <code>node scripts/bench.mjs</code> in {b.totalS} s. The same tables are in the README.</p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
