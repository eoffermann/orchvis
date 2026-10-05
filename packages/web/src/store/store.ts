import type { EdgeStats } from '@orchvis/protocol';
import { initialState, reducer, type Action } from './reducer';
import type { AppState, StoreMessage } from './types';

/**
 * A transient event for animation: emitted once per newly routed message.
 * Pulses and halos come from these, not from state, so a snapshot never
 * replays old traffic as animation.
 */
export interface TrafficEvent {
  /** The message that was routed. */
  message: StoreMessage;
  /** Its thread's statistics after it. */
  edge: EdgeStats;
}

/** A framework-independent store around {@link reducer}. */
export interface Store {
  /** Current state. Stable identity between changes, for `useSyncExternalStore`. */
  getState(): AppState;
  /** Applies an action and notifies subscribers when the state changed. */
  dispatch(action: Action): void;
  /** Subscribes to state changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Subscribes to traffic events. Returns an unsubscribe function. */
  onTraffic(listener: (event: TrafficEvent) => void): () => void;
}

/** Creates a store, optionally from a given starting state. */
export function createStore(start: AppState = initialState()): Store {
  let state = start;
  const listeners = new Set<() => void>();
  const trafficListeners = new Set<(event: TrafficEvent) => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const prev = state;
      state = reducer(state, action);
      if (state === prev) return;
      if (
        action.type === 'frame' &&
        action.frame.type === 'message' &&
        prev.data.messageThread[action.frame.payload.message.id] === undefined &&
        state.synced
      ) {
        const event: TrafficEvent = { message: action.frame.payload.message, edge: action.frame.payload.edge };
        for (const l of trafficListeners) l(event);
      }
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onTraffic(listener) {
      trafficListeners.add(listener);
      return () => trafficListeners.delete(listener);
    },
  };
}
