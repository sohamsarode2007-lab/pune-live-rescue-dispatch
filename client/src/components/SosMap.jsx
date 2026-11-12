import React, { useEffect } from 'react';
import { MapContainer, Marker, Polyline, Circle, useMap } from 'react-leaflet';
import { AreaBox, BaseTiles, ClickHandler, MapFrame, divIcon, UNIT_LETTER } from './mapParts.jsx';

// Re-fits only when `fitKey` changes (location found, unit assigned, status change), not on every
// position update, so the user's own zoom/pan is not fought.
function FitTo({ points, fitKey }) {
  const map = useMap();
  const key = fitKey;
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], Math.max(map.getZoom(), 15));
    else if (points.length > 1) map.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Phone map: the caller's location, the assigned unit and its route. Tap-to-pick when GPS fails.
export default function SosMap({ bbox, me, accuracyM, unit, picking, onPick }) {
  const bounds = [[bbox.south, bbox.west], [bbox.north, bbox.east]];
  const fit = [];
  if (me) fit.push([me.lat, me.lng]);
  if (unit) fit.push([unit.lat, unit.lng]);
  return (
    <MapFrame className={`sos-map ${picking ? 'crosshair' : ''}`}>
      {(setTileErrors) => (
        <MapContainer bounds={bounds} className="map" zoomSnap={0.5} tap>
          <BaseTiles onErrorsChange={setTileErrors} />
          <AreaBox bbox={bbox} />
          {picking && <ClickHandler onClick={onPick} />}
          {me && accuracyM > 0 && <Circle center={[me.lat, me.lng]} radius={accuracyM} pathOptions={{ color: '#22d3ee', weight: 1, fillOpacity: 0.1 }} />}
          {unit?.route?.length > 1 && <Polyline positions={unit.route} pathOptions={{ color: '#fbbf24', weight: 5 }} />}
          {me && <Marker position={[me.lat, me.lng]} icon={divIcon('incident', '!', 28)} />}
          {unit && <Marker position={[unit.lat, unit.lng]} icon={divIcon(`unit ${unit.status} sel`, UNIT_LETTER[unit.type], 24)} zIndexOffset={1000} />}
          {!picking && fit.length > 0 && <FitTo points={fit} fitKey={`${me ? `${me.lat},${me.lng}` : ''}|${unit?.id ?? ''}|${unit?.status ?? ''}`} />}
        </MapContainer>
      )}
    </MapFrame>
  );
}
