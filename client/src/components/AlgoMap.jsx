import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, useMap } from 'react-leaflet';
import { AreaBox, BaseTiles, ClickHandler, MapFrame, divIcon } from './mapParts.jsx';

// Colour for a value t in [0, 1]: blue (first) -> green -> yellow -> red (last).
export const rampColor = (t) => `hsl(${Math.round(220 - 220 * Math.min(1, Math.max(0, t)))}, 90%, 55%)`;

// Draws the first `shown` visited junctions (dots) and their search-tree edges directly on a canvas
// renderer. Imperative Leaflet layers: thousands of React markers would be far too slow to animate.
function TraversalLayer({ result, shown, colorBy }) {
  const map = useMap();
  const state = useRef({ group: null, drawn: 0, key: null });
  const renderer = useRef(L.canvas({ padding: 0.3 }));

  useEffect(() => {
    const s = state.current;
    const key = result ? `${result.algorithm}|${result.start.nodeId}|${result.reached}|${colorBy}` : null;
    if (key !== s.key || shown < s.drawn) {         // new run (or rewind): start from scratch
      s.group?.remove();
      s.group = result ? L.layerGroup().addTo(map) : null;
      s.drawn = 0; s.key = key;
    }
    if (!result || shown <= s.drawn) return;
    const { order, maxDepth } = result;
    const n = order.length;
    const tOf = (i) => (colorBy === 'depth' ? order[i][2] / Math.max(1, maxDepth) : i / Math.max(1, n - 1));
    // edges + dots for the newly revealed range, in a few colour bands to keep the layer count small
    const BAND = Math.max(1, Math.ceil((shown - s.drawn) / 8));
    for (let b = s.drawn; b < shown; b += BAND) {
      const end = Math.min(shown, b + BAND);
      const segs = [];
      for (let i = Math.max(1, b); i < end; i++) {
        const p = order[order[i][3]];
        if (p) segs.push([[p[0], p[1]], [order[i][0], order[i][1]]]);
      }
      const color = rampColor(tOf(Math.floor((b + end) / 2)));
      if (segs.length) L.polyline(segs, { renderer: renderer.current, color, weight: 1.5, opacity: 0.8, interactive: false }).addTo(s.group);
      for (let i = b; i < end; i++) {
        L.circleMarker([order[i][0], order[i][1]], {
          renderer: renderer.current, radius: 2.6, stroke: false, fillColor: rampColor(tOf(i)), fillOpacity: 0.95, interactive: false,
        }).addTo(s.group);
      }
    }
    s.drawn = shown;
  }, [map, result, shown, colorBy]);

  useEffect(() => () => state.current.group?.remove(), []);
  return null;
}

export default function AlgoMap({ bbox, result, shown, colorBy, onPick, start }) {
  const bounds = [[bbox.south, bbox.west], [bbox.north, bbox.east]];
  return (
    <MapFrame className="crosshair">
      {(setTileErrors) => (
        <MapContainer bounds={bounds} className="map" zoomSnap={0.25} zoomDelta={0.5}>
          <BaseTiles onErrorsChange={setTileErrors} />
          <AreaBox bbox={bbox} />
          <ClickHandler onClick={onPick} />
          <TraversalLayer result={result} shown={shown} colorBy={colorBy} />
          {start && <Marker position={[start.lat, start.lng]} icon={divIcon('origin', '★', 24)} zIndexOffset={1000} />}
        </MapContainer>
      )}
    </MapFrame>
  );
}
