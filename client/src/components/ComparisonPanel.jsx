import React, { useEffect, useState } from 'react';
import { fmtDuration } from '../format.js';
import { api } from '../api.js';

const TRIGGER = { sos: 'new SOS', burst: 'burst', 'unit-free': 'unit freed', retry: 'retry' };
const pct = (a, b) => (b > 0 ? `${((100 * (b - a)) / b).toFixed(1)}%` : '—');

// 300-seed benchmark summary (scripts/bench-burst.mjs), shown under the live comparison.
function BenchmarkNote() {
  const [b, setB] = useState(null);
  useEffect(() => { api.burstBenchmark().then(setB).catch(() => setB(false)); }, []);
  if (!b) return null;
  return (
    <div className="subnote">
      <b>Benchmark, {b.seeds} random burst patterns</b> (every unit at its station, free-flow): Hungarian was better on {b.greedyWorse},
      equal on {b.equal}, worse on {b.hungarianWorse}. Saving per burst: mean {fmtDuration(b.savingS.mean)} ({b.savingPct.mean}%),
      median {fmtDuration(b.savingS.median)}, min {fmtDuration(b.savingS.min)}, max {fmtDuration(b.savingS.max)} ({b.savingPct.max}% max).
      {b.whenGreedyWorse && <> When greedy is worse, Hungarian saves {fmtDuration(b.whenGreedyWorse.meanS)} ({b.whenGreedyWorse.meanPct}%) on average.</>}
      {' '}The demo pattern (seed {b.demo.seed}, {fmtDuration(b.demo.savingS)} / {b.demo.savingPct}%) is the <b>clearest of the {b.seeds}</b> by time saved
      {b.highestPctSeed && b.highestPctSeed.seed !== b.demo.seed && <> (seed {b.highestPctSeed.seed} has the highest percentage, {b.highestPctSeed.savingPct}%)</>}, so it is not a typical case.
    </div>
  );
}

// Greedy vs optimal: every dispatch batch is planned both ways on the same incidents and units.
export default function ComparisonPanel({ comparisons, totals, mode }) {
  const multi = comparisons.filter((c) => c.incidents > 1);
  const [pick, setPick] = useState(null);
  const c = comparisons.find((x) => x.id === pick) ?? multi.at(-1) ?? comparisons.at(-1);
  if (!c) {
    return (
      <section className="panel">
        <h2>Greedy vs optimal</h2>
        <p className="muted">No dispatch yet. Press <b>Burst</b> to send 8 simultaneous incidents.</p>
        <BenchmarkNote />
      </section>
    );
  }
  const saving = c.greedy.totalS - c.hungarian.totalS;
  const sameCount = c.greedy.assigned === c.hungarian.assigned;
  return (
    <section className="panel">
      <h2>Greedy vs optimal</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Batch #{c.id} ({TRIGGER[c.trigger] ?? c.trigger}, sim {fmtDuration(c.atS)}): {c.incidents} incident{c.incidents > 1 ? 's' : ''}, {c.units} free unit{c.units > 1 ? 's' : ''}.
        Executed: <b>{c.mode === 'hungarian' ? 'Hungarian' : 'greedy'}</b>.
      </p>
      <table className="cmp">
        <thead><tr><th></th><th>Served</th><th>Total ETA</th><th>Average</th></tr></thead>
        <tbody>
          <tr className={c.mode === 'greedy' ? 'exec' : ''}><th>Greedy</th><td>{c.greedy.assigned}</td><td>{fmtDuration(c.greedy.totalS)}</td><td>{fmtDuration(c.greedy.assigned ? c.greedy.totalS / c.greedy.assigned : null)}</td></tr>
          <tr className={c.mode === 'hungarian' ? 'exec' : ''}><th>Hungarian</th><td>{c.hungarian.assigned}</td><td><b>{fmtDuration(c.hungarian.totalS)}</b></td><td>{fmtDuration(c.hungarian.assigned ? c.hungarian.totalS / c.hungarian.assigned : null)}</td></tr>
        </tbody>
      </table>
      {sameCount && saving > 0.5 && <p className="okmsg">Optimal assignment saves <b>{fmtDuration(saving)}</b> of total response time ({pct(c.hungarian.totalS, c.greedy.totalS)}).</p>}
      {sameCount && saving <= 0.5 && <p className="muted">Same total: greedy happened to be optimal for this batch.</p>}
      {!sameCount && <p className="alert">Hungarian serves {c.hungarian.assigned - c.greedy.assigned} more incident(s) than greedy.</p>}

      {c.pairs.length > 1 && (
        <details open={c.incidents > 1}>
          <summary>Who goes where ({c.pairs.filter((p) => p.unitId !== p.greedyUnitId).length} differ)</summary>
          <table className="cmp pairs">
            <thead><tr><th>Incident</th><th>{c.mode === 'hungarian' ? 'Hungarian' : 'Executed'}</th><th>Greedy</th></tr></thead>
            <tbody>
              {c.pairs.map((p) => (
                <tr key={p.incidentId} className={p.unitId !== p.greedyUnitId ? 'diff' : ''}>
                  <th>{p.incidentId}</th>
                  <td>{p.unitId} · {fmtDuration(p.etaS)}</td>
                  <td>{p.greedyUnitId ? `${p.greedyUnitId} · ${fmtDuration(p.greedyEtaS)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {totals && totals.batches > 0 && (
        <p className="note">
          All {totals.batches} batches so far ({totals.multiBatches} with 2+ incidents): greedy {fmtDuration(totals.greedyS)} vs
          Hungarian {fmtDuration(totals.hungarianS)} total ETA ({pct(totals.hungarianS, totals.greedyS)} less).
          Currently executing: <b>{mode}</b>.
        </p>
      )}
      {multi.length > 1 && (
        <div className="btn-row batch-pick">
          {multi.slice(-6).map((b) => <button key={b.id} type="button" className={`sm ${b.id === c.id ? 'on' : ''}`} onClick={() => setPick(b.id)}>#{b.id}</button>)}
        </div>
      )}
      <BenchmarkNote />
      <p className="note">Both plans use the same ETA matrix (one reverse Dijkstra per incident). Greedy: incidents in priority order, each takes its nearest free unit. Hungarian: minimum total ETA, O(n³). If units are short, priority decides which incidents are served, for both.</p>
    </section>
  );
}
