import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '@orchvis/protocol';
import { CloseCodes } from '../src/index.js';
import { UiStateMirror, diffUiStates } from '@orchvis/simulator';
import { harness } from './helpers/setup.js';

/** Heartbeat slow enough that large clock jumps do not disconnect the test shims. */
const NO_HEARTBEAT = { heartbeatIntervalMs: 3_600_000, disconnectAfterMs: 7_200_000 };

describe('offline queue and redelivery', () => {
  it('queues messages for a disconnected node and delivers them in order on reconnect', async () => {
    const h = await harness();
    const { shim: a } = await h.shim('host:a');
    await a.register('ALPHA');
    const { shim: b } = await h.shim('host:b');
    await b.register('BETA');
    await b.close();
    for (const body of ['one', 'two', 'three']) expect((await a.sendMessage('BETA', body)).type).toBe('sent');
    const { shim: b2, welcome } = await h.shim('host:b');
    expect(welcome.payload.name).toBe('BETA');
    const bodies = [];
    for (let i = 0; i < 3; i++) bodies.push((await b2.next('deliver')).payload.message.body);
    expect(bodies).toEqual(['one', 'two', 'three']);
    // The welcome came first.
    expect(b2.frames.findIndex((f) => f.type === 'welcome')).toBeLessThan(b2.frames.findIndex((f) => f.type === 'deliver'));
  });

  it('still delivers queued messages that the ring buffer has evicted', async () => {
    const h = await harness({ limits: { ringBufferPerThread: 2 } });
    const { shim: a } = await h.shim('host:a');
    await a.register('ALPHA');
    const { shim: b } = await h.shim('host:b');
    await b.register('BETA');
    await b.close();
    for (const body of ['1', '2', '3', '4']) await a.sendMessage('BETA', body);
    const { shim: b2 } = await h.shim('host:b');
    const bodies = [];
    for (let i = 0; i < 4; i++) bodies.push((await b2.next('deliver')).payload.message.body);
    expect(bodies).toEqual(['1', '2', '3', '4']);
  });

  it('after welcome for a known session, redelivers every unseen buffered message, oldest first', async () => {
    const h = await harness();
    const { shim: a } = await h.shim('host:a');
    await a.register('ALPHA');
    const { shim: b } = await h.shim('host:b');
    await b.register('BETA');
    for (const body of ['m1', 'm2', 'm3']) await a.sendMessage('BETA', body);
    const live = [];
    for (let i = 0; i < 3; i++) live.push((await b.next('deliver')).payload.message);
    b.send('seen', { ids: [live[1]!.id] });
    await b.sync();
    await b.close();
    // A restarted shim lost its inbox: it gets m1 and m3 again, not the seen m2.
    const { shim: b2 } = await h.shim('host:b');
    expect((await b2.next('deliver')).payload.message.id).toBe(live[0]!.id);
    expect((await b2.next('deliver')).payload.message.id).toBe(live[2]!.id);
    await b2.sync();
    expect(b2.pending('deliver')).toHaveLength(0);
  });

  it('a brand-new session gets no redelivery', async () => {
    const h = await harness();
    const { shim } = await h.shim('host:new');
    await shim.sync();
    expect(shim.frames.filter((f) => f.type === 'deliver')).toHaveLength(0);
  });

  it('removes the node after offline retention and drops its queue', async () => {
    const h = await harness({ limits: NO_HEARTBEAT });
    const { shim: a } = await h.shim('host:a');
    await a.register('ALPHA');
    const { shim: b } = await h.shim('host:b');
    await b.register('BETA');
    await b.close();
    await a.next('peers', (f) => f.payload.peers.some((p) => p.id === 'host:b' && !p.connected));
    await a.sendMessage('BETA', 'lost');
    h.clock.advance(DEFAULT_LIMITS.offlineRetentionMs - 1);
    await a.sync();
    expect((await a.sendMessage('BETA', 'still queued')).type).toBe('sent');
    h.clock.advance(1);
    await a.next('peers', (f) => f.payload.peers.length === 0);
    // The same session coming back later is a new node, with nothing queued.
    const { shim: b2, welcome } = await h.shim('host:b');
    expect(welcome.payload.name).toMatch(/^repo@host/);
    await b2.sync();
    expect(b2.frames.filter((f) => f.type === 'deliver')).toHaveLength(0);
  });
});

