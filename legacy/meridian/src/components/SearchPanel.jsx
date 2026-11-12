import React, { useState } from 'react';
import { lookupById } from '../algorithms/hashLookup.js';

export default function SearchPanel({ sim, onOpen }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const submit = (e) => { e.preventDefault(); setResult(lookupById(sim.graph, sim.requests, text)); };

  const describe = ({ kind, record: r }) => {
    if (kind === 'location') return `${r.name} · ${r.type}${r.affected ? ' · affected' : ''} · position (${r.x}, ${r.y})`;
    if (kind === 'road') return `${r.from} ↔ ${r.to} · ${r.distanceKm} km · ${r.status} · penalty ${r.riskPenalty}`;
    return `${r.disasterType} at ${r.locationId} · ${r.severity} · ${r.peopleAffected} people · wait ${r.waitingTimeScore} · ${r.status}${r.assignedStation ? ` (${r.assignedStation})` : ''}`;
  };

  return (
    <section className="card" aria-labelledby="se-h">
      <h2 id="se-h">Search by ID</h2>
      <form onSubmit={submit} className="search-row">
        <input aria-label="ID to search" placeholder="e.g. H1, RD7, FLOOD-1" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit">Search</button>
      </form>
      {result?.error && <p className="alert" role="alert">{result.error}</p>}
      {result?.matches.map((m) => (
        <div className="subcard" key={m.kind}>
          <h3>{m.kind[0].toUpperCase() + m.kind.slice(1)} {m.record.id}</h3>
          <p className="muted">{describe(m)}</p>
          <button onClick={() => onOpen(m.kind, m.record.id)}>Show {m.kind === 'request' ? 'in requests' : 'on map'}</button>
        </div>
      ))}
      <p className="note">Lookups use JavaScript Map objects (average O(1)): one each for locations, roads and requests.</p>
    </section>
  );
}
