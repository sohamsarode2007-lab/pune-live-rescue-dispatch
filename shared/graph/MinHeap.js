// Binary min-heap stored in an array. Used by Dijkstra (routing).
// NOT the emergency request priority queue (that is a separate structure).
// Parent of i = (i-1)>>1, children = 2i+1, 2i+2. push/pop are O(log n), peek O(1).

export class MinHeap {
  // compare(a, b) < 0 means a has higher priority (comes out first).
  constructor(compare = (a, b) => a - b) {
    this.items = [];
    this.compare = compare;
  }

  get size() { return this.items.length; }
  isEmpty() { return this.items.length === 0; }
  peek() { return this.items[0]; }

  push(item) {
    this.items.push(item);
    this.#siftUp(this.items.length - 1);
  }

  pop() {
    if (this.isEmpty()) return undefined;
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this.#siftDown(0);
    }
    return top;
  }

  #siftUp(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.compare(this.items[i], this.items[p]) >= 0) break;
      [this.items[i], this.items[p]] = [this.items[p], this.items[i]];
      i = p;
    }
  }

  #siftDown(i) {
    const n = this.items.length;
    for (;;) {
      let m = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.compare(this.items[l], this.items[m]) < 0) m = l;
      if (r < n && this.compare(this.items[r], this.items[m]) < 0) m = r;
      if (m === i) break;
      [this.items[i], this.items[m]] = [this.items[m], this.items[i]];
      i = m;
    }
  }
}
