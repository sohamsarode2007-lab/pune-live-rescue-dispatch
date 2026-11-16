// Breadth-First Search. Ignores BLOCKED roads (graph.neighbors only yields traversable edges).
// Time O(V + E), space O(V).
// Returns the visit order, the reachable set, and parent/depth per vertex (depth = number of roads
// from the start = BFS level; options.excludeRoadIds: Set of road IDs ignored for this run only; BFS finds the fewest-roads route, not the fastest).
export function bfs(graph, startId, options = {}) {
  if (!graph.hasLocation(startId)) throw new Error(`Unknown start location: ${startId}`);
  const visited = new Set([startId]);
  const order = [];
  const parent = new Map([[startId, null]]);
  const depth = new Map([[startId, 0]]);
  const queue = [startId];
  let head = 0; // index pointer avoids O(n) Array.shift
  while (head < queue.length) {
    const u = queue[head++];
    order.push(u);
    for (const e of graph.neighbors(u)) {
      if (!visited.has(e.to) && !options.excludeRoadIds?.has(e.roadId)) {
        visited.add(e.to);
        parent.set(e.to, { from: u, roadId: e.roadId });
        depth.set(e.to, depth.get(u) + 1);
        queue.push(e.to);
      }
    }
  }
  return { start: startId, order, reachable: visited, parent, depth };
}
