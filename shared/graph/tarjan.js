// Tarjan's algorithms, written ITERATIVELY (an explicit stack instead of recursion: a recursive DFS
// would overflow the call stack on 7,695 junctions).
//
// 1. bridgesAndArticulationPoints(graph): on the UNDIRECTED version of the road graph (a one-way street
//    still physically joins its two junctions). One DFS assigns disc[v] (discovery time) and
//    low[v] = the smallest disc reachable from v's DFS subtree using at most one non-tree edge.
//      - tree edge p-c is a BRIDGE            iff low[c] >  disc[p]
//      - p (not the root) is an ARTICULATION  iff some child c has low[c] >= disc[p]
//      - the DFS root is an articulation      iff it has >= 2 tree children
//    Parallel roads between the same two junctions are handled by skipping only the EDGE we came in
//    on (not every edge back to the parent), so a doubled road is never a bridge.
//    The same pass accumulates subtree sizes and facility counts, so for every bridge / articulation
//    point we know what its loss cuts off. O(V + E).
//
// 2. stronglyConnectedComponents(graph): on the DIRECTED graph (one-way streets, BLOCKED roads removed).
//    u and v are in the same SCC iff each can reach the other. low-link values + a stack of open vertices;
//    a vertex with low == index closes a component. O(V + E). With the condensation (one node per SCC)
//    we find "trap zones": parts that can be entered but not left, or left but not entered.
import { ROAD_STATUS } from './Graph.js';

export const FACILITY_KINDS = Object.freeze(['hospital', 'fire_station', 'police', 'shelter']);

// Undirected adjacency over traversable roads (index-based for speed). excludeRoadIds: Set, optional.
function undirected(graph, { includeBlocked = false, excludeRoadIds = null } = {}) {
  const ids = [...graph.locations.keys()];
  const index = new Map(ids.map((id, i) => [id, i]));
  const adj = ids.map(() => []);
  for (const r of graph.roads.values()) {
    if (!includeBlocked && r.status === ROAD_STATUS.BLOCKED) continue;
    if (excludeRoadIds?.has(r.id)) continue;
    const a = index.get(r.from), b = index.get(r.to);
    if (a === b) continue;
    adj[a].push([b, r.id]);
    adj[b].push([a, r.id]);
  }
  return { ids, index, adj };
}

const zero = () => Object.fromEntries(FACILITY_KINDS.map((k) => [k, 0]));
const add = (a, b, sign = 1) => { for (const k of FACILITY_KINDS) a[k] += sign * b[k]; return a; };
const sub = (a, b) => add({ ...a }, b, -1);
const total = (f) => FACILITY_KINDS.reduce((s, k) => s + f[k], 0);

// What losing a piece means: junction count, facilities inside it, and facility kinds it no longer
// reaches (the piece has none of that kind but the rest of its component has some).
function describe(cutJunctions, cutFac, compFac) {
  const losesAccessTo = FACILITY_KINDS.filter((k) => cutFac[k] === 0 && compFac[k] > 0);
  return { cutJunctions, facilitiesCutOff: cutFac, facilitiesCutOffTotal: total(cutFac), losesAccessTo };
}

// facilityNodes: Map(nodeId -> { hospital: n, fire_station: n, ... }) (optional).
export function bridgesAndArticulationPoints(graph, { facilityNodes = new Map(), criticalJunctions = 50, ...opts } = {}) {
  const { ids, adj } = undirected(graph, opts);
  const n = ids.length;
  const disc = new Int32Array(n).fill(-1), low = new Int32Array(n);
  const parent = new Int32Array(n).fill(-1), parentEdge = new Array(n).fill(null);
  const iter = new Int32Array(n), size = new Int32Array(n);
  const fac = ids.map((id) => ({ ...zero(), ...(facilityNodes.get(id) ?? {}) }));
  const ownFac = fac.map((f) => ({ ...f }));
  const comp = new Int32Array(n).fill(-1);
  const compSize = [], compFac = [];
  const bridgeChild = [];                      // child vertex index of each bridge tree edge
  const apChildren = new Map();                // articulation vertex -> separated child vertices
  const treeChildren = new Map();              // root -> its tree children (root articulation check)
  let timer = 0, maxStack = 0;

  for (let root = 0; root < n; root++) {
    if (disc[root] !== -1) continue;
    const c = compSize.length;
    const members = [];
    disc[root] = low[root] = timer++;
    const stack = [root];
    treeChildren.set(root, []);
    while (stack.length) {
      maxStack = Math.max(maxStack, stack.length);
      const v = stack[stack.length - 1];
      if (iter[v] < adj[v].length) {
        const [w, e] = adj[v][iter[v]++];
        if (e === parentEdge[v]) continue;                     // the edge we arrived by (not its parallel twins)
        if (disc[w] === -1) {
          parent[w] = v; parentEdge[w] = e;
          disc[w] = low[w] = timer++;
          if (v === root) treeChildren.get(root).push(w);
          stack.push(w);
        } else if (disc[w] < low[v]) low[v] = disc[w];          // back edge
        continue;
      }
      stack.pop();                                               // v finished: its subtree is complete
      size[v] += 1;
      members.push(v);
      const p = parent[v];
      if (p !== -1) {
        if (low[v] < low[p]) low[p] = low[v];
        size[p] += size[v];
        add(fac[p], fac[v]);
        if (low[v] > disc[p]) bridgeChild.push(v);
        if (low[v] >= disc[p] && p !== root) {
          if (!apChildren.has(p)) apChildren.set(p, []);
          apChildren.get(p).push(v);
        }
      }
    }
    if (treeChildren.get(root).length >= 2) apChildren.set(root, [...treeChildren.get(root)]);
    for (const v of members) comp[v] = c;
    compSize.push(size[root]);
    compFac.push({ ...fac[root] });
  }

  const bridges = bridgeChild.map((v) => {
    const c = comp[v], inside = size[v], outside = compSize[c] - inside;
    const sideFac = fac[v], otherFac = sub(compFac[c], fac[v]);
    // the cut-off part is the smaller side (by junctions)
    const [cutN, cutFac] = inside <= outside ? [inside, sideFac] : [outside, otherFac];
    const d = describe(cutN, cutFac, compFac[c]);
    return {
      roadId: parentEdge[v], from: ids[parent[v]], to: ids[v], componentSize: compSize[c], ...d,
      critical: cutN >= criticalJunctions || d.facilitiesCutOffTotal > 0,
    };
  });

  const articulationPoints = [...apChildren].map(([v, children]) => {
    const c = comp[v];
    const pieces = children.map((ch) => ({ size: size[ch], fac: fac[ch] }));
    const sepSize = pieces.reduce((s, p) => s + p.size, 0);
    const restSize = compSize[c] - 1 - sepSize;
    if (restSize > 0) pieces.push({ size: restSize, fac: sub(sub(compFac[c], ownFac[v]), pieces.reduce((a, p) => add(a, p.fac), zero())) });
    pieces.sort((a, b) => b.size - a.size);
    const cut = pieces.slice(1);                                 // everything except the largest piece
    const cutN = cut.reduce((s, p) => s + p.size, 0);
    const cutFac = cut.reduce((a, p) => add(a, p.fac), zero());
    const restFac = sub(compFac[c], ownFac[v]);
    const losesAccessTo = FACILITY_KINDS.filter((k) => restFac[k] > 0 && cut.some((p) => p.fac[k] === 0));
    return {
      nodeId: ids[v], pieces: pieces.length, componentSize: compSize[c],
      cutJunctions: cutN, facilitiesCutOff: cutFac, facilitiesCutOffTotal: total(cutFac), losesAccessTo,
      critical: cutN >= criticalJunctions || total(cutFac) > 0,
    };
  });

  return {
    bridges, articulationPoints, components: compSize.length, maxStack,
    componentOf: (id) => comp[ids.indexOf(id)],
  };
}

