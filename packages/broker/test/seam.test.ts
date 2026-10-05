import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@orchvis/protocol';
import { BROKER_VERSION, startBroker, type RunningBroker } from '../src/index.js';

let broker: RunningBroker | undefined;
afterEach(async () => {
  await broker?.close();
  broker = undefined;
});

describe('startBroker', () => {
  it('starts on an ephemeral port and answers /healthz', async () => {
    broker = await startBroker({ port: 0, logSink: () => {} });
    expect(broker.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(broker.url.endsWith(':7801')).toBe(false);
    const res = await fetch(`${broker.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, version: BROKER_VERSION, protocolVersion: PROTOCOL_VERSION, nodes: 0, media: 0 });
  });

  it('generates distinct tokens unless given', async () => {
    broker = await startBroker({ logSink: () => {} });
    expect(broker.shimToken).not.toBe(broker.ownerToken);
    expect(broker.shimToken.length).toBeGreaterThanOrEqual(32);
    await broker.close();
    broker = await startBroker({ config: { shimToken: 's'.repeat(20), ownerToken: 'o'.repeat(20) }, logSink: () => {} });
    expect(broker.shimToken).toBe('s'.repeat(20));
    expect(broker.ownerToken).toBe('o'.repeat(20));
  });
});
