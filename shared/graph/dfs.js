// Depth-First Search (recursive). Ignores BLOCKED roads. Time O(V + E), space O(V).
export function dfs(graph, startId) {
  if (!graph.hasLocation(startId)) throw new Error(`Unknown start location: ${startId}`);
  const visited = new Set();
  const order = [];
  const visit = (u) => {
    visited.add(u);
    order.push(u);
    for (const e of graph.neighbors(u)) if (!visited.has(e.to)) visit(e.to);
  };
  visit(startId);
  return { start: startId, order, reachable: visited };
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
