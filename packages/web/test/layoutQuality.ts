import { bumpEdge, emptyEdge, weightAt, type EdgeWeightState } from '@orchvis/protocol';
import { polygonContains } from 'd3-polygon';
import { seededRandom } from '../src/dev/fakeFeed';
import { footprintBox, nodeFootprint } from '../src/graph/footprint';
import { hullLabelHalfSize, paddedHull, placeHullLabel, type Box, type Point } from '../src/graph/hull';
import { GraphLayout, type LayoutParams } from '../src/graph/layout';
import { AutoFit, bounds, fitTransform, transformAttr } from '../src/graph/viewport';

/*
 * Layout quality harness: drives GraphLayout headlessly through a fleet's
 * traffic, frame by frame, and measures what makes the graph readable on a
 * wall display. Shared by test/layoutQuality.test.ts (thresholds) and
 * scripts/layout-report.ts (tuning sweeps).
 */

/** A session in a scenario. */
export interface ScenarioNode {
  /** Session ID. */
  id: string;
  /** Session name, drawn under the node. */
  name: string;
  /** Hostname, drawn under the name. */
  hostname: string;
  /** Repo keys. */
  groups: string[];
}

/** A fleet and who talks to whom. */
export interface Scenario {
  /** Sessions. */
  nodes: ScenarioNode[];
  /** Conversation pairs, picked uniformly per message. */
  pairs: [string, string][];
}

const REPOS = ['github.com/acme/orchestrator', 'github.com/acme/web-frontend', 'gitlab.com/acme/infra', 'github.com/acme/ml-pipeline'];
const HOSTS = ['mediaroomwindows', 'studio-mac', 'buildbox'];
const ROLES = ['api', 'ui', 'tests', 'docs', 'infra', 'perf', 'review', 'build', 'data', 'auth'];
const NAMES = ['WEB-CHECKOUT', 'PAY-SCHEMA', 'orchestrator mechanics', 'Groups', 'El Jefe', 'reply-quality-session', 'FrndoWeb', 'Memory Work', 'shim', 'ledger-api'];

/**
 * A fleet shaped like the simulator's: `n` sessions over four repos, one in
 * seven in two repos, a local scratch repo on the Mac, and names of mixed
 * length. Each session talks to two peers in its repo, and three in ten to
 * one peer anywhere.
 */
