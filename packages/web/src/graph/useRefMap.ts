import { useRef } from 'react';

/** A keyed set of element refs with stable callback refs per key. */
export interface RefMap<T extends Element> {
  /** Mounted elements by key. */
  readonly map: Map<string, T>;
  /** A stable callback ref for `key`. */
  ref(key: string): (el: T | null) => void;
}

/**
 * Keeps a Map of mounted elements by key, for imperative per-frame updates
 * that bypass React rendering. Callback refs are cached per key so React does
 * not detach and reattach them on every render.
 */
export function useRefMap<T extends Element>(): RefMap<T> {
  const holder = useRef<RefMap<T> | null>(null);
  if (!holder.current) {
    const map = new Map<string, T>();
    const callbacks = new Map<string, (el: T | null) => void>();
    holder.current = {
      map,
      ref(key) {
        let cb = callbacks.get(key);
        if (!cb) {
          cb = (el) => {
            if (el) map.set(key, el);
            else {
              map.delete(key);
              callbacks.delete(key);
            }
          };
          callbacks.set(key, cb);
        }
        return cb;
      },
    };
  }
  return holder.current;
}
