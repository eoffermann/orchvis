/** A view transform: screen = layout * scale + (x, y). */
export interface ViewTransform {
  /** Translation x, in screen px. */
  x: number;
  /** Translation y, in screen px. */
  y: number;
  /** Uniform scale. */
  scale: number;
}

/** Scale bounds for auto-fit: never so small that labels become unreadable. */
export const FIT_SCALE_MIN = 0.45;

/** Upper scale bound, so a few sessions do not fill a wall display. */
export const FIT_SCALE_MAX = 1.6;

/** Margin kept around the graph's bounds, in layout px (hull padding plus labels). */
export const FIT_MARGIN = 110;

/** Bounding box of points, or null for none. */
export function bounds(points: Iterable<{ x: number; y: number }>): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/** The transform that fits `box` (plus margin) centered into a `width × height` screen. */
export function fitTransform(
  box: { minX: number; minY: number; maxX: number; maxY: number } | null,
  width: number,
  height: number,
): ViewTransform {
  if (!box || width <= 0 || height <= 0) return { x: width / 2, y: height / 2, scale: 1 };
  const bw = box.maxX - box.minX + FIT_MARGIN * 2;
  const bh = box.maxY - box.minY + FIT_MARGIN * 2;
  const scale = Math.min(FIT_SCALE_MAX, Math.max(FIT_SCALE_MIN, Math.min(width / bw, height / bh)));
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  return { x: width / 2 - cx * scale, y: height / 2 - cy * scale, scale };
}

/** Moves `from` a fraction `k` toward `to`. */
export function lerpTransform(from: ViewTransform, to: ViewTransform, k: number): ViewTransform {
  return {
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
    scale: from.scale + (to.scale - from.scale) * k,
  };
}
