import type { Box } from './footprint';
import { overlapArea } from './hull';

/** Spacing between a thread's media icons, and each icon's hit square, in screen px. */
export const MEDIA_ICON_PITCH = 44;

/** Half the size of one icon's drawn badge and count (`.media-badge` r 13, count at 12, −10) with a small margin, in screen px. */
const MEDIA_BADGE_HALF = 22;

/** Fractions along an edge, from one end, where its icons may sit: the midpoint, then outward both ways. */
const SLIDE_STEPS = [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74, 0.2, 0.8, 0.14, 0.86];

/** Distances to either side of the edge, in screen px, tried after the edge itself is full. */
const SIDE_STEPS = [0, 24, -24, 48, -48];

/** Where a thread's media icons are drawn: their center, the step they sit at, and the box they cover. */
export interface MediaIconPlacement {
  x: number;
  y: number;
  /** Fraction along the edge. */
  t: number;
  /** Distance to the side of the edge, in screen px. */
  side: number;
  box: Box;
}

/**
 * Half size of what a row of `count` media icons draws, in layout px, at a
 * view scale of `scale` (icons keep their screen size at any zoom).
 */
export function mediaIconHalfSize(count: number, scale: number): { halfWidth: number; halfHeight: number } {
  return { halfWidth: (((count - 1) * MEDIA_ICON_PITCH) / 2 + MEDIA_BADGE_HALF) / scale, halfHeight: MEDIA_BADGE_HALF / scale };
}

/**
 * Places a thread's media icons on or beside its edge where they cover
 * nothing in `obstacles`. Nodes draw above the icons, so at the midpoint
 * alone a session's name can hide a badge.
 *
 * The icons slide along the edge from the midpoint outward, then do the same
 * a little to either side of it. The spot used last time (`previous`) is
 * tried first, so icons do not hop while their spot stays clear. If nothing
 * is clear, they take the spot they cover least.
 */
export function placeMediaIcons(
  a: { x: number; y: number },
  b: { x: number; y: number },
  size: { halfWidth: number; halfHeight: number },
  scale: number,
  obstacles: readonly Box[],
  previous?: { t: number; side: number },
): MediaIconPlacement {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / len / scale;
  const ny = (b.x - a.x) / len / scale;
  const at = (t: number, side: number): MediaIconPlacement => {
    const x = a.x + (b.x - a.x) * t + nx * side;
    const y = a.y + (b.y - a.y) * t + ny * side;
    return { x, y, t, side, box: { left: x - size.halfWidth, right: x + size.halfWidth, top: y - size.halfHeight, bottom: y + size.halfHeight } };
  };
  const candidates = SIDE_STEPS.flatMap((side) => SLIDE_STEPS.map((t) => at(t, side)));
  if (previous) candidates.unshift(at(previous.t, previous.side));
  let best = candidates[0] as MediaIconPlacement;
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
