import React, { useMemo, useState } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, Polyline, Marker, Popup, Rectangle, useMapEvents } from 'react-leaflet';

// Basemap: standard OpenStreetMap raster tiles (no key, no account). The dark "command-centre" look
// is a CSS filter on the tile pane (styles.css: .dark-tiles). CARTO's dark basemap was the original
// plan, but it now answers keyless requests with "API KEY REQUIRED" placeholder tiles.
// The "© OpenStreetMap contributors" attribution is always visible on the map.
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const TILES = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM_ATTR };

const KIND_STYLE = {
  hospital: { cls: 'hospital', label: 'H' },
  fire_station: { cls: 'fire', label: 'F' },
  police: { cls: 'police', label: 'P' },
};

const iconCache = new Map();
function divIcon(cls, label, size = 22) {
  const key = `${cls}|${label}|${size}`;
  if (!iconCache.has(key)) {
    iconCache.set(key, L.divIcon({
      className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2],
      html: `<div class="pin ${cls}" style="width:${size}px;height:${size}px">${label}</div>`,
    }));
  }
  return iconCache.get(key);
}

const UNIT_LABEL = { ambulance: 'ambulance', fire_truck: 'fire truck', rescue_boat: 'rescue boat' };
function fleetText(units) {
  const counts = {};
  units.forEach((u) => { counts[u.type] = (counts[u.type] ?? 0) + 1; });
  return Object.entries(counts).map(([t, n]) => `${n} ${UNIT_LABEL[t]}${n > 1 ? 's' : ''}`).join(', ');
}

function ClickHandler({ onClick }) {
  useMapEvents({ click: (e) => onClick({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

export default function RescueMap({
  bbox, facilities, units, layers, origin, destination, route, closedRoads, onMapClick, onReopenRoad, onPickOrigin,
}) {
  const [dark, setDark] = useState(true);
  const [tileErrors, setTileErrors] = useState(0);

  const unitsByStation = useMemo(() => {
    const m = new Map();
    units.forEach((u) => m.set(u.stationId, [...(m.get(u.stationId) ?? []), u]));
    return m;
  }, [units]);

  const bounds = [[bbox.south, bbox.west], [bbox.north, bbox.east]];

  return (
    <div className={`map-shell ${dark ? 'dark-tiles' : ''}`}>
      <MapContainer bounds={bounds} className="map" preferCanvas zoomControl zoomSnap={0.25} zoomDelta={0.5}>
        <TileLayer
          url={TILES.url}
          attribution={TILES.attribution}
          maxZoom={19}
          eventHandlers={{ tileerror: () => setTileErrors((n) => n + 1), tileload: () => setTileErrors(0) }}
        />
        <ClickHandler onClick={onMapClick} />

        <Rectangle bounds={bounds} pathOptions={{ color: '#64748b', weight: 1, dashArray: '4 6', fill: false }} interactive={false} />

        {closedRoads.map((r) => (
          <Polyline key={r.id} positions={r.geometry}
            pathOptions={{ color: r.status === 'BLOCKED' ? '#ef4444' : '#f59e0b', weight: 6, dashArray: r.status === 'BLOCKED' ? '2 8' : undefined, lineCap: 'round' }}>
            <Popup>
              <b>{r.name || 'Unnamed road'}</b> ({r.id})<br />
              {r.status} · {Math.round(r.lengthM)} m
              <br /><button type="button" onClick={() => onReopenRoad(r.id)}>Reopen road</button>
            </Popup>
          </Polyline>
        ))}

        {route?.geometry?.length > 1 && (
          <>
            <Polyline positions={route.geometry} pathOptions={{ color: '#0e7490', weight: 9, opacity: 0.45 }} interactive={false} />
            <Polyline positions={route.geometry} pathOptions={{ color: '#22d3ee', weight: 4 }} interactive={false} />
          </>
        )}

        {facilities.filter((f) => layers[f.kind]).map((f) => {
          const st = KIND_STYLE[f.kind];
          const fleet = unitsByStation.get(f.id) ?? [];
          return (
            <Marker key={f.id} position={[f.lat, f.lng]}
              icon={fleet.length ? divIcon(`${st.cls} has-units`, st.label, 22) : divIcon(`${st.cls} small`, '', 10)}>
              <Popup>
                <b>{f.name}</b><br />
                <span className="muted">{f.id} · {f.kind.replace('_', ' ')} · OSM {f.osm}</span>
                {f.kind === 'hospital' && <><br />Beds free: <b>{f.bedsFree}</b> <i>(simulated)</i></>}
                {fleet.length > 0 && (
                  <>
                    <br />Fleet: {fleetText(fleet)} <i>(simulated)</i>
                    <br /><button type="button" onClick={() => onPickOrigin(f.id)}>Dispatch from here</button>
                  </>
                )}
              </Popup>
            </Marker>
          );
        })}

        {origin && <Marker position={[origin.lat, origin.lng]} icon={divIcon('origin', '▲', 26)} zIndexOffset={1000} />}
        {destination && <Marker position={[destination.lat, destination.lng]} icon={divIcon('incident', '!', 28)} zIndexOffset={1000} />}
      </MapContainer>
      <button type="button" className="map-toggle" onClick={() => setDark(!dark)}>{dark ? 'Light map' : 'Dark map'}</button>
      {tileErrors >= 4 && <div className="map-note">Map tiles unavailable (offline?). Routing still works.</div>}
    </div>
  );
}