describe('ring buffers and thread_request', () => {
  it('keeps ringBufferPerThread messages per thread and returns history oldest first', async () => {
    const h = await harness({ limits: { ringBufferPerThread: 3 } });
    const { shim: a } = await h.shim('host:a');
    await a.register('ALPHA');
    const { shim: b } = await h.shim('host:b');
    await b.register('BETA');
    for (let i = 1; i <= 5; i++) await a.sendMessage('BETA', `m${i}`);
    await a.sendMessage('owner', 'o1');

    let re = b.send('thread_request', { peer: 'ALPHA' });
    let t = await b.next('thread', (f) => f.payload.re === re);
    expect(t.payload.threadId).toBe('host:a|host:b');
    expect(t.payload.messages.map((m) => m.body)).toEqual(['m3', 'm4', 'm5']);

    re = b.send('thread_request', { peer: 'host:a', limit: 2 });
    t = await b.next('thread', (f) => f.payload.re === re);
    expect(t.payload.messages.map((m) => m.body)).toEqual(['m4', 'm5']);

    re = a.send('thread_request', { peer: 'owner' });
    t = await a.next('thread', (f) => f.payload.re === re);
    expect(t.payload).toMatchObject({ threadId: 'host:a|owner' });
    expect(t.payload.messages.map((m) => m.body)).toEqual(['o1']);

    re = a.send('thread_request', { peer: 'NOBODY' });
    expect((await a.next('rejected', (f) => f.payload.re === re)).payload.code).toBe('unknown_recipient');
    re = a.send('thread_request', { peer: 'ALPHA' });
    expect((await a.next('rejected', (f) => f.payload.re === re)).payload.code).toBe('invalid');

    const { snapshot } = await h.ui();
    expect(snapshot.payload.messages.map((m) => m.body)).toEqual(['m3', 'm4', 'm5', 'o1']);
    const edge = snapshot.payload.edges.find((e) => e.threadId === 'host:a|host:b');
    // Edge counts cover every message, not only the buffered ones.
    expect(edge).toMatchObject({ a: 'host:a', b: 'host:b', sentByA: 5, sentByB: 0, media: { image: 0, audio: 0, video: 0, other: 0 } });
    expect(h.logs.some((l) => l.includes('"ring_evicted"'))).toBe(true);
  });

  it('history with a removed peer is still available by its session ID', async () => {
    const h = await harness({ limits: NO_HEARTBEAT });
    const { shim: a } = await h.shim('host:a');
    await a.register('ALPHA');
    const { shim: b } = await h.shim('host:b');
    await b.register('BETA');
    await a.sendMessage('BETA', 'hello');
    await b.close();
    h.clock.advance(DEFAULT_LIMITS.offlineRetentionMs);
    await a.next('peers', (f) => f.payload.peers.length === 0);
    const re = a.send('thread_request', { peer: 'host:b' });
    expect((await a.next('thread', (f) => f.payload.re === re)).payload.messages.map((m) => m.body)).toEqual(['hello']);
  });
});

describe('edge statistics', () => {
  it('decays and bumps the weight with the shared function, and counts each direction', async () => {
    const h = await harness({ limits: NO_HEARTBEAT });
    const { ui } = await h.ui();
    const { shim: a } = await h.shim('host:a');
    await a.register('ALPHA');
    const { shim: b } = await h.shim('host:b');
    await b.register('BETA');
    await a.sendMessage('BETA', '1');
    const e1 = (await ui.next('message')).payload.edge;
    expect(e1).toMatchObject({ weight: 1, sentByA: 1, sentByB: 0, lastMessageAt: h.clock.now() });
    h.clock.advance(DEFAULT_LIMITS.edgeTauMs);
    await b.sendMessage('ALPHA', '2');
    const e2 = (await ui.next('message')).payload.edge;
    expect(e2.weight).toBeCloseTo(1 / Math.E + 1, 10);
    expect(e2).toMatchObject({ sentByA: 1, sentByB: 1, updatedAt: h.clock.now(), lastMessageAt: h.clock.now() });
  });
});

