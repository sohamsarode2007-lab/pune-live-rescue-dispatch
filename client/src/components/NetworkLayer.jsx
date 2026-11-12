import React from 'react';
import { Polyline, CircleMarker, Marker, Popup } from 'react-leaflet';
import { divIcon } from './mapParts.jsx';
import { crossingText } from './NetworkPanels.jsx';

const ZONE_COLOR = { trap: '#f97316', 'no-entry': '#a855f7', isolated: '#ef4444', passage: '#eab308' };

// Network tab map layer: rivers, Tarjan bridges / articulation points (critical by default), ranked river
// crossings, and trap zones (shown on every tab).
export default function NetworkLayer({ rivers = [], spof = null, showAll = false, crossings = [], selectedCrossingId, onSelectCrossing, onSetCrossingStatus, zones = [] }) {
  const bridges = spof ? spof.bridges.filter((b) => showAll || b.critical) : [];
  const aps = spof ? spof.articulationPoints.filter((a) => showAll || a.critical) : [];
  return (
    <>
      {rivers.flatMap((r) => r.lines.map((l, i) => (
        <Polyline key={`${r.name}-${i}`} positions={l} interactive={false}
          pathOptions={{ color: /mutha/i.test(r.name) ? '#38bdf8' : '#0ea5e9', weight: /mutha/i.test(r.name) ? 4 : 2, opacity: 0.55 }} />
      )))}

      {bridges.map((b) => (
        <Polyline key={b.roadId} positions={b.geometry}
          pathOptions={b.critical ? { color: '#f43f5e', weight: 6, opacity: 0.9 } : { color: '#fda4af', weight: 2, opacity: 0.6 }}>
          <Popup>
            <b>{b.name || 'Unnamed road'}</b> · bridge in the graph sense ({b.critical ? 'critical' : 'trivial'})<br />
            Losing it cuts off <b>{b.cutJunctions}</b> junction{b.cutJunctions > 1 ? 's' : ''}
            {b.facilitiesCutOffTotal > 0 && <> incl. {b.facilitiesCutOffTotal} facilit{b.facilitiesCutOffTotal > 1 ? 'ies' : 'y'}</>}.
            {b.losesAccessTo.length > 0 && <><br />The cut-off part has no {b.losesAccessTo.map((k) => k.replace('_', ' ')).join(' / ')}.</>}
          </Popup>
        </Polyline>
      ))}

      {aps.map((a) => (
        <CircleMarker key={a.nodeId} center={[a.lat, a.lng]} radius={a.critical ? 6 : 3}
          pathOptions={{ color: '#fff', weight: a.critical ? 2 : 0.5, fillColor: a.critical ? '#e11d48' : '#fb7185', fillOpacity: 0.95 }}>
          <Popup>
            Junction {a.nodeId} · articulation point ({a.critical ? 'critical' : 'trivial'})<br />
            Removing it splits the network into {a.pieces} parts and cuts off <b>{a.cutJunctions}</b> junctions
            {a.facilitiesCutOffTotal > 0 && <> incl. {a.facilitiesCutOffTotal} facilit{a.facilitiesCutOffTotal > 1 ? 'ies' : 'y'}</>}.
          </Popup>
        </CircleMarker>
      ))}

      {zones.flatMap((z) => z.points.map((p, i) => (
        <CircleMarker key={`${z.id}-${i}`} center={p} radius={4} interactive={i === 0}
          pathOptions={{ color: ZONE_COLOR[z.kind], weight: 1, fillColor: ZONE_COLOR[z.kind], fillOpacity: 0.8 }}>
          {i === 0 && <Popup><b>{z.id}</b>: {z.junctions} junctions, {z.kind}</Popup>}
        </CircleMarker>
      )))}

      {crossings.map((c) => (
        <Marker key={c.id} position={[c.lat, c.lng]} zIndexOffset={1200}
          icon={divIcon(`crossing ${c.rank <= 3 ? 'top' : ''} ${c.closed ? 'closed' : ''} ${c.id === selectedCrossingId ? 'sel' : ''}`, String(c.rank), 22)}
          eventHandlers={{ click: () => onSelectCrossing?.(c.id) }}>
          <Popup>
            <b>#{c.rank} {c.name}</b> ({c.river})<br />{crossingText(c)}
            <br />
            {c.closed
              ? <button type="button" onClick={() => onSetCrossingStatus?.(c.id, 'OPEN')}>Reopen crossing</button>
              : <button type="button" onClick={() => onSetCrossingStatus?.(c.id, 'BLOCKED')}>Close crossing (flood)</button>}
          </Popup>
        </Marker>
      ))}
    </>
  );
}
