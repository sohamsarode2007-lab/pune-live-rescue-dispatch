import React, { useMemo } from 'react';
import { MapContainer, Polyline, Marker, Popup } from 'react-leaflet';
import { AreaBox, BaseTiles, ClickHandler, MapFrame, divIcon, UNIT_LABEL, UNIT_LETTER, TYPE_ICON } from './mapParts.jsx';
import { trafficColor } from './TrafficPanel.jsx';
import NetworkLayer from './NetworkLayer.jsx';

const KIND_STYLE = {
  hospital: { cls: 'hospital', label: 'H' },
  fire_station: { cls: 'fire', label: 'F' },
  police: { cls: 'police', label: 'P' },
};

function fleetText(units) {
  const counts = {};
  units.forEach((u) => { counts[u.type] = (counts[u.type] ?? 0) + 1; });
  return Object.entries(counts).map(([t, n]) => `${n} ${UNIT_LABEL[t]}${n > 1 ? 's' : ''}`).join(', ');
}

// Dispatcher map: facilities, closures, planner route, live incidents and units.
export default function RescueMap({
  bbox, facilities, fleet, layers, origin, destination, route, closedRoads, onMapClick, onReopenRoad, onPickOrigin,
  incidents = [], liveUnits = [], showIdle = false, selectedIncidentId = null, onSelectIncident, beds = {}, cursor = '',
  trafficRoads = [], compare = null, network = null,
}) {
  const fleetByStation = useMemo(() => {
    const m = new Map();
    fleet.forEach((u) => m.set(u.stationId, [...(m.get(u.stationId) ?? []), u]));
    return m;
  }, [fleet]);
  const bounds = [[bbox.south, bbox.west], [bbox.north, bbox.east]];
  const selectedUnitId = incidents.find((i) => i.id === selectedIncidentId)?.unitId;

  return (
    <MapFrame className={cursor}>
      {(setTileErrors) => (
        <MapContainer bounds={bounds} className="map" preferCanvas zoomControl zoomSnap={0.25} zoomDelta={0.5}>
          <BaseTiles onErrorsChange={setTileErrors} />
          <ClickHandler onClick={onMapClick} />
          <AreaBox bbox={bbox} />

          {closedRoads.map((r) => (
            <Polyline key={r.id} positions={r.geometry}
              pathOptions={{ color: r.status === 'BLOCKED' ? '#ef4444' : '#f59e0b', weight: 6, dashArray: r.status === 'BLOCKED' ? '2 8' : undefined, lineCap: 'round' }}>
              <Popup>
                <b>{r.name || 'Unnamed road'}</b> ({r.id})<br />{r.status} · {Math.round(r.lengthM)} m
                <br /><button type="button" onClick={() => onReopenRoad(r.id)}>Reopen road</button>
              </Popup>
            </Polyline>
          ))}

          {network && <NetworkLayer {...network} />}

          {trafficRoads.map((r) => (
            <Polyline key={`t-${r.id}`} positions={r.geometry} pathOptions={{ color: trafficColor(r.factor), weight: 5, opacity: 0.85 }}>
              <Popup><b>{r.name || 'Unnamed road'}</b><br />Traffic factor {r.factor}× · {r.currentSpeed} km/h now, {r.freeFlowSpeed} km/h free-flow<br /><span className="muted">TomTom sample {r.sampleId}</span></Popup>
            </Polyline>
          ))}

          {compare?.osrm?.available && compare.osrm.geometry.length > 1 && (
            <Polyline positions={compare.osrm.geometry} pathOptions={{ color: '#c084fc', weight: 5, opacity: 0.9, dashArray: '8 8' }}>
              <Popup>OSRM route (normal traffic, external baseline)</Popup>
            </Polyline>
          )}
          {compare?.ours?.geometry?.length > 1 && (
            <Polyline positions={compare.ours.geometry} pathOptions={{ color: '#22d3ee', weight: 4, opacity: 0.95 }}>
              <Popup>Our route ({compare.ours.trafficMode === 'live' ? 'live traffic' : 'free-flow'})</Popup>
            </Polyline>
          )}

          {route?.geometry?.length > 1 && (
            <>
              <Polyline positions={route.geometry} pathOptions={{ color: '#0e7490', weight: 9, opacity: 0.45 }} interactive={false} />
              <Polyline positions={route.geometry} pathOptions={{ color: '#22d3ee', weight: 4 }} interactive={false} />
            </>
          )}

          {liveUnits.filter((u) => u.route?.length > 1).map((u) => (
            <Polyline key={`r-${u.id}`} positions={u.route} interactive={false}
              pathOptions={u.id === selectedUnitId
                ? { color: '#fbbf24', weight: 5, opacity: 0.95 }
                : { color: u.status === 'RETURNING' ? '#60a5fa' : '#f472b6', weight: 2.5, opacity: 0.7, dashArray: u.status === 'RETURNING' ? '4 6' : undefined }} />
          ))}

          {facilities.filter((f) => layers[f.kind]).map((f) => {
            const st = KIND_STYLE[f.kind];
            const units = fleetByStation.get(f.id) ?? [];
            const big = units.length > 0 || f.major;
            return (
              <Marker key={f.id} position={[f.lat, f.lng]}
                icon={big ? divIcon(`${st.cls} has-units${f.major ? ' major' : ''}`, st.label, f.major ? 24 : 22) : divIcon(`${st.cls} small`, '', 10)}>
                <Popup>
                  <b>{f.name}</b>{f.major && <span className="tag-major">major</span>}<br />
                  <span className="muted">{f.id} · {f.kind.replace('_', ' ')} · OSM {f.osm}</span>
                  {f.kind === 'hospital' && <><br />Beds free: <b>{beds[f.id] ?? f.bedsFree}</b> <i>(simulated)</i></>}
                  {f.majorReasons && <><br /><span className="muted">Major because: {f.majorReasons.join(', ')}</span></>}
                  {units.length > 0 && (
                    <>
                      <br />Fleet: {fleetText(units)} <i>(simulated)</i>
                      {onPickOrigin && <><br /><button type="button" onClick={() => onPickOrigin(f.id)}>Plan route from here</button></>}
                    </>
                  )}
                </Popup>
              </Marker>
            );
          })}

          {incidents.map((inc) => (
            <Marker key={inc.id} position={[inc.lat, inc.lng]} zIndexOffset={900}
              icon={divIcon(`inc ${inc.status}${inc.id === selectedIncidentId ? ' sel' : ''}`, TYPE_ICON[inc.type], inc.status === 'RESOLVED' ? 16 : 24)}
              eventHandlers={{ click: () => onSelectIncident?.(inc.id) }}>
              <Popup>
                <b>{inc.id}</b> · {inc.type} · {inc.severity} · {inc.people} people<br />
                {inc.status}{inc.unitId ? ` · ${inc.unitId}` : ''}{inc.source === 'dispatcher' ? ' · test SOS' : ''}
              </Popup>
            </Marker>
          ))}

          {liveUnits.filter((u) => showIdle || u.status !== 'AVAILABLE').map((u) => (
            <Marker key={u.id} position={[u.lat, u.lng]} zIndexOffset={1100}
              icon={divIcon(`unit ${u.status}${u.id === selectedUnitId ? ' sel' : ''}`, UNIT_LETTER[u.type], 20)}>
              <Popup><b>{u.id}</b> · {UNIT_LABEL[u.type]} (simulated)<br />{u.status}{u.incidentId ? ` → ${u.incidentId}` : ''}</Popup>
            </Marker>
          ))}

          {origin && <Marker position={[origin.lat, origin.lng]} icon={divIcon('origin', '▲', 26)} zIndexOffset={1000} />}
          {destination && <Marker position={[destination.lat, destination.lng]} icon={divIcon('incident', '!', 28)} zIndexOffset={1000} />}
        </MapContainer>
      )}
    </MapFrame>
  );
}