describe('heartbeat', () => {
  it('pings every heartbeatIntervalMs and answers pings with pong', async () => {
    const h = await harness();
    const { shim } = await h.shim('host:a');
    shim.autoPong = false;
    h.clock.advance(DEFAULT_LIMITS.heartbeatIntervalMs);
    await shim.next('ping');
    const re = shim.send('ping', {});
    expect((await shim.next('pong', (f) => f.payload.re === re)).type).toBe('pong');
  });

  it('a shim that answers stays connected', async () => {
    const h = await harness();
    const { shim } = await h.shim('host:a');
    for (let i = 0; i < 8; i++) {
      h.clock.advance(DEFAULT_LIMITS.heartbeatIntervalMs);
      await shim.sync();
    }
    const { snapshot } = await h.ui();
    expect(snapshot.payload.nodes[0]?.connected).toBe(true);
  });

  it('marks a silent node disconnected after disconnectAfterMs and closes its socket', async () => {
    const h = await harness();
    const { ui } = await h.ui();
    const { shim } = await h.shim('host:a');
    shim.autoPong = false;
    const start = h.clock.now();
    h.clock.advance(DEFAULT_LIMITS.disconnectAfterMs - 1);
    await ui.sync();
    expect(ui.pending('node').some((f) => f.payload.op === 'upsert' && !f.payload.node.connected)).toBe(false);
    h.clock.advance(DEFAULT_LIMITS.heartbeatIntervalMs);
    const node = await ui.next('node', (f) => f.payload.op === 'upsert' && !f.payload.node.connected);
    expect(node.payload.op === 'upsert' && node.payload.node.lastSeen).toBe(start);
    expect((await shim.closed).code).toBe(CloseCodes.timeout);
    expect(h.logs.some((l) => l.includes('"heartbeat_timeout"'))).toBe(true);
  });
});