export function makeScenario(n: number, seed: number): Scenario {
  const random = seededRandom(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const nodes: ScenarioNode[] = [];
  for (let i = 0; i < n; i++) {
    const hostname = HOSTS[i % HOSTS.length] as string;
    const groups = [REPOS[i % REPOS.length] as string];
    if (i % 7 === 3) groups.push(REPOS[(i + 1) % REPOS.length] as string);
    if (hostname === 'studio-mac' && i % 5 === 0) groups.push('local:studio-mac:scratch');
    const name = i % 2 === 0 ? `${(groups[0] as string).split('/').pop()}-${ROLES[i % ROLES.length]}` : (NAMES[i % NAMES.length] as string);
    nodes.push({ id: `${hostname}:s${i}`, name, hostname, groups });
  }
  const pairs: [string, string][] = [];
  for (const a of nodes) {
    const same = nodes.filter((b) => b !== a && b.groups.some((g) => a.groups.includes(g)));
    for (let k = 0; k < 2 && same.length > 0; k++) pairs.push([a.id, pick(same).id]);
    if (random() < 0.3) pairs.push([a.id, pick(nodes.filter((b) => b !== a)).id]);
  }
  return { nodes, pairs };
}

/** Readability and stability of one moment of a layout. */
export interface Snapshot {
  /** Pairs of nodes whose footprints (circle plus labels) overlap. */
  labelOverlaps: number;
  /** Nodes whose footprint overlaps at least one other. */
  nodesOverlapped: number;
  /** Nodes sitting inside the hull of a repo they are not in. */
  intrusions: number;
  /** Repo labels covering a node or another repo label, placed as GraphView places them. */
  repoLabelOverlaps: number;
  /** Auto-fit scale on a 1920 × 1080 display (larger is more readable). */
  fitScale1080: number;
  /** Spearman rank correlation of edge weight against length (negative: heavy edges are shorter). */
  proximity: number;
}

/** Measures one moment. */
export function snapshot(
  layout: GraphLayout,
  scenario: Scenario,
  weights: ReadonlyMap<string, number>,
  labelAngles?: Map<string, number>,
): Snapshot {
  const pos = scenario.nodes.map((n) => ({ n, p: layout.node(n.id)!, f: nodeFootprint(n.name, n.hostname) }));
  let labelOverlaps = 0;
  const overlapped = new Set<string>();
  for (let i = 0; i < pos.length; i++) {
    for (let j = i + 1; j < pos.length; j++) {
      const a = pos[i]!;
      const b = pos[j]!;
      // Touching boxes are fine; count only overlaps deeper than 1 px on both axes.
      const ox = a.f.halfWidth + b.f.halfWidth - Math.abs(a.p.x - b.p.x) > 1;
      const oy = Math.min(a.p.y + a.f.bottom, b.p.y + b.f.bottom) - Math.max(a.p.y + a.f.top, b.p.y + b.f.top) > 1;
      if (ox && oy) {
        labelOverlaps++;
        overlapped.add(a.n.id);
        overlapped.add(b.n.id);
      }
    }
  }
  let intrusions = 0;
  let repoLabelOverlaps = 0;
  const obstacles: Box[] = pos.map((x) => footprintBox(x.p.x, x.p.y, x.f));
  const groups = new Set(scenario.nodes.flatMap((n) => n.groups));
  for (const g of groups) {
    const hull = paddedHull(pos.filter((x) => x.n.groups.includes(g)).map((x): Point => [x.p.x, x.p.y]));
    if (!hull) continue;
    for (const x of pos) {
      if (!x.n.groups.includes(g) && polygonContains(hull as [number, number][], [x.p.x, x.p.y])) intrusions++;
    }
    const spot = placeHullLabel(hull, hullLabelHalfSize(repoLabel(g)), obstacles, labelAngles?.get(g));
    if (!spot) continue;
    labelAngles?.set(g, spot.angle);
    if (obstacles.some((o) => overlapDepth(spot.box, o) > 1)) repoLabelOverlaps++;
    obstacles.push(spot.box);
  }
  const fitScale1080 = fitTransform(bounds(pos.map((x) => x.p)), 1920, 1080).scale;
  const ws: number[] = [];
  const ds: number[] = [];
  for (const [key, w] of weights) {
    const [a, b] = key.split('|') as [string, string];
    const pa = layout.node(a);
    const pb = layout.node(b);
    if (!pa || !pb) continue;
    ws.push(w);
    ds.push(Math.hypot(pa.x - pb.x, pa.y - pb.y));
  }
  return { labelOverlaps, nodesOverlapped: overlapped.size, intrusions, repoLabelOverlaps, fitScale1080, proximity: spearman(ws, ds) };
}

/** The label the web app draws for a repo key: its last path segment. */
function repoLabel(key: string): string {
  return key.split(/[/:]/).pop() ?? key;
}

/** How deeply two boxes overlap: the smaller of the two axis overlaps, in px. */
function overlapDepth(a: Box, b: Box): number {
  return Math.min(Math.min(a.right, b.right) - Math.max(a.left, b.left), Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

/** Options for {@link runScenario}. */
export interface RunOptions {
  /** PRNG seed for traffic and entry jitter. */
  seed: number;
  /** Messages per second across the fleet during the measured traffic. */
  rate: number;
  /** Time to settle before traffic is measured, in ms. */
  settleMs?: number;
  /** Measured traffic, in ms. */
  trafficMs?: number;
  /** Layout overrides. */
  params?: Partial<LayoutParams>;
}

/** What a run measured. */
export interface RunResult {
  /** At the end of the settle, before measured traffic. */
  settled: Snapshot;
  /** At the end of the measured traffic. */
  final: Snapshot;
  /** Worst per-frame snapshot values seen during traffic. */
  worst: { labelOverlaps: number; intrusions: number; repoLabelOverlaps: number };
  /** Mean node speed during traffic, layout px per second. */
  meanSpeed: number;
  /** 95th percentile of per-node, per-second displacement during traffic, px. */
  p95Step: number;
  /** Frames until the first layout cooled below alphaMin. */
  settleFrames: number;
  /**
   * Fraction of traffic frames that draw exactly what the previous frame
   * drew, camera included, on a 1920 × 1080 screen: the graph is at rest
   * and a node is a still click target.
   */
  stillFraction: number;
}

const FRAME_MS = 1000 / 60;

/**
 * Runs a scenario the way GraphView does: one tick per 60 Hz frame, an
 * `update` on every message and on the 1 s decay timer. The fleet starts
 * with 20 minutes of history (four messages per session), like the
 * simulator.
 */
export function runScenario(scenario: Scenario, opts: RunOptions): RunResult {
  const random = seededRandom(opts.seed * 7919 + 1);
  const layout = new GraphLayout(seededRandom(opts.seed), opts.params);
  const edges = new Map<string, EdgeWeightState>();
  const message = (now: number) => {
    const [a, b] = scenario.pairs[Math.floor(random() * scenario.pairs.length)]!;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    edges.set(key, bumpEdge(edges.get(key) ?? emptyEdge(now), now));
  };
  const historyMs = 20 * 60_000;
  const history = scenario.nodes.length * 4;
  for (let i = 0; i < history; i++) message((historyMs * i) / history);
  let now = historyMs;
  const weightsAt = (t: number) => new Map([...edges].map(([k, s]) => [k, weightAt(s, t)]));
  const push = (t: number) =>
    layout.update(
      scenario.nodes.map((n) => ({ id: n.id, groups: n.groups, footprint: nodeFootprint(n.name, n.hostname) })),
      [...edges].map(([k, s]) => {
        const [a, b] = k.split('|') as [string, string];
        return { id: k, source: a, target: b, weight: weightAt(s, t) };
      }),
      t,
    );

  push(now);
  let settleFrames = -1;
  const settleMs = opts.settleMs ?? 15_000;
  for (let f = 0; f * FRAME_MS < settleMs; f++) {
    now += FRAME_MS;
    if (f % 60 === 59) push(now);
    layout.tick(now);
    if (settleFrames < 0 && layout.sim.alpha() < layout.sim.alphaMin()) settleFrames = f + 1;
  }
  const labelAngles = new Map<string, number>();
  const settled = snapshot(layout, scenario, weightsAt(now), labelAngles);

  const trafficMs = opts.trafficMs ?? 120_000;
  const worst = { labelOverlaps: 0, intrusions: 0, repoLabelOverlaps: 0 };
  let travelled = 0;
  const steps: number[] = [];
  let lastSecond = new Map(scenario.nodes.map((n) => [n.id, { ...layout.node(n.id)! }]));
  let nextMessage = now + expDelay(random, opts.rate);
  const end = now + trafficMs;
  let frame = 0;
  let stillFrames = 0;
  const fit = new AutoFit();
  let lastView = '';
  while (now < end) {
    const before = new Map(scenario.nodes.map((n) => [n.id, { x: layout.node(n.id)!.x, y: layout.node(n.id)!.y }]));
    now += FRAME_MS;
    frame++;
    let changed = false;
    while (nextMessage <= now) {
      message(nextMessage);
      nextMessage += expDelay(random, opts.rate);
      changed = true;
    }
    if (changed || frame % 60 === 0) push(now);
    layout.tick(now);
    let drawnMoved = false;
    for (const n of scenario.nodes) {
      const p = layout.node(n.id)!;
      const b = before.get(n.id)!;
      travelled += Math.hypot(p.x - b.x, p.y - b.y);
      // GraphView writes positions to 0.1 px.
      if (p.x.toFixed(1) !== b.x.toFixed(1) || p.y.toFixed(1) !== b.y.toFixed(1)) drawnMoved = true;
    }
    const view = transformAttr(fit.step(bounds(layout.allNodes()), 1920, 1080));
    if (!drawnMoved && view === lastView) stillFrames++;
    lastView = view;
    if (frame % 60 === 0) {
      for (const n of scenario.nodes) {
        const p = layout.node(n.id)!;
        const q = lastSecond.get(n.id)!;
        steps.push(Math.hypot(p.x - q.x, p.y - q.y));
      }
      lastSecond = new Map(scenario.nodes.map((n) => [n.id, { ...layout.node(n.id)! }]));
      const s = snapshot(layout, scenario, weightsAt(now), labelAngles);
      worst.labelOverlaps = Math.max(worst.labelOverlaps, s.labelOverlaps);
      worst.intrusions = Math.max(worst.intrusions, s.intrusions);
    }
  }
  steps.sort((a, b) => a - b);
  return {
    settled,
    final: snapshot(layout, scenario, weightsAt(now), labelAngles),
    worst,
    meanSpeed: travelled / scenario.nodes.length / (trafficMs / 1000),
    p95Step: steps[Math.floor(steps.length * 0.95)] ?? 0,
    stillFraction: stillFrames / frame,
    settleFrames,
  };
}

function expDelay(random: () => number, rate: number): number {
  return (-Math.log(1 - random()) / rate) * 1000;
}

function ranks(xs: readonly number[]): number[] {
  const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let k = i; k <= j; k++) r[order[k]![1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation; 0 for fewer than three pairs. */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length < 3) return 0;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mean = (rx.length - 1) / 2;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i]! - mean) * (ry[i]! - mean);
    dx += (rx[i]! - mean) ** 2;
    dy += (ry[i]! - mean) ** 2;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}
