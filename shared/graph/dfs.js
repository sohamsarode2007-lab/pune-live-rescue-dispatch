// Depth-First Search. Ignores BLOCKED roads. Time O(V + E), space O(V).
// Iterative with an explicit stack of (vertex, next-neighbour index) frames, so it visits vertices in
// exactly the same order as the textbook recursive version but cannot overflow the call stack on a
// real road network (thousands of junctions deep).
// Returns the visit order, the reachable set, and parent/depth (depth = DFS-tree depth) per vertex.
export function dfs(graph, startId) {
  if (!graph.hasLocation(startId)) throw new Error(`Unknown start location: ${startId}`);
  const visited = new Set([startId]);
  const order = [startId];
  const parent = new Map([[startId, null]]);
  const depth = new Map([[startId, 0]]);
  let maxStack = 1;
  const stack = [{ u: startId, edges: graph.neighbors(startId), i: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.i >= top.edges.length) { stack.pop(); continue; }       // all neighbours done: backtrack
    const e = top.edges[top.i++];
    if (visited.has(e.to)) continue;
    visited.add(e.to);
    order.push(e.to);
    parent.set(e.to, { from: top.u, roadId: e.roadId });
    depth.set(e.to, depth.get(top.u) + 1);
    stack.push({ u: e.to, edges: graph.neighbors(e.to), i: 0 });  // go deeper first
    maxStack = Math.max(maxStack, stack.length);
  }
  return { start: startId, order, reachable: visited, parent, depth, maxStack };
}

// Groups locations by what DFS can reach from them over traversable roads.
// Useful for showing disconnected areas (exact for two-way roads).
export function findComponents(graph) {
  const seen = new Set();
  const components = [];
  for (const id of graph.locations.keys()) {
    if (seen.has(id)) continue;
    const { reachable } = dfs(graph, id);
    reachable.forEach((v) => seen.add(v));
    components.push([...reachable]);
  }
  return components;
}