// ---------------- strongly connected components ----------------
export function stronglyConnectedComponents(graph) {
  const ids = [...graph.locations.keys()];
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const out = ids.map((id) => graph.neighbors(id).map((e) => index.get(e.to)));   // BLOCKED already excluded
  const idx = new Int32Array(n).fill(-1), low = new Int32Array(n), onStack = new Uint8Array(n);
  const iter = new Int32Array(n), comp = new Int32Array(n).fill(-1);
  const sccStack = [];
  const components = [];
  let counter = 0;

  for (let s = 0; s < n; s++) {
    if (idx[s] !== -1) continue;
    const call = [s];
    idx[s] = low[s] = counter++; sccStack.push(s); onStack[s] = 1;
    while (call.length) {
      const v = call[call.length - 1];
      if (iter[v] < out[v].length) {
        const w = out[v][iter[v]++];
        if (idx[w] === -1) {                                     // "recurse" into w
          idx[w] = low[w] = counter++; sccStack.push(w); onStack[w] = 1;
          call.push(w);
        } else if (onStack[w] && idx[w] < low[v]) low[v] = idx[w];
        continue;
      }
      call.pop();
      if (call.length) { const p = call[call.length - 1]; if (low[v] < low[p]) low[p] = low[v]; }
      if (low[v] === idx[v]) {                                   // v is the root of a component
        const members = [];
        let w;
        do { w = sccStack.pop(); onStack[w] = 0; comp[w] = components.length; members.push(ids[w]); } while (w !== v);
        components.push(members);
      }
    }
  }
  return { components, componentOf: (id) => comp[index.get(id)], comp, ids, out };
}

// Trap zones after closures: every SCC other than the largest, classified by the condensation edges.
//   trap      = can be entered but not left   (vehicles that go in are stuck)
//   no-entry  = can be left but not entered   (nobody can reach people inside)
//   isolated  = neither (completely cut off)
//   passage   = can be entered and left, but not in both directions with the main network
export function trapZones(graph, { facilityNodes = new Map() } = {}) {
  const { components, comp, ids, out } = stronglyConnectedComponents(graph);
  if (components.length <= 1) return { components: components.length, zones: [] };
  let main = 0;
  components.forEach((c, i) => { if (c.length > components[main].length) main = i; });
  const hasIn = new Uint8Array(components.length), hasOut = new Uint8Array(components.length);
  for (let v = 0; v < ids.length; v++) {
    for (const w of out[v]) if (comp[v] !== comp[w]) { hasOut[comp[v]] = 1; hasIn[comp[w]] = 1; }
  }
  const zones = [];
  components.forEach((members, i) => {
    if (i === main) return;
    const kind = hasIn[i] && !hasOut[i] ? 'trap' : !hasIn[i] && hasOut[i] ? 'no-entry' : !hasIn[i] ? 'isolated' : 'passage';
    const facilities = zero();
    for (const id of members) add(facilities, { ...zero(), ...(facilityNodes.get(id) ?? {}) });
    zones.push({ id: `Z${zones.length + 1}`, kind, junctions: members.length, nodeIds: members, facilities, facilitiesTotal: total(facilities) });
  });
  zones.sort((a, b) => b.junctions - a.junctions);
  return { components: components.length, mainSize: components[main].length, zones };
}
