import React, { useState } from 'react';
import L from 'leaflet';
import { TileLayer, Rectangle, useMapEvents } from 'react-leaflet';

// Standard OpenStreetMap raster tiles (no key, no account). The dark "command-centre" look is a CSS
// filter on the tile pane (.dark-tiles). CARTO's dark basemap now needs an API key, so it is not used.
// The "© OpenStreetMap contributors" attribution is always visible.
export const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
export const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export function BaseTiles({ onErrorsChange }) {
  return (
    <TileLayer url={OSM_URL} attribution={OSM_ATTR} maxZoom={19}
      eventHandlers={{ tileerror: () => onErrorsChange?.((n) => n + 1), tileload: () => onErrorsChange?.(0) }} />
  );
}

export function AreaBox({ bbox }) {
  return (
    <Rectangle bounds={[[bbox.south, bbox.west], [bbox.north, bbox.east]]}
      pathOptions={{ color: '#64748b', weight: 1, dashArray: '4 6', fill: false }} interactive={false} />
  );
}

export function ClickHandler({ onClick }) {
  useMapEvents({ click: (e) => onClick?.({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

const iconCache = new Map();
export function divIcon(cls, label, size = 22) {
  const key = `${cls}|${label}|${size}`;
  if (!iconCache.has(key)) {
    iconCache.set(key, L.divIcon({
      className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2],
      html: `<div class="pin ${cls}" style="width:${size}px;height:${size}px">${label}</div>`,
    }));
  }
  return iconCache.get(key);
}

// Wrapper giving every map the dark/light toggle and an offline note.
export function MapFrame({ children, className = '' }) {
  const [dark, setDark] = useState(true);
  const [tileErrors, setTileErrors] = useState(0);
  return (
    <div className={`map-shell ${dark ? 'dark-tiles' : ''} ${className}`}>
      {children(setTileErrors)}
      <button type="button" className="map-toggle" onClick={() => setDark(!dark)}>{dark ? 'Light map' : 'Dark map'}</button>
      {tileErrors >= 4 && <div className="map-note">Map tiles unavailable (offline?). Routing still works.</div>}
    </div>
  );
}

export const UNIT_LETTER = { ambulance: 'A', fire_truck: 'F', rescue_boat: 'B' };
export const UNIT_LABEL = { ambulance: 'ambulance', fire_truck: 'fire truck', rescue_boat: 'rescue boat' };
export const TYPE_ICON = { medical: '✚', fire: '🔥', flood: '≈' };
