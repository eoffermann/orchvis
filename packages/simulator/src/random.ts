/**
 * A seeded pseudo-random number generator. Every random choice the simulator
 * makes goes through one of these, so a seed reproduces a run exactly.
 *
 * The core is mulberry32: small, fast and good enough for traffic generation.
 * It is not cryptographic.
 */
export class Rng {
  private state: number;

  /** Creates a generator from a 32-bit integer seed (other numbers are truncated). */
  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** One element of a non-empty array. Throws on an empty one. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty array');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** One element chosen with the given non-negative weights. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((sum, [, w]) => sum + w, 0);
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r < 0) return item;
    }
    const last = items[items.length - 1];
    if (!last) throw new Error('weighted pick from an empty array');
    return last[0];
  }

  /** Exponentially distributed value with the given mean: the gap between Poisson events. */
  exponential(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  /** A new array with the elements in random order. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  /** A hex string of `length` characters. */
  hex(length: number): string {
    let s = '';
    for (let i = 0; i < length; i++) s += Math.floor(this.next() * 16).toString(16);
    return s;
  }

  /** A UUID-shaped string (version 4 layout), drawn from this generator. */
  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }

  /**
   * An independent generator derived from this one and a label, so separate
   * concerns (traffic, IDs, media) do not disturb each other's sequences.
   */
  fork(label: string): Rng {
    let h = 2166136261 ^ Math.floor(this.next() * 4294967296);
    for (let i = 0; i < label.length; i++) {
      h ^= label.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return new Rng(h >>> 0);
  }
}
