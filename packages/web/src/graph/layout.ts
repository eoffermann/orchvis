import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Force,
  type ForceLink,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { Footprint } from './footprint';

/** The tunable layout constants. */
export interface LayoutParams {
  /** Link distance at weight 0, in px. */
  readonly linkDistanceMax: number;
  /** Link distance at weight {@link LayoutParams.linkWeightFull} and above, in px. */
  readonly linkDistanceMin: number;
  /** Weight at which the link distance bottoms out. */
  readonly linkWeightFull: number;
  /** Link strength. */
  readonly linkStrength: number;
  /** Pull toward each repo group's centroid. */
  readonly groupStrength: number;
  /** Collision half-size of a node given no {@link Footprint}, in px. */
  readonly collideRadius: number;
  /** Gap kept between two nodes' footprints, in px. */
  readonly collidePadding: number;
  /** Fraction of a footprint overlap resolved per tick. */
  readonly collideStrength: number;
  /** Many-body strength. */
  readonly manyBodyStrength: number;
  /** Weak centering strength (forceX/forceY toward the origin). */
  readonly centerStrength: number;
  /** Velocity decay. */
  readonly velocityDecay: number;
  /** Alpha below which the simulation stops; higher cuts the slow-drift tail of each warm-up. */
  readonly alphaMin: number;
  /** alphaTarget held after a weight change. */
  readonly warmAlphaTarget: number;
  /** How long the warm alphaTarget is held, in ms. */
  readonly warmMs: number;
  /** A link's distance must move this far, in px, to count as a weight change. */
  readonly distanceChangePx: number;
  /** Random offset for a new node around its entry point, in px. */
  readonly entryJitter: number;
}

/**
 * Layout constants. The plan's "Layout" section gave starting values; these
 * are tuned with `scripts/layout-report.ts`. Changes from the plan: link
 * strength 0.15 (from 0.3) so cross-repo threads stop dragging nodes into
 * other repos' hulls, and collision on each node's footprint, circle plus
 * labels, 6 px apart, instead of a 48 px circle, so labels never overlap.
 * For stillness under steady traffic, a weight change warms the layout only
 * when it moves a link's target length by 48 px (from 8), the warm-up is
 * gentler and shorter (alphaTarget 0.03 for 1 s, from 0.05 for 2 s), and the
 * simulation stops at alpha 0.005 (from d3's 0.001) instead of crawling.
 */
export const LAYOUT: LayoutParams = Object.freeze({
  linkDistanceMax: 320,
  linkDistanceMin: 90,
  linkWeightFull: 20,
  linkStrength: 0.15,
  groupStrength: 0.08,
  collideRadius: 48,
  collidePadding: 6,
  collideStrength: 1,
  manyBodyStrength: -300,
  centerStrength: 0.02,
  velocityDecay: 0.6,
  alphaMin: 0.005,
  warmAlphaTarget: 0.03,
  warmMs: 1_000,
  distanceChangePx: 48,
  entryJitter: 12,
});

/**
 * Link distance for a decayed edge weight: linear from 320 px at weight 0 to
 * 90 px at weight 20, clamped outside that range.
 */
export function linkDistance(weight: number, p: LayoutParams = LAYOUT): number {
  const f = Math.min(1, Math.max(0, weight / p.linkWeightFull));
  return p.linkDistanceMax - (p.linkDistanceMax - p.linkDistanceMin) * f;
}

/** A node as the simulation holds it. */
export interface LayoutNode extends SimulationNodeDatum {
  /** Session ID. */
  id: string;
  /** Repo keys the node belongs to. */
  groups: readonly string[];
  /** Box kept clear of other nodes' boxes. */
  footprint: Footprint;
  /** Current position (always set after entry). */
  x: number;
  /** Current position (always set after entry). */
  y: number;
}

/** A link as the simulation holds it. */
export interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
  /** Thread ID. */
  id: string;
  /** Decayed weight now. */
  weight: number;
}

/** Input node for {@link GraphLayout.update}. */
export interface LayoutNodeInput {
  /** Session ID. */
  id: string;
  /** Repo keys. */
  groups: readonly string[];
  /** Drawn size with labels; a square of {@link LayoutParams.collideRadius} when absent. */
  footprint?: Footprint;
}

/** Input link for {@link GraphLayout.update}. */
export interface LayoutLinkInput {
  /** Thread ID. */
  id: string;
  /** Source session ID. */
  source: string;
  /** Target session ID. */
  target: string;
  /** Decayed weight now. */
  weight: number;
}

