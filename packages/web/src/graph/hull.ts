import { polygonHull } from 'd3-polygon';
import type { Box } from './footprint';

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

/** Topmost point of a hull. Null for no hull. */
export function hullTop(hull: readonly Point[] | null): Point | null {
  if (!hull || hull.length === 0) return null;
  let top = hull[0] as Point;
  for (const p of hull) if (p[1] < top[1]) top = p;
  return top;
}

export type { Box };

/** Repo label font size in px (`.hull-label`: 1rem, weight 600). */
export const HULL_LABEL_FONT_PX = 16;

/** Estimated advance per character of a repo label, in px; covers Chromium's rendering with a margin. */
const HULL_LABEL_PX_PER_CHAR = HULL_LABEL_FONT_PX * 0.6;

/** Gap between a hull's edge and its label, in px. */
const HULL_LABEL_GAP = 6;

/** Extra distance of the second, farther ring of label candidates, in px. */
const HULL_LABEL_FAR = 40;

/** Estimated half size of a repo label's drawn text. */
export function hullLabelHalfSize(name: string): { halfWidth: number; halfHeight: number } {
  return { halfWidth: (name.length * HULL_LABEL_PX_PER_CHAR) / 2 + 2, halfHeight: HULL_LABEL_FONT_PX * 0.6 };
}

/** Where a repo label is drawn: its center, and the outward angle it was placed at. */
export interface HullLabelPlacement {
  x: number;
  y: number;
  angle: number;
  box: Box;
}

/** Area two boxes share beyond a 1 px tolerance on each axis; 0 when they only touch. */
export function overlapArea(a: Box, b: Box): number {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return ox > 1 && oy > 1 ? ox * oy : 0;
}

function angleGap(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

/**
 * Places a repo label just outside its hull where it covers no node and no
 * label already placed. Repo labels draw above the nodes, so the topmost spot
 * alone can hide a node's name where hulls overlap.
 *
 * Candidates sit outside each hull vertex, pushed out from the hull's center
 * far enough that the label box clears the vertex, then on a second ring
 * farther out. The angle used last time (`previous`) is tried first, so a
 * label does not hop while its spot stays clear; then the candidates go from
 * the top of the hull down. If nothing is clear, the label takes the spot it
 * covers least.
 */
export function placeHullLabel(
  hull: readonly Point[] | null,
  size: { halfWidth: number; halfHeight: number },
  obstacles: readonly Box[],
  previous?: number,
): HullLabelPlacement | null {
  if (!hull || hull.length === 0) return null;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of hull) {
    cx += x;
    cy += y;
  }
  cx /= hull.length;
  cy /= hull.length;
  const at = ([vx, vy]: Point, extra: number): HullLabelPlacement => {
    const len = Math.hypot(vx - cx, vy - cy) || 1;
    const dx = (vx - cx) / len;
    const dy = (vy - cy) / len;
    const push = Math.abs(dx) * size.halfWidth + Math.abs(dy) * size.halfHeight + HULL_LABEL_GAP + extra;
    const x = vx + dx * push;
    const y = vy + dy * push;
    const box = { left: x - size.halfWidth, right: x + size.halfWidth, top: y - size.halfHeight, bottom: y + size.halfHeight };
    return { x, y, angle: Math.atan2(dy, dx), box };
  };
  const byHeight = [...hull].sort((a, b) => a[1] - b[1]);
  const candidates = [...byHeight.map((v) => at(v, 0)), ...byHeight.map((v) => at(v, HULL_LABEL_FAR))];
  if (previous !== undefined) {
    let nearest = candidates[0] as HullLabelPlacement;
    for (const c of candidates.slice(0, byHeight.length)) {
      if (angleGap(c.angle, previous) < angleGap(nearest.angle, previous)) nearest = c;
    }
    candidates.unshift(nearest);
  }
  let best = candidates[0] as HullLabelPlacement;
  let bestCover = Infinity;
  for (const c of candidates) {
    let cover = 0;
    for (const o of obstacles) cover += overlapArea(c.box, o);
    if (cover === 0) return c;
    if (cover < bestCover) {
      best = c;
      bestCover = cover;
    }
  }
  return best;
}
