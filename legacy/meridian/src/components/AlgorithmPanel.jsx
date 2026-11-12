import React, { useMemo, useState } from 'react';
import { ALGORITHM_INFO } from '../data/algorithmInfo.js';
import { dijkstraAll } from '../algorithms/dijkstra.js';
import { findComponents } from '../algorithms/dfs.js';
import { buildPriorityQueue } from '../services/requestService.js';

export default function AlgorithmPanel({ sim, source, run, traversal, onRun, onClear }) {
  const g = sim.graph;
  const [start, setStart] = useState('RS1');
  const counts = g.countRoadsByStatus();
  const dj = useMemo(() => dijkstraAll(g, source).stats, [g, source, counts.OPEN, counts.HIGH_RISK, counts.BLOCKED, sim.lastChanges]);
  const comps = findComponents(g);
  const directedEdges = [...g.locations.keys()].reduce((n, id) => n + g.neighbors(id).length, 0);
  const base = `${g.locations.size} locations, ${g.roads.size} roads (${counts.OPEN} open, ${counts.HIGH_RISK} high-risk, ${counts.BLOCKED} blocked)`;

  const state = {
    bfs: [base, `${directedEdges} traversable directed edges are followed; blocked roads are skipped`],
    dfs: [base, `${comps.length} connected area${comps.length === 1 ? '' : 's'} over traversable roads`],
    dijkstra: [base, `Edge weight = distance + risk penalty (OPEN 0 or 2, HIGH_RISK 8, BLOCKED excluded)`],
    minheap: [`Run from ${source} on the current graph: ${dj.heapInsertions} insertions, ${dj.heapExtractions} extractions (${dj.staleSkipped} stale skipped), ${dj.settled} locations finalised, ${dj.relaxations} cost improvements`],
    pq: [`${buildPriorityQueue(sim.requests).size} pending request(s) currently in the queue`],
    hash: [`${g.locations.size} locations, ${g.roads.size} roads, ${sim.requests.size} requests stored in Maps`],
  };

  const nameOf = (id) => g.getLocation(id)?.name ?? id;
  const unreached = traversal ? [...g.locations.keys()].filter((id) => !traversal.reachable.has(id)) : [];

  return (
    <section className="card" aria-labelledby="al-h">
      <h2 id="al-h">Algorithm demonstrations</h2>
      <div className="subcard">
        <h3>Try BFS / DFS</h3>
        <label>Start location
          <select value={start} onChange={(e) => setStart(e.target.value)}>
            {[...g.locations.values()].map((l) => <option key={l.id} value={l.id}>{l.id} – {l.name}</option>)}
          </select>
        </label>
        <div className="btn-row">
          <button onClick={() => onRun('BFS', start)}>Run BFS</button>
          <button onClick={() => onRun('DFS', start)}>Run DFS</button>
          <button onClick={onClear} disabled={!run}>Clear highlight</button>
        </div>
        {traversal && (
          <>
            <p className="muted"><b>{run.kind}</b> from {run.start} on the current graph: {traversal.order.length} of {g.locations.size} locations reached.</p>
            <p className="mono">{traversal.order.join(' → ')}</p>
            {unreached.length > 0
              ? <p className="alert" role="status">Not reachable (cut off): {unreached.map((id) => `${id} (${nameOf(id)})`).join(', ')}</p>
              : <p className="okmsg" role="status">Every location is reachable.</p>}
            <p className="note">Teal rings on the map mark reachable locations; numbers show the visiting order. The result is recomputed whenever roads change.</p>
          </>
        )}
      </div>

      {ALGORITHM_INFO.map((a, i) => (
        <details key={a.id} open={i === 0}>
          <summary><b>{a.name}</b></summary>
          <dl className="kv algo">
            <dt>Purpose</dt><dd>{a.purpose}</dd>
            <dt>Input</dt><dd>{a.input}</dd>
            <dt>Output</dt><dd>{a.output}</dd>
            <dt>Key steps</dt><dd><ol>{a.steps.map((s) => <li key={s}>{s}</li>)}</ol></dd>
            <dt>Complexity</dt><dd>{a.complexity}</dd>
            <dt>Current graph state</dt><dd>{state[a.id].map((t) => <div key={t}>{t}</div>)}</dd>
            <dt>Code</dt><dd className="mono">src/{a.file}</dd>
          </dl>
        </details>
      ))}
    </section>
  );
}
