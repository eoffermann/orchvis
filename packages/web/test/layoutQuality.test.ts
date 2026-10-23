import { describe, expect, it } from 'vitest';
import { nodeFootprint } from '../src/graph/footprint';
import { GraphLayout } from '../src/graph/layout';
import { seededRandom } from '../src/dev/fakeFeed';
import { makeScenario, runScenario, snapshot, spearman } from './layoutQuality';

/*
 * Readability gates for the tuned layout, from the harness behind
 * scripts/layout-report.ts. Fleets of 10 to 30 sessions (the plan's range)
 * over four repos, two minutes of steady traffic, several seeds.
 */
describe('layout quality', () => {
  for (const n of [10, 20, 30]) {
    it(`keeps ${n} sessions readable under steady traffic`, () => {
      const proximity: number[] = [];
      for (const seed of [1, 2, 3, 4]) {
        const sc = makeScenario(n, seed);
        const r = runScenario(sc, { seed, rate: 2, trafficMs: 60_000 });
        // No label sits on another, at rest or at any second of traffic.
        expect(r.settled.labelOverlaps, `seed ${seed} settled`).toBe(0);
        expect(r.worst.labelOverlaps, `seed ${seed} traffic`).toBeLessThanOrEqual(1);
        // Repo names never cover a session's labels or each other.
        expect(r.settled.repoLabelOverlaps, `seed ${seed} settled`).toBe(0);
        expect(r.worst.repoLabelOverlaps, `seed ${seed} traffic`).toBe(0);
        // Media icons rarely sit under a session's labels, a repo name or another
        // thread's icons. A third of all threads carry media here, so a dense
        // patch can leave no clear spot near an edge; at the midpoint alone
        // 60 to 90 percent of those threads were covered.
        const mediaThreads = sc.media.size;
        expect(r.settled.mediaIconOverlaps, `seed ${seed} settled`).toBeLessThanOrEqual(Math.ceil(mediaThreads * 0.2));
        expect(r.worst.mediaIconOverlaps, `seed ${seed} traffic`).toBeLessThanOrEqual(Math.ceil(mediaThreads * 0.25));
        // Sessions stay out of other repos' hulls.
        expect(r.worst.intrusions, `seed ${seed}`).toBeLessThanOrEqual(1);
        // The graph fits a 1080p display above the minimum readable scale.
        expect(r.final.fitScale1080, `seed ${seed}`).toBeGreaterThan(0.8);
        // Steady traffic nudges the layout; it does not churn.
        expect(r.p95Step, `seed ${seed}`).toBeLessThan(10);
        // Most frames draw nothing new, camera included, so nodes are still click targets.
        expect(r.stillFraction, `seed ${seed}`).toBeGreaterThan(0.4);
        proximity.push(r.final.proximity);
      }
      // Busier threads are shorter. One fleet's moment can be noisy, so gate the mean.
      expect(proximity.reduce((a, b) => a + b, 0) / proximity.length).toBeLessThan(-0.1);
    });
  }

  it('separates nodes placed on top of each other by their footprints', () => {
    const sc = makeScenario(12, 4);
    const layout = new GraphLayout(seededRandom(4), { entryJitter: 1 });
    layout.update(
      sc.nodes.map((n) => ({ id: n.id, groups: ['one'], footprint: nodeFootprint(n.name, n.hostname) })),
      [],
      0,
    );
    expect(snapshot(layout, sc, new Map()).labelOverlaps).toBeGreaterThan(0);
    for (let i = 0; i < 600; i++) layout.tick(i * 16);
    expect(snapshot(layout, sc, new Map()).labelOverlaps).toBe(0);
  });

  it('spearman ranks', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 2], [2, 1])).toBe(0);
  });
});
