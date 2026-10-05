/** Opaque handle for a timer scheduled on a {@link Clock}. */
export type TimerHandle = { readonly __timer: unique symbol } | object;

/**
 * Time source and scheduler. Everything time-dependent in the simulator goes
 * through one, so a test can swap in a {@link FakeClock} and run thirty
 * simulated minutes in seconds.
 */
export interface Clock {
  /** Current time, milliseconds since epoch. */
  now(): number;
  /** Runs `callback` once after `delayMs`. */
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  /** Cancels a timer. Unknown or already-fired handles are ignored. */
  clearTimeout(handle: TimerHandle): void;
}

/** The real clock: `Date.now` and the global timers. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, Math.max(0, delayMs)) as unknown as TimerHandle,
  clearTimeout: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

interface FakeTimer {
  at: number;
  seq: number;
  callback: () => void;
}

/**
 * A manual clock. Time moves only through {@link FakeClock.advance} or
 * {@link FakeClock.advanceAsync}; due timers fire in time order, ties in the
 * order they were scheduled.
 */
export class FakeClock implements Clock {
  private current: number;
  private seq = 0;
  private timers: FakeTimer[] = [];

  /** Creates a clock at `start` (default 2026-10-04T12:00:00Z). */
  constructor(start: number = Date.UTC(2026, 9, 4, 12, 0, 0)) {
    this.current = start;
  }

  /** {@inheritDoc Clock.now} */
  now(): number {
    return this.current;
  }

  /** {@inheritDoc Clock.setTimeout} */
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const timer: FakeTimer = { at: this.current + Math.max(0, delayMs), seq: ++this.seq, callback };
    this.timers.push(timer);
    return timer;
  }

  /** {@inheritDoc Clock.clearTimeout} */
  clearTimeout(handle: TimerHandle): void {
    const i = this.timers.indexOf(handle as FakeTimer);
    if (i !== -1) this.timers.splice(i, 1);
  }

  /** Number of timers waiting to fire. */
  pending(): number {
    return this.timers.length;
  }

  private popDue(until: number): FakeTimer | undefined {
    let best = -1;
    for (let i = 0; i < this.timers.length; i++) {
      const t = this.timers[i] as FakeTimer;
      if (t.at > until) continue;
      const b = best === -1 ? undefined : (this.timers[best] as FakeTimer);
      if (!b || t.at < b.at || (t.at === b.at && t.seq < b.seq)) best = i;
    }
    if (best === -1) return undefined;
    return this.timers.splice(best, 1)[0];
  }

  /** Moves time forward by `ms`, firing every timer that falls due, synchronously. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (let t = this.popDue(target); t; t = this.popDue(target)) {
      this.current = Math.max(this.current, t.at);
      t.callback();
    }
    this.current = target;
  }

  /**
   * Moves time forward by `ms` in steps of `stepMs`, yielding to the event loop
   * after each step so socket I/O and promise callbacks keep pace.
   */
  async advanceAsync(ms: number, stepMs = 1000): Promise<void> {
    let left = ms;
    while (left > 0) {
      const step = Math.min(stepMs, left);
      this.advance(step);
      left -= step;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

/**
 * Calls `callback` every `intervalMs` on `clock` until the returned function
 * is called.
 */
export function every(clock: Clock, intervalMs: number, callback: () => void): () => void {
  let handle: TimerHandle | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    handle = clock.setTimeout(tick, intervalMs);
    callback();
  };
  handle = clock.setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    if (handle) clock.clearTimeout(handle);
  };
}

/**
 * A set of timers on one clock that can all be cancelled at once, for
 * components that must stop cleanly on close.
 */
export class TimerGroup {
  private readonly handles = new Set<TimerHandle>();
  private closed = false;

  /** Creates a group on `clock`. */
  constructor(readonly clock: Clock) {}

  /** Schedules `callback` after `delayMs`, unless the group is closed. */
  after(delayMs: number, callback: () => void): TimerHandle | undefined {
    if (this.closed) return undefined;
    const handle = this.clock.setTimeout(() => {
      this.handles.delete(handle);
      callback();
    }, delayMs);
    this.handles.add(handle);
    return handle;
  }

  /** Cancels one timer from this group. */
  cancel(handle: TimerHandle | undefined): void {
    if (!handle) return;
    this.handles.delete(handle);
    this.clock.clearTimeout(handle);
  }

  /** Calls `callback` every `intervalMs` until the group closes or the returned function is called. */
  every(intervalMs: number, callback: () => void): () => void {
    let handle: TimerHandle | undefined;
    let stopped = false;
    const tick = () => {
      if (stopped || this.closed) return;
      handle = this.after(intervalMs, tick);
      callback();
    };
    handle = this.after(intervalMs, tick);
    return () => {
      stopped = true;
      this.cancel(handle);
    };
  }

  /** Cancels every timer and refuses new ones. */
  close(): void {
    this.closed = true;
    for (const h of this.handles) this.clock.clearTimeout(h);
    this.handles.clear();
  }
}
