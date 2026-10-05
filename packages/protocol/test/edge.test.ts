import { describe, expect, it } from 'vitest';
import { DEFAULT_EDGE_TAU_MS, bumpEdge, decayWeight, emptyEdge, weightAt } from '../src/index.js';

const TAU = DEFAULT_EDGE_TAU_MS;

describe('edge weight', () => {
  it('uses a 10 minute time constant by default', () => {
    expect(TAU).toBe(600_000);
  });

  it('decays by e^-1 after one time constant', () => {
    expect(decayWeight(10, TAU)).toBeCloseTo(10 / Math.E, 10);
  });

  it('does not change for zero or negative elapsed time', () => {
    expect(decayWeight(5, 0)).toBe(5);
    expect(decayWeight(5, -1000)).toBe(5);
  });

  it('starts at 0 and gains 1 per message', () => {
    const t0 = 1_000_000;
    const first = bumpEdge(emptyEdge(t0), t0);
    expect(first.weight).toBe(1);
    const second = bumpEdge(first, t0);
    expect(second.weight).toBe(2);
  });

  it('applies w <- w * e^(-dt/tau) + 1', () => {
    const t0 = 1_000_000;
    const s = { weight: 4, updatedAt: t0 };
    const dt = 90_000;
    expect(bumpEdge(s, t0 + dt).weight).toBeCloseTo(4 * Math.exp(-dt / TAU) + 1, 12);
  });

  it('does not mutate its input', () => {
    const s = { weight: 3, updatedAt: 0 };
    bumpEdge(s, 1000);
    expect(s).toEqual({ weight: 3, updatedAt: 0 });
  });

  it('gives the same result whether decayed in steps or at once', () => {
    const s = { weight: 7, updatedAt: 0 };
    const stepped = weightAt({ weight: weightAt(s, 30_000), updatedAt: 30_000 }, 100_000);
    expect(stepped).toBeCloseTo(weightAt(s, 100_000), 12);
  });

  it('never moves updatedAt backwards on a skewed clock', () => {
    const s = { weight: 1, updatedAt: 5000 };
    const next = bumpEdge(s, 4000);
    expect(next.updatedAt).toBe(5000);
    expect(next.weight).toBe(2);
  });

  it('respects a custom tau', () => {
    expect(decayWeight(1, 1000, 1000)).toBeCloseTo(1 / Math.E, 12);
  });
});
