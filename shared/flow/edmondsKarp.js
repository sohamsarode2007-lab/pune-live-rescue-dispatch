// Maximum flow with Edmonds-Karp (Ford-Fulkerson with BREADTH-first augmenting paths) and the minimum cut.
//
// Residual network as an edge list: edge e and its reverse e ^ 1 are stored next to each other, so pushing
// f units along e is cap[e] -= f, cap[e ^ 1] += f. Each augmentation takes the SHORTEST (fewest edges) path
// from s to t with spare capacity (BFS), pushes its bottleneck, and repeats until no path is left.
// Shortest paths bound the number of augmentations by O(V·E), so the total is O(V·E²).
//
// Max-flow min-cut theorem: when no augmenting path remains, the vertices reachable from s in the residual
// network form S; every original edge from S to T = V \ S is saturated, and their capacities sum to the
// max flow. Those edges are the bottleneck.
export class FlowNetwork {
  constructor(n) {
    this.n = n;
    this.head = new Int32Array(n).fill(-1);
    this.to = []; this.cap = []; this.orig = []; this.next = []; this.from = []; this.label = [];
  }

  // Directed edge u -> v with capacity cap (and its residual reverse with 0). Returns the edge index.
  addEdge(u, v, cap, label = null) {
    if (!(cap >= 0)) throw new Error('capacity must be >= 0');
    for (const [a, b, c] of [[u, v, cap], [v, u, 0]]) {
      this.to.push(b); this.from.push(a); this.cap.push(c); this.orig.push(c);
      this.next.push(this.head[a]); this.head[a] = this.to.length - 1;
      this.label.push(c > 0 || a === u ? label : null);
    }
    return this.to.length - 2;
  }

  // Returns { flow, augmentations }. Capacities are left as residuals (call minCut afterwards).
  maxFlow(s, t) {
    if (s === t) throw new Error('source and sink must differ');
    let flow = 0, augmentations = 0;
    const parentEdge = new Int32Array(this.n);
    const queue = new Int32Array(this.n);
    for (;;) {
      parentEdge.fill(-1);
      parentEdge[s] = -2;
      let qh = 0, qt = 0;
      queue[qt++] = s;
      while (qh < qt && parentEdge[t] === -1) {                // BFS: shortest augmenting path
        const u = queue[qh++];
        for (let e = this.head[u]; e !== -1; e = this.next[e]) {
          const v = this.to[e];
          if (parentEdge[v] === -1 && this.cap[e] > 0) { parentEdge[v] = e; queue[qt++] = v; }
        }
      }
      if (parentEdge[t] === -1) break;                        // no augmenting path: flow is maximum
      let push = Infinity;
      for (let v = t; v !== s; v = this.from[parentEdge[v]]) push = Math.min(push, this.cap[parentEdge[v]]);
      for (let v = t; v !== s; v = this.from[parentEdge[v]]) { const e = parentEdge[v]; this.cap[e] -= push; this.cap[e ^ 1] += push; }
      flow += push;
      augmentations++;
    }
    return { flow, augmentations };
  }

  // After maxFlow: S = vertices reachable from s in the residual network; cut = original edges S -> T.
  minCut(s) {
    const inS = new Uint8Array(this.n);
    const stack = [s];
    inS[s] = 1;
    while (stack.length) {
      const u = stack.pop();
      for (let e = this.head[u]; e !== -1; e = this.next[e]) {
        const v = this.to[e];
        if (!inS[v] && this.cap[e] > 0) { inS[v] = 1; stack.push(v); }
      }
    }
    const edges = [];
    for (let e = 0; e < this.to.length; e += 2) {
      if (this.orig[e] > 0 && inS[this.from[e]] && !inS[this.to[e]]) edges.push(e);
    }
    const capacity = edges.reduce((sum, e) => sum + this.orig[e], 0);
    return { inS, edges, capacity };
  }

  flowOn(e) { return this.orig[e] - this.cap[e]; }
}
