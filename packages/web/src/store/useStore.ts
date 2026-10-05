import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Store } from './store';
import type { AppState } from './types';

/** React context carrying the app's {@link Store}. */
export const StoreContext = createContext<Store | null>(null);

/** The store from context. Throws outside a provider. */
export function useStoreInstance(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('StoreContext missing');
  return store;
}

/** Subscribes a component to a slice of the state. `select` must return stable values for unchanged input. */
export function useAppState<T>(select: (state: AppState) => T): T {
  const store = useStoreInstance();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}
