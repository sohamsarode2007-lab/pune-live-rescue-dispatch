import { useEffect, useReducer } from 'react';
import { getSocket } from './socket.js';

// Keeps the part of a drawn route still ahead of the vehicle: drops points up to the one closest to
// the current position (searching only the first few points, since the vehicle moves forward).
export function trimRoute(route, p) {
  if (!route || route.length < 2) return route;
  let best = 0, bestD = Infinity;
  const n = Math.min(route.length - 1, 60);
  for (let i = 0; i <= n; i++) {
    const d = (route[i][0] - p.lat) ** 2 + (route[i][1] - p.lng) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return [[p.lat, p.lng], ...route.slice(best + 1)];
}

const initial = {
  connected: false, simTimeS: 0, speed: 1,
  units: new Map(), incidents: new Map(), queue: [], beds: {}, closedRoads: [],
  mode: 'hungarian', comparisons: [], comparisonTotals: null,
};

function reducer(state, a) {
  switch (a.type) {
    case 'connected': return { ...state, connected: a.value };
    case 'init': return {
      ...state, simTimeS: a.s.simTimeS, speed: a.s.speed, queue: a.s.queue,
      units: new Map(a.s.units.map((u) => [u.id, u])),
      incidents: new Map(a.s.incidents.map((i) => [i.id, i])),
      beds: Object.fromEntries(a.s.hospitals.map((h) => [h.id, h.bedsFree])),
      mode: a.s.mode, comparisons: a.s.comparisons ?? [], comparisonTotals: a.s.comparisonTotals ?? null,
    };
    case 'comparison': return { ...state, comparisons: [...state.comparisons, a.c.latest].slice(-20), comparisonTotals: a.c.totals };
    case 'mode': return { ...state, mode: a.mode };
    case 'unit': { const units = new Map(state.units); units.set(a.u.id, { ...units.get(a.u.id), ...a.u }); return { ...state, units }; }
    case 'incident': { const incidents = new Map(state.incidents); incidents.set(a.i.id, a.i); return { ...state, incidents }; }
    case 'positions': {
      const units = new Map(state.units);
      for (const p of a.p.units) {
        const u = units.get(p.id);
        if (!u) continue;
        // trim the drawn route: drop points already passed (keep the live position as the first point)
        units.set(p.id, { ...u, lat: p.lat, lng: p.lng, remainingS: p.remainingS, route: trimRoute(u.route, p) });
      }
      return { ...state, units, simTimeS: a.p.simTimeS, speed: a.p.speed };
    }
    case 'queue': return { ...state, queue: a.q };
    case 'hospital': return { ...state, beds: { ...state.beds, [a.h.id]: a.h.bedsFree } };
    case 'hazard': return { ...state, closedRoads: a.roads };
    case 'speed': return { ...state, speed: a.speed };
    default: return state;
  }
}

// Subscribes the dispatcher dashboard to every live event from the server.
export function useLiveDispatch() {
  const [state, dispatch] = useReducer(reducer, initial);
  useEffect(() => {
    const s = getSocket();
    const join = () => { dispatch({ type: 'connected', value: true }); s.emit('dispatch:join'); };
    const handlers = {
      connect: join,
      disconnect: () => dispatch({ type: 'connected', value: false }),
      'state:init': (snap) => dispatch({ type: 'init', s: snap }),
      'unit:updated': (u) => dispatch({ type: 'unit', u }),
      'incident:updated': (i) => dispatch({ type: 'incident', i }),
      'unit:position': (p) => dispatch({ type: 'positions', p }),
      'queue:updated': (q) => dispatch({ type: 'queue', q }),
      'hospital:updated': (h) => dispatch({ type: 'hospital', h }),
      'hazard:updated': (roads) => dispatch({ type: 'hazard', roads }),
      'sim:speed': ({ speed }) => dispatch({ type: 'speed', speed }),
      'comparison:updated': (c) => dispatch({ type: 'comparison', c }),
      'dispatch:mode': ({ mode }) => dispatch({ type: 'mode', mode }),
    };
    Object.entries(handlers).forEach(([e, h]) => s.on(e, h));
    if (s.connected) join();
    return () => Object.entries(handlers).forEach(([e, h]) => s.off(e, h));
  }, []);
  return state;
}
