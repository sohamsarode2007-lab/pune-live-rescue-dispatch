// One-click demo scenario "Monsoon flood — Mutha riverbank" (deterministic).
//
// Reset everything, free-flow traffic, 10x speed, Hungarian dispatch; the Mutha rises 0 -> 10 m in 2 m steps
// every 2 simulated minutes; 12 seeded SOS calls on BOTH banks of the river arrive over the first 11
// simulated minutes. The server advances simulated time in fixed steps, so the same scenario always
// produces the same sequence of floods, closures, assignments and reroutes.
import { mulberry32 } from '../../shared/sim/random.js';

export const SCENARIO_SEED = 20260712;

export function monsoonCalls(riverPoints, bbox, seed = SCENARIO_SEED, n = 12) {
  const r = mulberry32(seed);
  const pts = riverPoints.filter((p) => p.lat > bbox.south + 0.004 && p.lat < bbox.north - 0.004 && p.lng > bbox.west + 0.004 && p.lng < bbox.east - 0.004);
  const types = [['flood', 0.4], ['medical', 0.35], ['fire', 0.25]];
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < 1000) {
    const i = 1 + Math.floor(r() * (pts.length - 2));
    const a = pts[i - 1], b = pts[i + 1];
    // unit vector perpendicular to the river (in degrees, corrected for longitude scale)
    const k = Math.cos((pts[i].lat * Math.PI) / 180);
    let nx = -(b.lat - a.lat), ny = (b.lng - a.lng) * k;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    const side = out.length % 2 === 0 ? 1 : -1;                     // alternate banks
    const dist = (250 + r() * 650) / 111195;                         // 250-900 m from the river
    const lat = pts[i].lat + side * ny * dist, lng = pts[i].lng + side * (nx / k) * dist;
    if (lat < bbox.south || lat > bbox.north || lng < bbox.west || lng > bbox.east) continue;
    // keep calls >= 300 m apart so SOS clustering never merges two scenario calls
    if (out.some((c) => Math.hypot((c.lat - lat) * 111195, (c.lng - lng) * 111195 * k) < 300)) continue;
    const x = r();
    let acc = 0, type = 'fire';
    for (const [t, w] of types) { acc += w; if (x < acc) { type = t; break; } }
    out.push({
      atS: 30 + out.length * 55, bank: side > 0 ? 'left' : 'right',
      lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, type,
      severity: ['LOW', 'MEDIUM', 'HIGH'][Math.floor(r() * 3)], people: 1 + Math.floor(r() * 8),
    });
  }
  return out;
}

// crossings: NetworkService.crossingDefs (to resolve the scripted bridge closure to road ids).
// Scripted closure: at 300 s the police close New Sangam Bridge as the Mula-Mutha rises. In this seeded
// run fire truck FT-2 is then driving to INC-005 over that bridge, so the demo always shows a reroute.
export const SCRIPTED_CLOSURES = Object.freeze([{ atS: 300, crossing: 'New Sangam Bridge', reason: 'Police close New Sangam Bridge as the Mula-Mutha rises' }]);

export function monsoonScenario(riverPoints, bbox, crossings = []) {
  return {
    id: 'monsoon', name: 'Monsoon flood — Mutha riverbank', speed: 10, trafficMode: 'free-flow', dispatchMode: 'hungarian',
    levels: [0, 2, 4, 6, 8, 10].map((level, i) => ({ atS: i * 120, level })).slice(1),
    calls: monsoonCalls(riverPoints, bbox),
    closures: SCRIPTED_CLOSURES.map((c) => ({ ...c, roadIds: crossings.find((x) => x.name === c.crossing)?.roadIds ?? [] })).filter((c) => c.roadIds.length),
  };
}

// Executes due scenario steps at their exact simulated time (levels) or at the first tick after it (calls).
export class ScenarioRunner {
  constructor() { this.active = null; }

  start(def, nowS = 0) {
    this.active = { def, startS: nowS, levelIdx: 0, callIdx: 0, closureIdx: 0, incidents: [], events: [] };
    return this.status();
  }

  stop() { this.active = null; }

  // actions: { setLevel(level, atS), sos(call) -> incident, closeRoads(roadIds, reason) }
  tick(nowS, actions) {
    const a = this.active;
    if (!a) return false;
    let changed = false;
    const closures = a.def.closures ?? [];
    while (a.closureIdx < closures.length && a.startS + closures[a.closureIdx].atS <= nowS) {
      const c = closures[a.closureIdx++];
      actions.closeRoads(c.roadIds, c.reason);
      a.events.push({ atS: nowS, text: c.reason });
      changed = true;
    }
    while (a.levelIdx < a.def.levels.length && a.startS + a.def.levels[a.levelIdx].atS <= nowS) {
      const s = a.def.levels[a.levelIdx++];
      actions.setLevel(s.level, a.startS + s.atS);
      changed = true;
    }
    while (a.callIdx < a.def.calls.length && a.startS + a.def.calls[a.callIdx].atS <= nowS) {
      const inc = actions.sos(a.def.calls[a.callIdx++]);
      if (inc) a.incidents.push(inc.id);
      changed = true;
    }
    return changed;
  }

  status() {
    const a = this.active;
    if (!a) return { running: false };
    const nextLevel = a.def.levels[a.levelIdx], nextCall = a.def.calls[a.callIdx];
    return {
      running: a.levelIdx < a.def.levels.length || a.callIdx < a.def.calls.length,
      id: a.def.id, name: a.def.name, startS: a.startS,
      levelStep: a.levelIdx, levelSteps: a.def.levels.length, nextLevel: nextLevel ? { ...nextLevel, atS: a.startS + nextLevel.atS } : null,
      callsSent: a.callIdx, calls: a.def.calls.length, incidents: a.incidents, events: a.events,
    };
  }
}

// One simulation step, shared by the server loop and the determinism test: advance the sim clock by a
// FIXED amount, run due scenario steps, apply the flood, reroute units. Returns what changed.
export function simStep({ dispatch, flood, runner }, tickMs) {
  dispatch.tick(tickMs);
  const scripted = [];
  const scenarioChanged = runner?.tick(dispatch.now, {
    setLevel: (level, atS) => flood.setLevel(level, atS, 'scenario'),
    sos: (call) => dispatch.submitCall({ ...call, source: 'scenario' }).incident,
    closeRoads: (roadIds) => {
      for (const id of roadIds) { dispatch.store.setRoadStatus(id, 'BLOCKED', 'scenario'); flood.forget(id); }
      scripted.push(...roadIds);
    },
  }) ?? false;
  if (scripted.length) dispatch.roadsBlocked(scripted);
  const changes = flood.tick(dispatch.now);
  if (changes.blocked.length) dispatch.roadsBlocked(changes.blocked);
  return {
    changes, scenarioChanged,
    roadsChanged: scripted.length + changes.blocked.length + changes.highRisk.length + changes.reopened.length > 0,
  };
}
