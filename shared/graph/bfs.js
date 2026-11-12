// Breadth-First Search. Ignores BLOCKED roads (graph.neighbors only yields traversable edges).
// Time O(V + E), space O(V).
export function bfs(graph, startId) {
  if (!graph.hasLocation(startId)) throw new Error(`Unknown start location: ${startId}`);
  const visited = new Set([startId]);
  const order = [];
  const queue = [startId];
  let head = 0; // index pointer avoids O(n) Array.shift
  while (head < queue.length) {
    const u = queue[head++];
    order.push(u);
    for (const e of graph.neighbors(u)) {
      if (!visited.has(e.to)) {
        visited.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return { start: startId, order, reachable: visited };
}
