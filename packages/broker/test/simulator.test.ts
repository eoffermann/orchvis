import { describe, expect, it } from 'vitest';
import { UiStateMirror, diffUiStates, startShimFleet, type ShimFleet } from '@orchvis/simulator';
import { FakeUi } from './helpers/fake.js';
import { startBroker, type RunningBroker } from '../src/index.js';

/**
 * Stops the fleet and waits until the broker has seen every shim go. Until
 * then shims still send (poll-persona `seen` batches, heartbeats), so a
 * snapshot and a live feed synced a moment apart can legitimately differ.
 */
async function quiesce(fleet: ShimFleet, broker: RunningBroker): Promise<void> {
  fleet.close();
  const deadline = Date.now() + 5_000;
  while (broker.stats().shimLinks > 0) {
    if (Date.now() > deadline) throw new Error('shims did not disconnect');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('broker driven by the WP1 simulator fleet', () => {
  it('routes random fleet traffic with valid frames, and the live feed matches a fresh snapshot', async () => {
    const logs: string[] = [];
    const broker = await startBroker({ port: 0, logSink: (l) => logs.push(l) });
    const { ui } = await FakeUi.connect(broker);
    const fleet = await startShimFleet({
      url: `${broker.url.replace(/^http/, 'ws')}/ws/shim`,
      token: broker.shimToken,
      sessions: 8,
      hosts: 2,
      repos: 3,
      seed: 7,
      traffic: { rate: 600, ownerRatePerHour: 3600, statusMeanMs: 500, disconnectMeanMs: 0, hostileRate: 0.2 },
    });
    try {
      await new Promise((r) => setTimeout(r, 2_500));
      fleet.engine?.stop();
      await new Promise((r) => setTimeout(r, 300));
      const stats = fleet.stats();
      expect(stats.invalidInbound).toBe(0);
      expect(stats.sendsOk).toBeGreaterThan(10);
      expect(stats.delivered).toBeGreaterThan(5);

      await quiesce(fleet, broker);
      await ui.sync();
      const live = new UiStateMirror();
      for (const f of ui.frames) live.apply(f);
      const { ui: ui2, snapshot } = await FakeUi.connect(broker);
      const fresh = new UiStateMirror();
      fresh.apply(snapshot);
      expect(diffUiStates(live.state(), fresh.state(), snapshot.payload.now)).toEqual([]);
      expect(snapshot.payload.nodes).toHaveLength(8);
      // Hostile bodies arrive escaped.
      for (const m of snapshot.payload.messages) expect(m.body).not.toMatch(/<\s*\/?\s*channel/i);
      await ui2.close();
    } finally {
      fleet.close();
      await ui.close();
      await broker.close();
    }
  }, 20_000);

  it('accepts fleet media uploads and attachments, and the feed still matches a fresh snapshot', async () => {
    const logs: string[] = [];
    const broker = await startBroker({ port: 0, logSink: (l) => logs.push(l) });
    const { ui } = await FakeUi.connect(broker);
    const fleet = await startShimFleet({
      url: `${broker.url.replace(/^http/, 'ws')}/ws/shim`,
      token: broker.shimToken,
      sessions: 6,
      hosts: 2,
      repos: 2,
      seed: 11,
      traffic: { rate: 300, ownerRatePerHour: 1800, statusMeanMs: 1000, disconnectMeanMs: 0, hostileRate: 0.2, mediaRate: 0.5 },
    });
    try {
      await new Promise((r) => setTimeout(r, 2_500));
      fleet.engine?.stop();
      await new Promise((r) => setTimeout(r, 500));
      const stats = fleet.stats();
      expect(stats.invalidInbound).toBe(0);
      expect(stats.uploads).toBeGreaterThan(3);
      // The fleet bursts well above a real session's pace, so some uploads may meet the per-session
      // upload limit; any other upload rejection is a bug.
      const rejected = logs.filter((l) => l.includes('"endpoint":"media"')).map((l) => (JSON.parse(l) as { code: string }).code);
      expect(rejected.filter((c) => c !== 'rate_limited')).toEqual([]);
      expect(stats.uploadFailures).toBe(rejected.length);

      await quiesce(fleet, broker);
      await ui.sync();
      const { ui: ui2, snapshot } = await FakeUi.connect(broker);
      const live = new UiStateMirror();
      for (const f of ui.frames) live.apply(f);
      const fresh = new UiStateMirror();
      fresh.apply(snapshot);
      expect(diffUiStates(live.state(), fresh.state(), snapshot.payload.now)).toEqual([]);
      expect(snapshot.payload.media.length).toBeGreaterThan(0);
      expect(snapshot.payload.messages.some((m) => m.attachments.length > 0)).toBe(true);
      await ui2.close();
    } finally {
      fleet.close();
      await ui.close();
      await broker.close();
    }
  }, 20_000);
});
