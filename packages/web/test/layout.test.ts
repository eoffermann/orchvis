import { describe, expect, it } from 'vitest';
import { seededRandom } from '../src/dev/fakeFeed';
import { GraphLayout, LAYOUT, entryPosition, groupCentroids, linkDistance } from '../src/graph/layout';

describe('linkDistance', () => {
  it('maps weight 0..20 to 320..90 px linearly and clamps outside', () => {
    expect(linkDistance(0)).toBe(320);
    expect(linkDistance(20)).toBe(90);
    expect(linkDistance(10)).toBe(205);
    expect(linkDistance(5)).toBeCloseTo(262.5);
    expect(linkDistance(-3)).toBe(320);
    expect(linkDistance(500)).toBe(90);
  });

  it('is monotonically non-increasing', () => {
    let prev = Infinity;
    for (let w = 0; w <= 25; w += 0.5) {
      const d = linkDistance(w);
      expect(d).toBeLessThanOrEqual(prev);
      prev = d;
    }
  });
});

describe('layout constants', () => {
  it('match the plan', () => {
    expect(LAYOUT.linkStrength).toBe(0.3);
    expect(LAYOUT.groupStrength).toBe(0.08);
    expect(LAYOUT.collideRadius).toBe(48);
    expect(LAYOUT.manyBodyStrength).toBe(-300);
    expect(LAYOUT.velocityDecay).toBe(0.6);
    expect(LAYOUT.warmAlphaTarget).toBe(0.05);
    expect(LAYOUT.warmMs).toBe(2000);
  });
});

describe('group centroids and entry', () => {
  it('counts a node in two groups toward both', () => {
    const c = groupCentroids([
      { x: 0, y: 0, groups: ['a'] },
      { x: 10, y: 0, groups: ['a', 'b'] },
      { x: 30, y: 30, groups: ['b'] },
    ]);
    expect(c.get('a')).toEqual({ x: 5, y: 0 });
    expect(c.get('b')).toEqual({ x: 20, y: 15 });
  });

  it('enters a new node at its group centroid, within jitter', () => {
    const centroids = new Map([
      ['a', { x: 100, y: 50 }],
      ['b', { x: 300, y: 50 }],
    ]);
    const p = entryPosition(['a', 'b'], centroids, () => 0.5);
    expect(p).toEqual({ x: 200, y: 50 });
    const q = entryPosition(['a'], centroids, () => 0.999);
    expect(Math.abs(q.x - 100)).toBeLessThanOrEqual(LAYOUT.entryJitter);
    expect(entryPosition(['zzz'], centroids, () => 0.5)).toEqual({ x: 0, y: 0 });
  });
});

describe('GraphLayout', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `h:${i}`, groups: [i < 6 ? 'g1' : 'g2'] }));
  const links = [
    { id: 'h:0|h:1', source: 'h:0', target: 'h:1', weight: 20 },
    { id: 'h:6|h:7', source: 'h:6', target: 'h:7', weight: 0 },
  ];

  function settle(layout: GraphLayout, from: number): number {
    let t = from;
    for (let i = 0; i < 600; i++) {
      t += 16;
      layout.tick(t);
    }
    return t;
  }

  it('starts with full alpha once, then never reheats to full alpha', () => {
    const layout = new GraphLayout(seededRandom(7));
    layout.update(nodes, links, 0);
    expect(layout.sim.alpha()).toBe(1);
    let t = settle(layout, 0);
    expect(layout.sim.alpha()).toBeLessThan(0.05);

    // A new node and a weight change only warm the layout.
    layout.update([...nodes, { id: 'h:new', groups: ['g1'] }], [{ ...links[0]!, weight: 1 }, links[1]!], t);
    expect(layout.sim.alpha()).toBeLessThan(0.05);
    expect(layout.sim.alphaTarget()).toBe(LAYOUT.warmAlphaTarget);
    expect(layout.isWarm(t + 1000)).toBe(true);
    t = settle(layout, t);
    expect(layout.sim.alphaTarget()).toBe(0);
    expect(layout.sim.alpha()).toBeLessThan(0.1);
  });

  it('places a new node near its group centroid', () => {
    const layout = new GraphLayout(seededRandom(3));
    layout.update(nodes, links, 0);
    const t = settle(layout, 0);
    const centroid = groupCentroids(layout.allNodes()).get('g2')!;
    layout.update([...nodes, { id: 'h:late', groups: ['g2'] }], links, t);
    const n = layout.node('h:late')!;
    expect(Math.hypot(n.x - centroid.x, n.y - centroid.y)).toBeLessThanOrEqual(LAYOUT.entryJitter * Math.SQRT2 + 1e-9);
  });

  it('pulls heavy links closer than idle ones', () => {
    const layout = new GraphLayout(seededRandom(11));
    layout.update(nodes, links, 0);
    settle(layout, 0);
    const d = (a: string, b: string) => {
      const p = layout.node(a)!;
      const q = layout.node(b)!;
      return Math.hypot(p.x - q.x, p.y - q.y);
    };
    expect(d('h:0', 'h:1')).toBeLessThan(d('h:6', 'h:7'));
  });

  it('does not warm for decay that moves distances by under the threshold', () => {
    const layout = new GraphLayout(seededRandom(5));
    layout.update(nodes, links, 0);
    const t = settle(layout, 0);
    layout.update(nodes, [{ ...links[0]!, weight: 19.5 }, links[1]!], t);
    expect(layout.isWarm(t + 1)).toBe(false);
    layout.update(nodes, [{ ...links[0]!, weight: 15 }, links[1]!], t);
    expect(layout.isWarm(t + 1)).toBe(true);
  });

  it('pins on drag and releases on request', () => {
    const layout = new GraphLayout(seededRandom(9));
    layout.update(nodes, links, 0);
    layout.dragStart('h:3', 500, 500);
    layout.dragMove('h:3', 600, 400);
    layout.dragEnd(0);
    expect(layout.isPinned('h:3')).toBe(true);
    settle(layout, 0);
    expect(layout.node('h:3')).toMatchObject({ x: 600, y: 400 });
    layout.release('h:3', 10_000);
    expect(layout.isPinned('h:3')).toBe(false);
  });

  it('removes nodes and links that are gone', () => {
    const layout = new GraphLayout(seededRandom(1));
    layout.update(nodes, links, 0);
    layout.update(nodes.slice(1), links, 10);
    expect(layout.node('h:0')).toBeUndefined();
    expect(() => settle(layout, 10)).not.toThrow();
  });
});
