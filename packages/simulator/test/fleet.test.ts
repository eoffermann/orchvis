import { describe, expect, it } from 'vitest';
import { FakeClock, startShimFleet } from '../src/index.js';
import { startFakeBroker } from './fake-broker.js';

describe('startShimFleet', () => {
  it('drives a broker with valid frames: messages, replies, status, reconnects and media', async () => {
    const broker = await startFakeBroker();
    const clock = new FakeClock();
    const fleet = await startShimFleet({
      url: broker.url,
      token: broker.token,
      sessions: 8,
      hosts: 3,
      repos: 3,
      seed: 21,
      clock,
      traffic: { rate: 4, mediaRate: 0.2, disconnectMeanMs: 4 * 60_000, statusMeanMs: 60_000, ownerRatePerHour: 6 },
    });
    try {
      expect(broker.received('hello')).toHaveLength(8);
      expect(broker.received('register')).toHaveLength(8);
      await clock.advanceAsync(15 * 60_000, 250);
      await new Promise((r) => setTimeout(r, 200));

      const stats = fleet.stats();
      expect(broker.invalid).toEqual([]);
      expect(stats.invalidInbound).toBe(0);
      expect(stats.sendsOk).toBeGreaterThan(50);
      expect(stats.delivered).toBeGreaterThan(30);
      expect(stats.uploads).toBeGreaterThan(0);
      expect(stats.uploadFailures).toBe(0);
      expect(stats.reconnects).toBeGreaterThan(0);

      const sends = broker.received('send');
      expect(sends.some((f) => f.payload.attachments.length > 0)).toBe(true);
      expect(sends.some((f) => f.payload.replyTo !== undefined)).toBe(true);
      expect(sends.some((f) => f.payload.to === 'owner')).toBe(true);
      expect(broker.received('status').some((f) => f.payload.status !== undefined)).toBe(true);
      expect(broker.received('seen').length).toBeGreaterThan(0);
      // Every reconnect resends register after hello.
      expect(broker.received('register').length).toBeGreaterThan(8);
      // Media is attached once, by its uploader: the fake broker rejects anything else.
      expect(stats.sendsRejected.invalid ?? 0).toBe(0);
    } finally {
      fleet.close();
      await broker.close();
    }
  }, 30_000);
});
