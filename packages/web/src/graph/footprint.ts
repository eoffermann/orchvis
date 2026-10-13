import type { SessionNode } from '@orchvis/protocol';
import { formatAgo } from '../overlays/model';

/** Visible node radius, in layout px. */
export const NODE_RADIUS = 20;

/** Baseline of the name label below the node center, in layout px. */
export const NAME_BASELINE = NODE_RADIUS + 18;

/** Baseline of the host label below the node center, in layout px. */
export const HOST_BASELINE = NODE_RADIUS + 34;

/**
 * Glyph width of the name label (0.95rem, weight 600), in px per character:
 * a little over the widest average measured in Chromium, so the estimate
 * covers the drawn text (e2e/layout.check.ts checks it).
 */
const NAME_PX_PER_CHAR = 15.2 * 0.66;

/** Glyph width of the host label (0.75rem), in px per character, likewise. */
const HOST_PX_PER_CHAR = 12 * 0.61;

/**
 * The box a node occupies on screen, relative to its center: the circle (and
 * poll badge) on top, the name and host labels below. The layout keeps these
 * boxes apart so labels never sit on each other.
 */
export interface Footprint {
  /** Half the box width, in layout px. */
  halfWidth: number;
  /** Top edge relative to the center (negative), in layout px. */
  top: number;
  /** Bottom edge relative to the center, in layout px. */
  bottom: number;
}

/** The host line under a node: hostname, plus when it was last seen if disconnected. */
export function hostLabel(session: Pick<SessionNode, 'hostname' | 'connected' | 'lastSeen'>, now: number): string {
  return session.connected ? session.hostname : `${session.hostname} · last seen ${formatAgo(now - session.lastSeen)}`;
}

/**
 * Estimated footprint of a node with these labels. Text is estimated from
 * its length rather than measured, so the layout runs without a DOM and
 * gives the same answer everywhere.
 */
export function nodeFootprint(name: string, host: string): Footprint {
  const width = Math.max(2 * NODE_RADIUS, name.length * NAME_PX_PER_CHAR, host.length * HOST_PX_PER_CHAR) + 8;
  return { halfWidth: width / 2, top: -NODE_RADIUS - 6, bottom: HOST_BASELINE + 4 };
}
