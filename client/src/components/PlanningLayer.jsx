import React, { useMemo } from 'react';
import { Polyline, Marker, Popup } from 'react-leaflet';
import { divIcon } from './mapParts.jsx';
import { COVERAGE_BANDS } from './PlanningPanels.jsx';
import { fmtDuration } from '../format.js';

// Every road coloured by its response-time band: one multi-polyline per band (6 layers, not 10,000).
export function CoverageLayer({ geometry, bands }) {
  const groups = useMemo(() => {
    if (!geometry || !bands) return [];
    const g = COVERAGE_BANDS.map(() => []);
    for (let i = 0; i < geometry.lines.length; i++) g[Number(bands[i])]?.push(geometry.lines[i]);
    return g;
  }, [geometry, bands]);
  return groups.map((lines, b) => lines.length > 0 && (
    <Polyline key={`cov-${b}`} positions={lines} interactive={false}
      pathOptions={{ color: COVERAGE_BANDS[b].color, weight: b === 5 ? 1.5 : 2.5, opacity: b === 5 ? 0.5 : 0.75 }} />
  ));
}

export function PlacementMarkers({ placement }) {
  if (!placement || placement.computing) return null;
  const items = [['N', 'normal', placement.normal], ['F', `${placement.flood.level} m flood`, placement.flood]];
  return items.map(([letter, label, p]) => (
    <Marker key={letter} position={[p.suggestion.lat + (letter === 'F' && placement.sameSuggestion ? 0.0004 : 0), p.suggestion.lng]} zIndexOffset={1400} icon={divIcon(`station-suggest ${letter}`, letter, 26)}>
      <Popup>
        <b>Suggested new fire station ({label})</b><br />near {p.suggestion.near ?? 'an unnamed road'}<br />
        Worst-case fire response {fmtDuration(p.before.worstS)} → {fmtDuration(p.suggestion.worstS)}<br />
        Roads within 8 min {p.before.pct8}% → {p.suggestion.pct8}%
      </Popup>
    </Marker>
  ));
}

export function EvacuationLayer({ result }) {
  if (!result) return null;
  return result.bottlenecks.map((b) => (
    <Polyline key={`ev-${b.roadId}`} positions={b.geometry} pathOptions={{ color: '#e879f9', weight: 8, opacity: 0.95 }}>
      <Popup><b>{b.name}</b> · evacuation bottleneck (min cut)<br />Capacity {b.capacity} people/h ({b.highway}), fully used in the max flow.</Popup>
    </Polyline>
  ));
}
