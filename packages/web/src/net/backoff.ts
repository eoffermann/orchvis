/** Reconnect backoff bounds for `/ws/ui`. */
export const BACKOFF_MIN_MS = 1_000;

/** Upper bound of the reconnect delay. */
export const BACKOFF_MAX_MS = 30_000;

/**
 * Delay before reconnect attempt number `attempt` (0-based): exponential from
 * {@link BACKOFF_MIN_MS} to {@link BACKOFF_MAX_MS}, with "equal jitter" so a
 * room of tabs does not reconnect in lockstep. `random` returns [0, 1).
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  return Math.round(base / 2 + (base / 2) * random());
}
