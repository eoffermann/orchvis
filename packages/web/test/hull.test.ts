import { describe, expect, it } from 'vitest';
import { HULL_PADDING, hashString, hullPath, hullTop, paddedHull, repoColor } from '../src/graph/hull';

describe('hashString and repoColor', () => {
  it('is stable and deterministic', () => {
    expect(hashString('github.com/acme/app')).toBe(hashString('github.com/acme/app'));
    expect(repoColor('github.com/acme/app')).toBe(repoColor('github.com/acme/app'));
    // FNV-1a reference value.
    expect(hashString('a')).toBe(0xe40c292c);
  });

  it('gives different keys different colors (for a typical set)', () => {
    const keys = ['github.com/acme/orchestrator', 'github.com/acme/web-frontend', 'gitlab.com/acme/infra', 'local:mac:scratch'];
    expect(new Set(keys.map(repoColor)).size).toBe(keys.length);
  });

  it('produces a valid hsl color', () => {
    expect(repoColor('x')).toMatch(/^hsl\(\d{1,3} 60% 62%\)$/);
  });
});

describe('paddedHull', () => {
  it('returns null for no points', () => {
    expect(paddedHull([])).toBeNull();
  });

  it('encloses a single point with the padding', () => {
    const hull = paddedHull([[10, 20]])!;
    expect(hull.length).toBeGreaterThanOrEqual(3);
    for (const [x, y] of hull) expect(Math.hypot(x - 10, y - 20)).toBeCloseTo(HULL_PADDING, 6);
  });

  it('encloses every input point with at least the padding (minus sampling error)', () => {
    const pts: [number, number][] = [
      [0, 0],
      [200, 0],
      [100, 150],
      [90, 40],
    ];
    const hull = paddedHull(pts)!;
    const inside = (px: number, py: number) => {
      // Convex polygon point test: same sign of cross product on all edges.
      let sign = 0;
      for (let i = 0; i < hull.length; i++) {
        const [ax, ay] = hull[i]!;
        const [bx, by] = hull[(i + 1) % hull.length]!;
        const c = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        if (c !== 0) {
          if (sign === 0) sign = Math.sign(c);
          else if (Math.sign(c) !== sign) return false;
        }
      }
      return true;
    };
    for (const [x, y] of pts) expect(inside(x, y)).toBe(true);
    const cos = Math.cos(Math.PI / 12);
    for (const [x, y] of pts) {
      for (let a = 0; a < Math.PI * 2; a += 0.3) {
        expect(inside(x + Math.cos(a) * HULL_PADDING * cos * 0.99, y + Math.sin(a) * HULL_PADDING * cos * 0.99)).toBe(true);
      }
    }
  });
});

describe('hullPath and hullTop', () => {
  it('builds a closed path and finds the topmost point', () => {
    const hull = paddedHull([[0, 0], [100, 0]])!;
    const d = hullPath(hull);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(hullPath(null)).toBe('');
    expect(hullTop(hull)![1]).toBeCloseTo(-HULL_PADDING, 6);
  });
});
