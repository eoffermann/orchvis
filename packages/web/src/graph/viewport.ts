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

/** The SVG `transform` attribute for a view. */
export function transformAttr(v: ViewTransform): string {
  return `translate(${v.x.toFixed(2)},${v.y.toFixed(2)}) scale(${v.scale.toFixed(4)})`;
}

/** Auto-fit tuning. */
export const AUTO_FIT = Object.freeze({
  /** Fraction of the remaining distance eased per frame. */
  ease: 0.08,
  /** The fit target is kept until a new fit moves the graph more than this on screen, in px. */
  deadbandPx: 24,
  /** The fit target is kept until a new fit changes the scale by more than this fraction. */
  deadbandScale: 0.03,
  /** Within this many screen px of the target, the view snaps to it and stops. */
  snapPx: 0.5,
});

/**
 * The auto-fit camera: eases toward the transform that fits the graph, but
 * ignores refits smaller than a deadband and snaps the last half pixel, so
 * small drifts under steady traffic leave the view still.
 */
export class AutoFit {
  private target: ViewTransform | null = null;
  private view: ViewTransform | null = null;

  /** The current view, or null before the first step. */
  current(): ViewTransform | null {
    return this.view;
  }

  /** Advances one frame toward the fit of `box` on a `width × height` screen. */
  step(box: Parameters<typeof fitTransform>[0], width: number, height: number): ViewTransform {
    const fit = fitTransform(box, width, height);
    if (!this.target || !this.view || exceedsDeadband(this.target, fit, width, height)) this.target = fit;
    if (!this.view) {
      this.view = this.target;
      return this.view;
    }
    const next = lerpTransform(this.view, this.target, AUTO_FIT.ease);
    this.view = screenDistance(next, this.target, width, height) < AUTO_FIT.snapPx ? this.target : next;
    return this.view;
  }

  /** Holds the view where it is (while dragging), dropping the target. */
  hold(): void {
    this.target = this.view;
  }
}

/** Largest on-screen move of any screen corner between two views, in px. */
function screenDistance(a: ViewTransform, b: ViewTransform, width: number, height: number): number {
  // A screen point p maps back to layout (p - t) / s; compare where both views put the screen's corners.
  let worst = 0;
  for (const [px, py] of [
    [0, 0],
    [width, height],
  ] as const) {
    const lx = (px - a.x) / a.scale;
    const ly = (py - a.y) / a.scale;
    worst = Math.max(worst, Math.abs(lx * b.scale + b.x - px), Math.abs(ly * b.scale + b.y - py));
  }
  return worst;
}

function exceedsDeadband(current: ViewTransform, fit: ViewTransform, width: number, height: number): boolean {
  return (
    Math.abs(fit.scale / current.scale - 1) > AUTO_FIT.deadbandScale ||
    screenDistance(current, fit, width, height) > AUTO_FIT.deadbandPx
  );
}
