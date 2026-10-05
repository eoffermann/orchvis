import { polygonHull } from 'd3-polygon';

/** A 2D point. */
export type Point = readonly [number, number];

/** Padding between a node's center and its repo hull edge, in px. */
export const HULL_PADDING = 44;

/** FNV-1a 32-bit hash of a string. Stable across sessions and machines. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Stable color for a repo key: a hue from the key's hash, at a fixed
 * saturation and lightness that read on the dark graph background.
 */
export function repoColor(key: string): string {
  const hue = hashString(key) % 360;
  return `hsl(${hue} 60% 62%)`;
}

/**
 * Padded convex hull around `points`: each point is expanded to a ring of
 * `samples` points at radius `pad`, then hulled. Works for one or two points,
 * which a plain hull cannot enclose. Returns null for no points.
 */
export function paddedHull(points: readonly Point[], pad: number = HULL_PADDING, samples = 12): Point[] | null {
  if (points.length === 0) return null;
  const ring: [number, number][] = [];
  for (const [x, y] of points) {
    for (let i = 0; i < samples; i++) {
      const a = (i / samples) * Math.PI * 2;
      ring.push([x + Math.cos(a) * pad, y + Math.sin(a) * pad]);
    }
  }
  return polygonHull(ring);
}

/**
 * SVG path through a closed polygon, smoothed with quadratic curves through
 * the midpoints of its sides. Empty string for fewer than three points.
 */
export function hullPath(hull: readonly Point[] | null): string {
  if (!hull || hull.length < 3) return '';
  const n = hull.length;
  const mid = (i: number): [number, number] => {
    const p = hull[i % n] as Point;
    const q = hull[(i + 1) % n] as Point;
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  };
  const start = mid(0);
  let d = `M${start[0].toFixed(1)},${start[1].toFixed(1)}`;
  for (let i = 1; i <= n; i++) {
    const c = hull[i % n] as Point;
    const m = mid(i);
    d += `Q${c[0].toFixed(1)},${c[1].toFixed(1)} ${m[0].toFixed(1)},${m[1].toFixed(1)}`;
  }
  return `${d}Z`;
}

/** Topmost point of a hull, for its label. Null for no hull. */
export function hullTop(hull: readonly Point[] | null): Point | null {
  if (!hull || hull.length === 0) return null;
  let top = hull[0] as Point;
  for (const p of hull) if (p[1] < top[1]) top = p;
  return top;
}