/**
 * Centroid of every group, from nodes that already have positions.
 * A node in several groups counts toward each.
 */
export function groupCentroids(nodes: Iterable<{ x: number; y: number; groups: readonly string[] }>): Map<string, { x: number; y: number }> {
  const acc = new Map<string, { x: number; y: number; n: number }>();
  for (const node of nodes) {
    for (const g of node.groups) {
      const a = acc.get(g) ?? { x: 0, y: 0, n: 0 };
      a.x += node.x;
      a.y += node.y;
      a.n += 1;
      acc.set(g, a);
    }
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const [g, a] of acc) out.set(g, { x: a.x / a.n, y: a.y / a.n });
  return out;
}

/**
 * Where a new node enters: the mean of its groups' existing centroids, or the
 * origin when none of its groups has members yet, plus a small jitter so
 * coincident nodes can separate.
 */
export function entryPosition(
  groups: readonly string[],
  centroids: ReadonlyMap<string, { x: number; y: number }>,
  random: () => number = Math.random,
  jitter: number = LAYOUT.entryJitter,
): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const g of groups) {
    const c = centroids.get(g);
    if (c) {
      x += c.x;
      y += c.y;
      n += 1;
    }
  }
  if (n > 0) {
    x /= n;
    y /= n;
  }
  const j = jitter;
  return { x: x + (random() * 2 - 1) * j, y: y + (random() * 2 - 1) * j };
}

/** A d3 force pulling each node toward the centroid of each of its groups. */
export function forceGroups(strength: number = LAYOUT.groupStrength): Force<LayoutNode, LayoutLink> {
  let nodes: LayoutNode[] = [];
  const force = (alpha: number) => {
    const centroids = groupCentroids(nodes);
    for (const node of nodes) {
      for (const g of node.groups) {
        const c = centroids.get(g);
        if (!c) continue;
        node.vx = (node.vx ?? 0) + (c.x - node.x) * strength * alpha;
        node.vy = (node.vy ?? 0) + (c.y - node.y) * strength * alpha;
      }
    }
  };
  force.initialize = (n: LayoutNode[]) => {
    nodes = n;
  };
  return force;
}

/**
 * A d3 force keeping node footprints (circle plus labels) from overlapping.
 * Each overlapping pair is pushed apart along the axis where the overlap is
 * smaller, by `strength` of the overlap per tick, like d3's forceCollide but
 * for boxes. A pinned node does not move; the other takes the whole push.
 */
export function forceBoxCollide(
  padding: number = LAYOUT.collidePadding,
  strength: number = LAYOUT.collideStrength,
): Force<LayoutNode, LayoutLink> {
  let nodes: LayoutNode[] = [];
  const force = () => {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i] as LayoutNode;
      const fa = a.footprint;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j] as LayoutNode;
        const fb = b.footprint;
        const ax = a.x + (a.vx ?? 0);
        const ay = a.y + (a.vy ?? 0);
        const bx = b.x + (b.vx ?? 0);
        const by = b.y + (b.vy ?? 0);
        const dx = bx - ax;
        const ox = fa.halfWidth + fb.halfWidth + padding - Math.abs(dx);
        if (ox <= 0) continue;
        const oy = Math.min(ay + fa.bottom, by + fb.bottom) - Math.max(ay + fa.top, by + fb.top) + padding;
        if (oy <= 0) continue;
        const wa = a.fx == null ? 1 : 0;
        const wb = b.fx == null ? 1 : 0;
        if (wa + wb === 0) continue;
        if (ox < oy) {
          const push = (ox * strength) / (wa + wb);
          const s = dx === 0 ? (i < j ? 1 : -1) : Math.sign(dx);
          a.vx = (a.vx ?? 0) - s * push * wa;
          b.vx = (b.vx ?? 0) + s * push * wb;
        } else {
          const dy = by + (fb.top + fb.bottom) / 2 - (ay + (fa.top + fa.bottom) / 2);
          const push = (oy * strength) / (wa + wb);
          const s = dy === 0 ? 1 : Math.sign(dy);
          a.vy = (a.vy ?? 0) - s * push * wa;
          b.vy = (b.vy ?? 0) + s * push * wb;
        }
      }
    }
  };
  force.initialize = (n: LayoutNode[]) => {
    nodes = n;
  };
  return force;
}

