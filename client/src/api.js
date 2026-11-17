import { dispatcherToken } from './auth.js';

async function call(url, options = {}) {
  const token = dispatcherToken();
  if (token && options.method && options.method !== 'GET') options = { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } };
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

const post = (url, data) => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });

export const api = {
  summary: () => call('/api/summary'),
  facilities: () => call('/api/facilities'),
  route: (from, to) => call(`/api/route?fromLat=${from.lat}&fromLng=${from.lng}&toLat=${to.lat}&toLng=${to.lng}&algo=astar,dijkstra`),
  closedRoads: () => call('/api/roads/closed'),
  traffic: () => call('/api/traffic'),
  burstBenchmark: () => call('/api/burst-benchmark'),
  spof: () => call('/api/network/spof'),
  scc: () => call('/api/network/scc'),
  crossings: () => call('/api/network/crossings'),
  rivers: () => call('/api/rivers'),
  flood: () => call('/api/flood'),
  coverage: (kind) => call(`/api/coverage?kind=${kind}`),
  roadGeometry: () => call('/api/geometry/roads'),
  placement: () => call('/api/placement'),
  evacuation: () => call('/api/evacuation'),
  setCrossingStatus: (id, status) => post(`/api/crossings/${encodeURIComponent(id)}/status`, { status }),
  setRoadStatus: (id, status) => post(`/api/roads/${encodeURIComponent(id)}/status`, { status }),
  resetRoads: () => post('/api/roads/reset'),
};
