/**
 * Injectable time source so networking and coordination logic can be tested
 * deterministically with a virtual clock.
 */
export type TimerHandle = number;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(h: TimerHandle): void;
}

export const realClock: Clock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (h) => globalThis.clearTimeout(h),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms) as unknown as number,
  clearInterval: (h) => globalThis.clearInterval(h),
};

interface SimTimer {
  id: number;
  at: number;
  fn: () => void;
  interval: number | null;
  order: number;
}

/** Virtual clock. Timers fire in time order (FIFO for equal times) when advanced. */
export class SimClock implements Clock {
  private t = 0;
  private timers = new Map<number, SimTimer>();
  private nextId = 1;
  private order = 0;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.t + Math.max(0, ms), fn, interval: null, order: this.order++ });
    return id;
  }

  clearTimeout(h: TimerHandle): void {
    this.timers.delete(h);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    const step = Math.max(1, ms);
    this.timers.set(id, { id, at: this.t + step, fn, interval: step, order: this.order++ });
    return id;
  }

  clearInterval(h: TimerHandle): void {
    this.timers.delete(h);
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: SimTimer | null = null;
      for (const tm of this.timers.values()) {
        if (tm.at > end) continue;
        if (!next || tm.at < next.at || (tm.at === next.at && tm.order < next.order)) next = tm;
      }
      if (!next) break;
      this.t = next.at;
      if (next.interval !== null) {
        next.at += next.interval;
        next.order = this.order++;
      } else {
        this.timers.delete(next.id);
      }
      next.fn();
    }
    this.t = end;
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}
