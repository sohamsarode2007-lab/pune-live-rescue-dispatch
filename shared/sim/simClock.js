// Simulation clock. Simulated seconds advance `speed` times faster than real time.
// The caller passes real elapsed milliseconds to tick(), so the clock is deterministic in tests.
export const SIM_SPEEDS = Object.freeze([1, 5, 10, 30]);

export class SimClock {
  constructor({ speed = 1, startS = 0 } = {}) {
    this.nowS = startS;
    this.setSpeed(speed);
  }

  setSpeed(speed) {
    if (!(speed > 0 && speed <= 100)) throw new Error('Sim speed must be in (0, 100]');
    this.speed = speed;
  }

  // Advances by realMs of wall-clock time; returns the new simulated time in seconds.
  tick(realMs) {
    if (realMs > 0) this.nowS += (realMs / 1000) * this.speed;
    return this.nowS;
  }

  reset(startS = 0) { this.nowS = startS; }
}
