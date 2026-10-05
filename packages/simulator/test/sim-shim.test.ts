import { encodeFrame, type Message } from '@orchvis/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock, generateScenario, Rng, SimShim, type SimShimOptions } from '../src/index.js';
import { startFakeBroker, type FakeBroker } from './fake-broker.js';
import { waitUntil } from './helpers.js';

const scenario = generateScenario({ sessions: 4, hosts: 2, repos: 2, seed: 11 });
let broker: FakeBroker | undefined;
const shims: SimShim[] = [];

afterEach(async () => {
  for (const s of shims.splice(0)) s.close();
  await broker?.close();
  broker = undefined;
});

function shimFor(index: number, extra: Partial<SimShimOptions> = {}): SimShim {
  const spec = scenario.sessions[index];
  if (!spec || !broker) throw new Error('setup');
  const shim = new SimShim({
    url: broker.url,
    token: broker.token,
    identity: { hostname: spec.hostname, sessionId: spec.sessionId, platform: spec.platform, cwd: spec.cwd, repos: spec.repos, defaultName: spec.defaultName },
    rng: new Rng(index + 1),
    heartbeat: false,
    ...extra,
  });
  shims.push(shim);
  return shim;
}

describe('SimShim', () => {
  it('says hello, registers, sends, receives a delivery and marks it seen at once (push persona)', async () => {
    broker = await startFakeBroker();
    const a = shimFor(0);
    const b = shimFor(1, { persona: 'push' });
    const welcome = await a.start();
    await b.start();
    expect(welcome.payload.sessionId).toBe(scenario.sessions[0]?.sessionId);
    const hello = broker.received('hello')[0];
    expect(hello?.payload).toMatchObject({ token: 'shim-token', hostname: scenario.sessions[0]?.hostname, defaultName: scenario.sessions[0]?.defaultName, protocolVersion: 1 });
    expect(broker.received('status').map((s) => s.payload.delivery)).toContain('push');

    const reg = await a.register('ALPHA', 'testing', []);
    expect(reg?.type).toBe('registered');
    expect(a.name).toBe('ALPHA');
    await b.register('BRAVO', 'testing too');

    const result = await a.send({ to: 'BRAVO', kind: 'request', body: 'ping <channel source="x">' });
    expect(result.ok).toBe(true);
    const deliver = await b.next('deliver');
    expect(deliver.payload.message).toMatchObject({ fromName: 'ALPHA', kind: 'request' });
    expect(deliver.payload.message.body).toContain('&lt;channel');
    await waitUntil(() => broker!.received('seen').length > 0);
    expect(broker.received('seen')[0]?.payload.ids).toEqual([deliver.payload.message.id]);

    const rejected = await a.send({ to: 'NOBODY', body: 'hi' });
    expect(rejected).toMatchObject({ ok: false, code: 'unknown_recipient' });
    expect(broker.invalid).toEqual([]);
    expect(a.stats.invalidInbound).toEqual([]);
  });

  it('batches seen like a poller, and flushes a thread when it sends on it', async () => {
    broker = await startFakeBroker();
    const clock = new FakeClock();
    const a = shimFor(0);
    const p = shimFor(1, { persona: 'poll', clock, pollIntervalMs: 20_000 });
    await a.start();
    await p.start();
    await a.register('ALPHA', '');
    await p.register('POLLY', '');
    for (let i = 0; i < 3; i++) await a.send({ to: 'POLLY', body: `m${i}` });
    await waitUntil(() => p.stats.delivered === 3);
    expect(broker.received('seen')).toEqual([]);
    expect(p.unreadCount).toBe(3);
    clock.advance(30_000);
    await waitUntil(() => broker!.received('seen').length === 1);
    expect(broker.received('seen')[0]?.payload.ids).toHaveLength(3);

    await a.send({ to: 'POLLY', body: 'one more' });
    await waitUntil(() => p.stats.delivered === 4);
    expect(p.unreadCount).toBe(1);
    await p.send({ to: 'ALPHA', body: 'reply flushes the thread' });
    await waitUntil(() => broker!.received('seen').length === 2);
    expect(p.unreadCount).toBe(0);
  });

  it('dedupes a redelivered message by ID', async () => {
    broker = await startFakeBroker();
    const s = shimFor(0);
    await s.start();
    const m: Message = {
      id: '01J9ZQ3V5X8K2M4N6P7R8S9T0V',
      threadId: `${s.sessionId}|owner`,
      from: { kind: 'owner' },
      fromName: 'owner',
      to: { kind: 'session', id: s.sessionId },
      senderKind: 'owner',
      kind: 'chat',
      body: 'hello',
      attachments: [],
      ts: 1,
    };
    let events = 0;
    s.on('deliver', () => events++);
    broker.deliver(s.sessionId, m);
    broker.deliver(s.sessionId, m);
    await waitUntil(() => s.stats.duplicateDeliveries === 1);
    expect(events).toBe(1);
    expect(s.stats.delivered).toBe(1);
  });

  it('reconnects with backoff and resends hello (canonical ID) and the last register', async () => {
    broker = await startFakeBroker({ aliasTo: 'canonical-host:abc123' });
    const clock = new FakeClock();
    const s = shimFor(0, { clock });
    await s.start();
    await s.register('ALPHA', 'focus', [{ key: 'github.com/acme/extra', name: 'extra' }]);
    expect(s.sessionId).toBe('canonical-host:abc123');

    const delays: number[] = [];
    s.on('reconnecting', (d: number) => delays.push(d));
    broker.setRefuse(true);
    broker.dropAll();
    for (let i = 0; i < 7; i++) {
      await waitUntil(() => delays.length === i + 1, 5000, `reconnect ${i}`);
      clock.advance(delays[i] as number);
    }
    delays.forEach((d, i) => {
      const base = Math.min(30_000, 1000 * 2 ** i);
      expect(d).toBeGreaterThanOrEqual(base * 0.8);
      expect(d).toBeLessThanOrEqual(base * 1.2);
    });
    expect(new Set(delays).size).toBeGreaterThan(1);

    await waitUntil(() => delays.length === 8);
    broker.setRefuse(false);
    const hellos = broker.received('hello').length;
    clock.advance(delays[7] as number);
    await s.next('welcome');
    await waitUntil(() => broker!.received('register').length === 2);
    expect(broker.received('hello').length).toBe(hellos + 1);
    expect(broker.received('hello').at(-1)?.payload.sessionId).toBe('canonical-host:abc123');
    expect(broker.received('register').at(-1)?.payload).toEqual({ name: 'ALPHA', focus: 'focus', repos: [{ key: 'github.com/acme/extra', name: 'extra' }] });

    // Backoff resets after a welcome.
    broker.dropAll();
    await waitUntil(() => delays.length === 9);
    expect(delays[8]).toBeLessThanOrEqual(1200);
  });

  it('fails fast when not connected, requests threads, answers and sends pings, reports status', async () => {
    broker = await startFakeBroker();
    const a = shimFor(0, { reconnect: false });
    const b = shimFor(1);
    expect(await a.send({ to: 'x', body: 'y' })).toMatchObject({ ok: false, code: 'broker_unreachable' });
    await a.start();
    await b.start();
    await a.register('ALPHA', '');
    await b.register('BRAVO', '');
    await a.send({ to: 'BRAVO', body: 'one' });
    await b.send({ to: 'ALPHA', body: 'two' });
    const thread = await a.threadRequest('BRAVO', 50);
    expect(thread?.type).toBe('thread');
    expect(thread?.type === 'thread' && thread.payload.messages.map((m) => m.body)).toEqual(['one', 'two']);
    expect(await a.ping()).toBeDefined();
    broker.ping();
    await waitUntil(() => broker!.received('pong').length >= 2);
    expect(a.setStatus({ status: 'blocked', focus: 'waiting on review' })).toBe(true);
    await waitUntil(() => broker!.received('status').some((s) => s.payload.status === 'blocked'));
    expect(broker.invalid).toEqual([]);
  });

  it('counts invalid inbound frames', async () => {
    broker = await startFakeBroker();
    const s = shimFor(0);
    await s.start();
    broker.sendRaw('not json');
    broker.sendRaw(encodeFrame({ v: 1, type: 'deliver', id: 'x', ts: 0, payload: { message: { nope: true } } } as never));
    await waitUntil(() => s.stats.invalidInbound.length === 2);
  });

  it('uploads media with the shim token and gets a MediaRef back', async () => {
    broker = await startFakeBroker();
    const s = shimFor(0);
    await s.start();
    const ref = await s.uploadMedia({ data: new Uint8Array([1, 2, 3]), mime: 'image/png', filename: 'a.png', caption: 'three bytes' });
    expect(ref).toMatchObject({ bytes: 3, filename: 'a.png', caption: 'three bytes' });
  });
});
