/** Opaque handle for a timer created by a {@link Clock}. */
export type TimerHandle = object;

/**
 * Time source and timers used by the broker. Injected so heartbeat, offline
 * retention and rate limits can be tested without real waiting.
 */
export interface Clock {
  /** Current time, milliseconds since epoch. */
  now(): number;
  /** Runs `fn` once after `ms` milliseconds. */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  /** Cancels a timer from {@link Clock.setTimeout}. Unknown handles are ignored. */
  clearTimeout(handle: TimerHandle): void;
  /** Runs `fn` every `ms` milliseconds. */
  setInterval(fn: () => void, ms: number): TimerHandle;
  /** Cancels a timer from {@link Clock.setInterval}. Unknown handles are ignored. */
  clearInterval(handle: TimerHandle): void;
}

/** The real clock: `Date.now` and Node timers, unref'd so they never hold the process open. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref();
    return t;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

interface ManualTimer {
  id: number;
  due: number;
  fn: () => void;
  /** Repeat period for intervals; undefined for one-shot timers. */
  every: number | undefined;
}

/**
 * A {@link Clock} that only moves when told to. Timers fire synchronously
 * inside {@link ManualClock.advance}, in due-time order, with `now()` set to
 * each timer's due time while it runs.
 *
 * @example
 * const clock = new ManualClock(1_000);
 * clock.setTimeout(() => console.log(clock.now()), 500);
 * clock.advance(1_000); // logs 1500
 */
export class ManualClock implements Clock {
  private current: number;
  private nextId = 1;
  private readonly timers = new Map<number, ManualTimer>();

  /** Creates a clock reading `start` milliseconds since epoch. */
  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  /** Current time. */
  now(): number {
    return this.current;
  }

  /** Schedules `fn` at `now() + ms`. */
  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, ms, undefined);
  }

  /** Cancels a one-shot timer. */
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete((handle as { id: number }).id);
  }

  /** Schedules `fn` every `ms`, first at `now() + ms`. */
  setInterval(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, ms, Math.max(1, ms));
  }

  /** Cancels an interval. */
  clearInterval(handle: TimerHandle): void {
    this.timers.delete((handle as { id: number }).id);
  }

  /** Number of pending timers, for tests that check cleanup. */
  get pending(): number {
    return this.timers.size;
  }

  /**
   * Moves time forward by `ms`, firing every timer that falls due on the way,
   * in order. Timers scheduled by a firing timer also fire if they fall due
   * within the window.
   */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let next: ManualTimer | undefined;
      for (const t of this.timers.values()) {
        if (t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
      }
      if (!next) break;
      this.current = Math.max(this.current, next.due);
      if (next.every === undefined) this.timers.delete(next.id);
      else next.due += next.every;
      next.fn();
    }
    this.current = target;
  }

  private add(fn: () => void, ms: number, every: number | undefined): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { id, due: this.current + Math.max(0, ms), fn, every });
    return { id };
  }
}