/**
 * The force layout. It owns a d3 simulation that never runs its own timer:
 * the renderer calls {@link GraphLayout.tick} once per animation frame, so
 * layout and pulses share one requestAnimationFrame loop.
 *
 * Stability rules: full alpha only for the first layout; afterwards a weight
 * or membership change holds alphaTarget at 0.05 for 2 s, then returns it to 0.
 */
export class GraphLayout {
  /** The underlying simulation, exposed for diagnostics and tests. */
  readonly sim: Simulation<LayoutNode, LayoutLink>;
  private readonly linkForce: ForceLink<LayoutNode, LayoutLink>;
  private readonly nodes = new Map<string, LayoutNode>();
  private links = new Map<string, LayoutLink>();
  /** Distance each link had when the layout last warmed up for it. */
  private readonly appliedDistance = new Map<string, number>();
  private warmUntil = Number.NEGATIVE_INFINITY;
  private dragging = 0;
  private firstLayout = true;
  private readonly random: () => number;
  /** The constants this layout runs with. */
  readonly params: LayoutParams;
  private readonly defaultFootprint: Footprint;

  /**
   * Creates an empty layout. `random` seeds entry jitter (injectable for
   * tests); `params` overrides constants, for tuning.
   */
  constructor(random: () => number = Math.random, params: Partial<LayoutParams> = {}) {
    this.random = random;
    const p = (this.params = { ...LAYOUT, ...params });
    const r = p.collideRadius;
    this.defaultFootprint = { halfWidth: r, top: -r, bottom: r };
    this.linkForce = forceLink<LayoutNode, LayoutLink>([])
      .id((d) => d.id)
      .distance((l) => linkDistance(l.weight, p))
      .strength(p.linkStrength);
    this.sim = forceSimulation<LayoutNode, LayoutLink>([])
      .velocityDecay(p.velocityDecay)
      .alphaMin(p.alphaMin)
      .force('link', this.linkForce)
      .force('group', forceGroups(p.groupStrength))
      .force('charge', forceManyBody<LayoutNode>().strength(p.manyBodyStrength))
      .force('collide', forceBoxCollide(p.collidePadding, p.collideStrength))
      .force('x', forceX<LayoutNode>(0).strength(p.centerStrength))
      .force('y', forceY<LayoutNode>(0).strength(p.centerStrength))
      .stop();
  }

  /** Current node by ID, or undefined. */
  node(id: string): LayoutNode | undefined {
    return this.nodes.get(id);
  }

  /** All nodes. */
  allNodes(): Iterable<LayoutNode> {
    return this.nodes.values();
  }

  /** Whether the simulation is warm because of a recent change or a drag. */
  isWarm(now: number): boolean {
    return this.dragging > 0 || now < this.warmUntil;
  }

  /**
   * Reconciles the simulation with the current graph. New nodes enter at
   * their group centroid; removed ones leave. Links are matched by thread ID.
   * Warms the layout (never reheats) when membership changes or any link's
   * distance moved by more than {@link LAYOUT.distanceChangePx}.
   */
  update(nodes: readonly LayoutNodeInput[], links: readonly LayoutLinkInput[], now: number): void {
    let structural = false;
    const seen = new Set<string>();
    const centroids = groupCentroids(this.nodes.values());
    // Groups that have no members yet get spread-out anchors, so repos start
    // apart instead of all entering at the origin and tangling.
    const anchors = groupAnchors(
      nodes.filter((n) => !this.nodes.has(n.id)),
      centroids,
      this.nodes.values(),
    );
    for (const [g, p] of anchors) centroids.set(g, p);
    for (const input of nodes) {
      seen.add(input.id);
      const footprint = input.footprint ?? this.defaultFootprint;
      const existing = this.nodes.get(input.id);
      if (existing) {
        if (!sameList(existing.groups, input.groups)) {
          existing.groups = input.groups;
        }
        existing.footprint = footprint;
        continue;
      }
      const pos = entryPosition(input.groups, centroids, this.random, this.params.entryJitter);
      this.nodes.set(input.id, { id: input.id, groups: input.groups, footprint, x: pos.x, y: pos.y, vx: 0, vy: 0 });
      structural = true;
    }
    for (const id of [...this.nodes.keys()]) {
      if (!seen.has(id)) {
        this.nodes.delete(id);
        structural = true;
      }
    }

    const nextLinks = new Map<string, LayoutLink>();
    let distanceMoved = false;
    for (const l of links) {
      if (!this.nodes.has(l.source) || !this.nodes.has(l.target) || l.source === l.target) continue;
      const prev = this.links.get(l.id);
      const prevSource = prev ? endpointId(prev.source) : undefined;
      const prevTarget = prev ? endpointId(prev.target) : undefined;
      if (prev && prevSource === l.source && prevTarget === l.target) {
        prev.weight = l.weight;
        nextLinks.set(l.id, prev);
      } else {
        nextLinks.set(l.id, { id: l.id, source: l.source, target: l.target, weight: l.weight });
        structural = true;
      }
      const d = linkDistance(l.weight, this.params);
      const applied = this.appliedDistance.get(l.id);
      if (applied === undefined || Math.abs(applied - d) > this.params.distanceChangePx) {
        this.appliedDistance.set(l.id, d);
        distanceMoved = true;
      }
    }
    for (const id of this.links.keys()) {
      if (!nextLinks.has(id)) {
        structural = true;
        this.appliedDistance.delete(id);
      }
    }
    this.links = nextLinks;

    if (structural) {
      this.sim.nodes([...this.nodes.values()]);
      this.linkForce.links([...this.links.values()]);
    } else {
      // Re-evaluate cached link distances for the new weights.
      this.linkForce.distance((l) => linkDistance(l.weight, this.params));    }

    if (this.firstLayout) {
      if (this.nodes.size > 0) {
        this.firstLayout = false;
        this.sim.alpha(1);
      }
      return;
    }
    if (structural || distanceMoved) this.warm(now);
  }

