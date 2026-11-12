// Optimal assignment (Hungarian algorithm, Kuhn-Munkres with potentials) and the greedy baseline.
//
// Input: cost[i][j] = ETA (seconds) of unit j to incident i; Infinity = impossible pairing
// (e.g. a fire truck for a flood). The matrix may be rectangular.
//
// Objective (both functions report it the same way):
//   1. assign as many feasible pairs as possible, then
//   2. among those, minimise the total cost.
// Implementation: Infinity is replaced by BIG = (sum of all finite costs) + 1, so one infeasible pair
// costs more than any total of feasible ones; pairs that end up on BIG are reported as unassigned.
//
// Hungarian (row-by-row augmenting with dual potentials u, v): O(n^2 * m) for n rows <= m columns,
// i.e. O(n^3) for a square matrix. Rows > columns are handled by transposing.

export function hungarian(cost) {
  const n = cost.length, m = n ? cost[0].length : 0;
  if (n === 0 || m === 0) return { assignment: new Array(n).fill(-1), totalCost: 0, assigned: 0 };
  if (n > m) {                                      // more rows than columns: solve the transpose
    const t = Array.from({ length: m }, (_, j) => Array.from({ length: n }, (_, i) => cost[i][j]));
    const r = hungarian(t);
    const assignment = new Array(n).fill(-1);
    r.assignment.forEach((i, j) => { if (i >= 0) assignment[i] = j; });
    return { assignment, totalCost: r.totalCost, assigned: r.assigned };
  }

  let finiteSum = 0;
  for (const row of cost) for (const c of row) if (Number.isFinite(c)) finiteSum += Math.abs(c);
  const BIG = finiteSum + 1;
  const a = (i, j) => (Number.isFinite(cost[i][j]) ? cost[i][j] : BIG);

  // 1-indexed arrays; column 0 is a virtual column used to start each augmentation.
  const u = new Float64Array(n + 1), v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1);       // p[j] = row matched to column j (0 = free)
  const way = new Int32Array(m + 1);     // previous column on the alternating path
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(Infinity);
    const used = new Uint8Array(m + 1);
    do {                                  // grow the alternating tree until a free column is reached
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = a(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {      // update potentials so a new zero-reduced-cost edge appears
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {                                  // flip the augmenting path
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = new Array(n).fill(-1);
  let totalCost = 0, assigned = 0;
  for (let j = 1; j <= m; j++) {
    const i = p[j] - 1;
    if (i >= 0 && Number.isFinite(cost[i][j - 1])) { assignment[i] = j - 1; totalCost += cost[i][j - 1]; assigned++; }
  }
  return { assignment, totalCost, assigned };
}

// Greedy baseline: rows in the given order (e.g. priority order), each takes its cheapest still-free
// feasible column. O(n * m). Not optimal: an early row can take the only unit that suits a later row.
export function greedyAssignment(cost, rowOrder = cost.map((_, i) => i)) {
  const m = cost.length ? cost[0].length : 0;
  const taken = new Uint8Array(m);
  const assignment = new Array(cost.length).fill(-1);
  let totalCost = 0, assigned = 0;
  for (const i of rowOrder) {
    let best = -1;
    for (let j = 0; j < m; j++) {
      if (!taken[j] && Number.isFinite(cost[i][j]) && (best < 0 || cost[i][j] < cost[i][best])) best = j;
    }
    if (best >= 0) { taken[best] = 1; assignment[i] = best; totalCost += cost[i][best]; assigned++; }
  }
  return { assignment, totalCost, assigned };
}
