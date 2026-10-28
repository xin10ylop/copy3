/** Send-time scheduling: setTimeout to ~SPIN_MS before the target, then busy-wait. */
import { nowMs } from '@hood/core';

export interface Scheduler {
  now(): number;
  /** Run `fn` at absolute local time `t` (ms). Returns a cancel function. */
  at(t: number, fn: () => void): () => void;
}

export class PreciseScheduler implements Scheduler {
  constructor(
    private readonly spinMs = 1.5,
    private readonly clock: () => number = nowMs,
  ) {}

  now(): number {
    return this.clock();
  }

  at(t: number, fn: () => void): () => void {
    let cancelled = false;
    const fire = (): void => {
      if (cancelled) return;
      while (this.clock() < t) {
        /* spin ≤ spinMs */
      }
      fn();
    };
    const wait = t - this.clock() - this.spinMs;
    let timer: NodeJS.Timeout | undefined;
    if (wait <= 0) queueMicrotask(fire);
    else timer = setTimeout(fire, wait);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }
}

/** Deterministic scheduler for tests: time only moves on `advance`. */
export class ManualScheduler implements Scheduler {
  private queue: { t: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  constructor(public t = 0) {}

  now(): number {
    return this.t;
  }

  at(t: number, fn: () => void): () => void {
    const id = this.seq++;
    this.queue.push({ t, fn, id });
    this.queue.sort((a, b) => a.t - b.t || a.id - b.id);
    return () => {
      this.queue = this.queue.filter((q) => q.id !== id);
    };
  }

  /** Advance time to `to`, running due callbacks in order (each sees `now() === its t`). */
  advance(to: number): void {
    while (this.queue.length && this.queue[0]!.t <= to) {
      const q = this.queue.shift()!;
      this.t = Math.max(this.t, q.t);
      q.fn();
    }
    this.t = Math.max(this.t, to);
  }

  get pending(): number {
    return this.queue.length;
  }
}
