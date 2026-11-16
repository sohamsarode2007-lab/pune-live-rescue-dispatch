// Discrete-event simulation queue: future events ordered by simulated time (a binary min-heap).
// Events with equal times come out in insertion order (a sequence number breaks ties), so the
// simulation is deterministic. push / pop O(log n), peek O(1).
import { MinHeap } from '../graph/MinHeap.js';

export class EventQueue {
  constructor() {
    this.heap = new MinHeap((a, b) => a.time - b.time || a.seq - b.seq);
    this.seq = 0;
  }

  get size() { return this.heap.size; }
  isEmpty() { return this.heap.isEmpty(); }
  peek() { return this.heap.peek(); }

  // Schedule `event` (any object with a `type`) at simulated time `time` (seconds).
  push(time, event) {
    if (!Number.isFinite(time)) throw new Error('Event time must be a finite number');
    const item = { ...event, time, seq: this.seq++ };
    this.heap.push(item);
    return item;
  }

  pop() { return this.heap.pop(); }

  // Removes and returns every event due at or before `now`, earliest first.
  popDue(now) {
    const out = [];
    while (!this.heap.isEmpty() && this.heap.peek().time <= now) out.push(this.heap.pop());
    return out;
  }

  clear() { this.heap = new MinHeap(this.heap.compare); this.seq = 0; }
}
