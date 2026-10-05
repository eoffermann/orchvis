import type { SessionStatus } from '@orchvis/protocol';

/** Below this decayed weight an edge is drawn fully invisible. */
export const EDGE_INVISIBLE_BELOW = 0.05;

/** Minimum opacity of an edge revealed by hovering or selecting a node. */
export const EDGE_REVEAL_OPACITY = 0.25;

/**
 * Edge opacity for a decayed weight: 0 below {@link EDGE_INVISIBLE_BELOW},
 * rising quickly so a single recent message is clearly visible, saturating
 * at 0.9.
 */
export function edgeOpacity(weight: number): number {
  if (!(weight >= EDGE_INVISIBLE_BELOW)) return 0;
  return Math.min(0.9, 0.9 * Math.sqrt(Math.min(1, weight / 4)));
}

/** Edge stroke width in px for a decayed weight: 1.5 px up to 8 px at weight 20. */
export function edgeWidth(weight: number): number {
  return 1.5 + 6.5 * Math.min(1, Math.max(0, weight) / 20);
}

/** Opacity to draw an edge with, applying the hover/selection reveal floor. */
export function displayedEdgeOpacity(weight: number, revealed: boolean): number {
  const o = edgeOpacity(weight);
  return revealed ? Math.max(o, EDGE_REVEAL_OPACITY) : o;
}

/** Ring color for a session status. */
export const STATUS_COLORS: Readonly<Record<SessionStatus, string>> = Object.freeze({
  idle: '#8aa0b8',
  working: '#4cc38a',
  blocked: '#f0a03c',
});

/** Pulse color for a plain message. */
export const PULSE_COLOR = '#e8f1ff';

/** Pulse color for a message carrying media. */
export const PULSE_MEDIA_COLOR = '#ff7ad9';

/** Owner halo color. */
export const HALO_COLOR = '#ffd166';

/** Human-readable byte count, e.g. `1.4 GB`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