  /** Holds alphaTarget at the warm value for {@link LAYOUT.warmMs} from `now`. */
  warm(now: number): void {
    this.warmUntil = Math.max(this.warmUntil, now + this.params.warmMs);
    this.sim.alphaTarget(this.params.warmAlphaTarget);
  }

  /**
   * Advances the simulation one step if it has energy. Returns whether
   * anything moved, so the renderer can skip redundant work.
   */
  tick(now: number): boolean {
    if (!this.isWarm(now) && this.sim.alphaTarget() !== 0) this.sim.alphaTarget(0);
    if (this.sim.alpha() < this.sim.alphaMin() && this.sim.alphaTarget() === 0) return false;
    this.sim.tick();
    return true;
  }

  /** Begins dragging a node; it is pinned under the pointer. */
  dragStart(id: string, x: number, y: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    this.dragging += 1;
    n.fx = x;
    n.fy = y;
    this.sim.alphaTarget(this.params.warmAlphaTarget);
  }

  /** Moves a dragged node. */
  dragMove(id: string, x: number, y: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.fx = x;
    n.fy = y;
  }

  /** Ends a drag. The node stays pinned until {@link GraphLayout.release}. */
  dragEnd(now: number): void {
    this.dragging = Math.max(0, this.dragging - 1);
    this.warm(now);
  }

  /** Whether a node is pinned. */
  isPinned(id: string): boolean {
    const n = this.nodes.get(id);
    return n !== undefined && n.fx != null;
  }

  /** Releases a pinned node. */
  release(id: string, now: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.fx = null;
    n.fy = null;
    this.warm(now);
  }
}

/**
 * Entry anchors for groups that have no placed members yet. On an empty
 * layout they sit evenly on a circle whose radius grows with the node count;
 * later they go just outside the current layout, at golden-angle steps.
 * Groups are anchored in key order, so the result is deterministic.
 */
export function groupAnchors(
  entering: readonly LayoutNodeInput[],
  centroids: ReadonlyMap<string, { x: number; y: number }>,
  placed: Iterable<{ x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  const fresh = [...new Set(entering.flatMap((n) => n.groups))].filter((g) => !centroids.has(g)).sort();
  const out = new Map<string, { x: number; y: number }>();
  if (fresh.length === 0) return out;
  const pts = [...placed];
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x / pts.length;
    cy += p.y / pts.length;
  }
  let maxR = 0;
  for (const p of pts) maxR = Math.max(maxR, Math.hypot(p.x - cx, p.y - cy));
  if (pts.length === 0 && fresh.length === 1) {
    out.set(fresh[0] as string, { x: 0, y: 0 });
    return out;
  }
  const empty = pts.length === 0;
  const radius = empty ? 100 + 60 * Math.sqrt(entering.length) : maxR + 150;
  const offset = empty ? -Math.PI / 2 : centroids.size * GOLDEN_ANGLE;
  const step = empty ? (2 * Math.PI) / fresh.length : GOLDEN_ANGLE;
  fresh.forEach((g, i) => {
    const a = offset + i * step;
    out.set(g, { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  });
  return out;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function endpointId(end: string | number | LayoutNode): string {
  return typeof end === 'object' ? end.id : String(end);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
