// Emergency request priority queue: a binary MAX-heap keyed by priority.
// Separate from MinHeap.js (which the routing algorithm uses for shortest paths).
// insert / extractMax are O(log n), peek is O(1).
import { SEVERITY, PRIORITY_WEIGHTS as W } from './requestConstants.js';

// priorityScore = 5*severity + 2*min(people,10) + min(waiting,10)   (weights are configurable)
export function priorityScore(req, w = W) {
  return w.severity * SEVERITY[req.severity]
    + w.people * Math.min(req.peopleAffected, w.peopleCap)
    + w.waiting * Math.min(req.waitingTimeScore, w.waitingCap);
}

// Negative result => `a` is served before `b`.
// 1) higher score  2) longer waiting time  3) request ID (natural order) as deterministic tie-break.
export function compareRequestPriority(a, b) {
  return (priorityScore(b) - priorityScore(a))
    || (b.waitingTimeScore - a.waitingTimeScore)
    || a.id.localeCompare(b.id, 'en', { numeric: true });
}

export class EmergencyPriorityQueue {
  constructor() { this.heap = []; }
  get size() { return this.heap.length; }
  isEmpty() { return this.heap.length === 0; }
  peek() { return this.heap[0]; }

  insert(req) {
    this.heap.push(req);
    let i = this.heap.length - 1;
    while (i > 0) {                               // sift up
      const p = (i - 1) >> 1;
      if (compareRequestPriority(this.heap[i], this.heap[p]) >= 0) break;
      [this.heap[i], this.heap[p]] = [this.heap[p], this.heap[i]];
      i = p;
    }
  }

  extractMax() {
    if (this.isEmpty()) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      let i = 0;
      for (;;) {                                  // sift down
        let m = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < this.heap.length && compareRequestPriority(this.heap[l], this.heap[m]) < 0) m = l;
        if (r < this.heap.length && compareRequestPriority(this.heap[r], this.heap[m]) < 0) m = r;
        if (m === i) break;
        [this.heap[i], this.heap[m]] = [this.heap[m], this.heap[i]];
        i = m;
      }
    }
    return top;
  }

  // Full service order without changing this queue (works on a copy).
  toSortedArray() {
    const copy = new EmergencyPriorityQueue();
    copy.heap = [...this.heap];
    const out = [];
    while (!copy.isEmpty()) out.push(copy.extractMax());
    return out;
  }

  // Internal array layout, for demonstrating the heap.
  heapArray() { return [...this.heap]; }
}
