// SOS clustering: several calls about the same emergency become ONE incident.
// A new call merges into an open incident when it is
//   - the same type (a flood call never merges into a fire incident: they need different units),
//   - within RADIUS_M of the incident's first call (haversine), and
//   - within WINDOW_S of the incident's first call (simulated seconds).
// Candidates come from a geohash index (precision 7, ~145 x 153 m cells): only the call's cell and its 8
// neighbours are checked, which is enough because every cell is larger than the 100 m radius.
import { GeohashIndex } from '../spatial/geohash.js';
import { haversineM } from '../spatial/haversine.js';

export const CLUSTER_RADIUS_M = 100;
export const CLUSTER_WINDOW_S = 300;

export class SosClusterer {
  constructor({ precision = 7, radiusM = CLUSTER_RADIUS_M, windowS = CLUSTER_WINDOW_S } = {}) {
    this.index = new GeohashIndex(precision);
    this.open = new Map();    // id -> { id, lat, lng, type, createdS }
    this.radiusM = radiusM;
    this.windowS = windowS;
  }

  add({ id, lat, lng, type, createdS }) {
    this.open.set(id, { id, lat, lng, type, createdS });
    return this.index.add(id, lat, lng);
  }

  remove(id) { this.open.delete(id); this.index.remove(id); }

  // Nearest matching open incident for a call { lat, lng, type } at time nowS, or null.
  findMatch({ lat, lng, type }, nowS) {
    const { cell, ids } = this.index.query(lat, lng);
    let best = null;
    for (const id of ids) {
      const inc = this.open.get(id);
      if (inc.type !== type || nowS - inc.createdS > this.windowS) continue;
      const d = haversineM(lat, lng, inc.lat, inc.lng);
      if (d <= this.radiusM && (!best || d < best.distanceM)) best = { id, distanceM: d };
    }
    return best ? { ...best, cell, checked: ids.length } : null;
  }
}
