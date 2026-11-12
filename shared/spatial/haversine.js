// Great-circle distance on a sphere (haversine formula). O(1).
export const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

export function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLng = (lng2 - lng1) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Length of a polyline [[lat,lng],...] in metres.
export function polylineLengthM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  return total;
}
