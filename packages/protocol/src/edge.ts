import { DEFAULT_LIMITS } from './limits.js';

/** Default edge weight decay time constant τ: 10 minutes. */
export const DEFAULT_EDGE_TAU_MS = DEFAULT_LIMITS.edgeTauMs;

/**
 * A decayed message count for one thread, as of `updatedAt`. Broker and web app
 * both evaluate it with these functions, so layout and opacity agree.
 */
export interface EdgeWeightState {
  /** Weight as of `updatedAt`. */
  weight: number;
  /** Broker clock time of the last update, milliseconds since epoch. */
  updatedAt: number;
}

/**
 * Decays a weight over `elapsedMs`: `w · e^(−Δt/τ)`. A negative elapsed time,
 * from clock skew, is treated as zero.
 */
export function decayWeight(weight: number, elapsedMs: number, tauMs: number = DEFAULT_EDGE_TAU_MS): number {
  if (elapsedMs <= 0) return weight;
  return weight * Math.exp(-elapsedMs / tauMs);
}

/** Weight of an edge at time `now`, without changing it. */
export function weightAt(state: EdgeWeightState, now: number, tauMs: number = DEFAULT_EDGE_TAU_MS): number {
  return decayWeight(state.weight, now - state.updatedAt, tauMs);
}

/**
 * Applies one message at time `now`: `w ← w · e^(−Δt/τ) + 1`. Returns a new
 * state; the input is not changed.
 */
export function bumpEdge(state: EdgeWeightState, now: number, tauMs: number = DEFAULT_EDGE_TAU_MS): EdgeWeightState {
  return { weight: weightAt(state, now, tauMs) + 1, updatedAt: Math.max(now, state.updatedAt) };
}

/** State of an edge with no traffic yet. */
export function emptyEdge(now: number): EdgeWeightState {
  return { weight: 0, updatedAt: now };
}