describe('snapshot equals replayed deltas', () => {
  it('a UI connected from the start ends with the same state as a fresh snapshot', async () => {
    const ring = 3;
    const h = await harness({ limits: { ...NO_HEARTBEAT, ringBufferPerThread: ring, offlineRetentionMs: 60_000 } });
    const { ui } = await h.ui();

    const { shim: a } = await h.shim('host:a', { defaultName: 'a@host' });
    await a.register('ALPHA', 'ui work', [{ key: 'github.com/acme/web', name: 'web' }]);
    const { shim: b } = await h.shim('host:b', { defaultName: 'b@host' });
    await b.register('ALPHA');
    const { shim: c } = await h.shim('host:c', { defaultName: 'c@host' });
    await c.register('GAMMA');

    for (let i = 0; i < 5; i++) {
      await a.sendMessage('ALPHA-2', `ab${i}`);
      h.clock.advance(7_000);
    }
    await b.sendMessage('ALPHA', 'ba');
    const delivered = (await b.next('deliver', (f) => f.payload.message.body === 'ab4')).payload.message;
    b.send('seen', { ids: [delivered.id] });
    await c.sendMessage('owner', 'to owner');
    const re = ui.send('owner_send', { to: 'host:c', kind: 'request', body: 'from owner', attachments: [] });
    await ui.next('sent', (f) => f.payload.re === re);
    a.send('status', { status: 'working', delivery: 'push' });
    ui.send('control', { action: 'mute_thread', threadId: 'host:a|host:c' });
    ui.send('control', { action: 'pause_session', sessionId: 'host:b' });
    await c.sendMessage('ALPHA', 'blocked by mute');
    h.clock.advance(30_000);

    // c disconnects and is removed after retention; b disconnects and an alias takes it over.
    await c.close();
    await a.next('peers', (f) => f.payload.peers.some((p) => p.id === 'host:c' && !p.connected));
    h.clock.advance(60_000);
    await a.next('peers', (f) => !f.payload.peers.some((p) => p.id === 'host:c'));
    await b.close();
    await a.next('peers', (f) => f.payload.peers.some((p) => p.id === 'host:b' && !p.connected));
    const { shim: b2 } = await h.shim('host:b2', { hostname: 'host' });
    const reg = await b2.register('ALPHA-2');
    expect(reg.payload.sessionId).toBe('host:b');
    expect((await b2.sendMessage('ALPHA', 'after alias')).type).toBe('rejected');
    expect((await b2.sendMessage('owner', 'paused reply to owner')).type).toBe('sent');
    h.clock.advance(12_345);
    await a.sync();
    await b2.sync();
    await ui.sync();

    const mirror = new UiStateMirror();
    for (const f of ui.frames) mirror.apply(f);
    const { snapshot } = await h.ui();
    const fresh = new UiStateMirror();
    fresh.apply(snapshot);
    const snap = snapshot.payload;
    expect(diffUiStates(mirror.state(), fresh.state(), snap.now)).toEqual([]);
    expect(snap.control).toEqual({ mutedThreads: ['host:a|host:c'], pausedSessions: ['host:b'], pausedAll: false });

    // The scenario covered what it set out to.
    expect(snap.messages.some((m) => m.seenAt !== undefined)).toBe(true);
    expect(snap.nodes.map((n) => n.id).sort()).toEqual(['host:a', 'host:b']);
    expect(snap.messages.filter((m) => m.threadId === 'host:a|host:b')).toHaveLength(ring);
    // A removed node's threads and buffered messages stay until the ring buffer drops them.
    expect(snap.messages.filter((m) => m.threadId === 'host:c|owner').map((m) => m.body)).toEqual(['to owner', 'from owner']);
    expect(snap.edges.some((e) => e.threadId === 'host:c|owner')).toBe(true);
    // The paused session could still reply to the Owner.
    expect(snap.messages.some((m) => m.body === 'paused reply to owner')).toBe(true);
  });
});

describe('logging', () => {
  it('never logs a message body or a token', async () => {
    const h = await harness({ limits: { maxBodyBytes: 64 } });
    const { ui } = await h.ui();
    const { shim: a } = await h.shim('host:a');
    await a.register('ALPHA');
    const { shim: b } = await h.shim('host:b');
    await b.register('BETA');
    const secret = 'BODY-SECRET-7f3a9c';
    await a.sendMessage('BETA', `${secret} delivered`);
    await a.sendMessage('owner', `${secret} to owner`);
    await a.sendMessage('BETA', `${secret} ${'x'.repeat(100)}`);
    await a.sendMessage('NOBODY', `${secret} unknown`);
    const re = ui.send('owner_send', { to: 'host:b', kind: 'chat', body: `${secret} owner`, attachments: [] });
    await ui.next('sent', (f) => f.payload.re === re);
    const { FakeShim, helloPayload } = await import('./helpers/fake.js');
    const intruder = await FakeShim.open(h.broker);
    intruder.send('hello', helloPayload(h.broker, { sessionId: 'host:x', token: 'TOKEN-SECRET-c0ffee' }));
    await intruder.closed;
    await b.sync();

    const all = h.logs.join('');
    expect(h.logs.length).toBeGreaterThan(5);
    for (const line of h.logs) expect(() => JSON.parse(line)).not.toThrow();
    expect(all).toContain('"rejected"');
    expect(all).toContain('"shim_connected"');
    expect(all).not.toContain(secret);
    expect(all).not.toContain('TOKEN-SECRET-c0ffee');
    expect(all).not.toContain(h.broker.shimToken);
    expect(all).not.toContain(h.broker.ownerToken);
  });
});
