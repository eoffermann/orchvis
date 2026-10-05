import { describe, expect, it } from 'vitest';
import { formatAgo } from '../src/overlays/model';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('formatAgo', () => {
  it('reads coarsely, from just now to days for a session gone over a long weekend', () => {
    expect(formatAgo(0)).toBe('just now');
    expect(formatAgo(59_000)).toBe('just now');
    expect(formatAgo(12 * MIN)).toBe('12m ago');
    expect(formatAgo(5 * HOUR)).toBe('5h ago');
    expect(formatAgo(47 * HOUR)).toBe('47h ago');
    expect(formatAgo(72 * HOUR)).toBe('3d ago');
    expect(formatAgo(99 * HOUR)).toBe('4d ago');
  });
});
