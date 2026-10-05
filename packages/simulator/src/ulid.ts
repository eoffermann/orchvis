import type { Clock } from './clock.js';
import type { Rng } from './random.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number): string {
  let t = Math.max(0, Math.floor(ms));
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** Increments a Crockford base32 string by one, wrapping at the top. */
function increment(s: string): string {
  const chars = s.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const v = CROCKFORD.indexOf(chars[i] as string);
    if (v < 31) {
      chars[i] = CROCKFORD[v + 1] as string;
      return chars.join('');
    }
    chars[i] = '0';
  }
  return chars.join('');
}

/**
 * Returns a monotonic ULID generator driven by `clock` and `rng`, so IDs are
 * reproducible from a seed. IDs from one generator sort in creation order,
 * including several within the same millisecond.
 */
export function createUlidFactory(clock: Clock, rng: Rng): () => string {
  let lastTime = -1;
  let lastRandom = '';
  return () => {
    const now = clock.now();
    if (now <= lastTime) {
      lastRandom = increment(lastRandom);
      return encodeTime(lastTime) + lastRandom;
    }
    lastTime = now;
    let r = '';
    // Keep the top character below the maximum so increments never wrap in practice.
    r += CROCKFORD[Math.floor(rng.next() * 16)];
    for (let i = 1; i < 16; i++) r += CROCKFORD[Math.floor(rng.next() * 32)];
    lastRandom = r;
    return encodeTime(now) + r;
  };
}
