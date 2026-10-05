import { describe, expect, it } from 'vitest';
import { UiStateMirror, diffUiStates, startShimFleet } from '@orchvis/simulator';
import { FakeUi } from './helpers/fake.js';
import { startBroker } from '../src/index.js';

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
});
