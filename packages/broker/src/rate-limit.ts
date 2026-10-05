/** Length of the rolling rate-limit window: one minute. */
export const RATE_WINDOW_MS = 60_000;

/**
 * Counts events per key over a rolling window. Used for the per-sender,
 * per-thread send limit. Only accepted events count.
 */
export class RollingRateLimiter {
  private readonly events = new Map<string, number[]>();

  /**
   * @param limit - Events allowed per key within any window.
   * @param windowMs - Window length; defaults to {@link RATE_WINDOW_MS}.
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number = RATE_WINDOW_MS,
  ) {}

  /**
   * Records an event for `key` at `now` if the key is under its limit.
   * Returns false, recording nothing, when the limit is reached.
   */
  tryAcquire(key: string, now: number): boolean {
    const list = this.prune(key, now);
    if (list.length >= this.limit) return false;
    list.push(now);
    this.events.set(key, list);
    return true;
  }

  /** Events for `key` still inside the window at `now`. */
  count(key: string, now: number): number {
    return this.prune(key, now).length;
  }

  /** Drops every key whose events have all left the window. */
  sweep(now: number): void {
    for (const key of [...this.events.keys()]) this.prune(key, now);
  }

  /** Number of keys currently tracked. */
  get size(): number {
    return this.events.size;
  }

  private prune(key: string, now: number): number[] {
    const list = this.events.get(key) ?? [];
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < list.length && (list[drop] as number) <= cutoff) drop++;
    const kept = drop ? list.slice(drop) : list;
    if (kept.length === 0) this.events.delete(key);
    else if (drop) this.events.set(key, kept);
    return kept;
  }
}
