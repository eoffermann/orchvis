import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '@orchvis/protocol';
import { WS_CLOSE } from '@orchvis/protocol';
import { FakeShim, helloPayload } from './helpers/fake.js';
import { harness } from './helpers/setup.js';

describe('/ws/shim hello', () => {
  it('rejects a bad token with unauthorized and closes', async () => {
    const h = await harness();
    const shim = await FakeShim.open(h.broker);
    shim.send('hello', helloPayload(h.broker, { sessionId: 'host:1', token: 'wrong-token' }));
    const rej = await shim.next('rejected');
    expect(rej.payload.code).toBe('unauthorized');
    expect((await shim.closed).code).toBe(WS_CLOSE.helloRejected);
  });

  it('rejects a non-hello first frame as invalid and closes', async () => {
    const h = await harness();
    const shim = await FakeShim.open(h.broker);
    const id = shim.send('ping', {});
    const rej = await shim.next('rejected');
    expect(rej.payload).toMatchObject({ re: id, code: 'invalid' });
    expect((await shim.closed).code).toBe(WS_CLOSE.helloRejected);
  });

  it('rejects malformed JSON as the first frame', async () => {
    const h = await harness();
    const shim = await FakeShim.open(h.broker);
    shim.sendRaw('{not json');
    expect((await shim.next('rejected')).payload.code).toBe('invalid');
    await shim.closed;
  });

  it('closes a connection that never says hello', async () => {
    const h = await harness();
    const shim = await FakeShim.open(h.broker);
    h.clock.advance(DEFAULT_LIMITS.disconnectAfterMs);
    expect((await shim.closed).code).toBe(WS_CLOSE.helloRejected);
  });

  it('gives every connection its own upload key, rotated on reconnect', async () => {
    const h = await harness();
    const { welcome: a } = await h.shim('host:1');
    const { welcome: b } = await h.shim('host:2');
    expect(a.payload.uploadKey.length).toBeGreaterThanOrEqual(16);
    expect(a.payload.uploadKey).not.toBe(b.payload.uploadKey);
    const { welcome: again } = await h.shim('host:1');
    expect(again.payload.uploadKey).not.toBe(a.payload.uploadKey);
  });

  it('welcomes with the default name, the limits and the peers', async () => {
    const h = await harness({ limits: { maxBodyBytes: 1234 } });
    const { welcome: w1 } = await h.shim('host:1', { defaultName: 'alpha@host' });
    expect(w1.payload).toMatchObject({ sessionId: 'host:1', name: 'alpha@host', peers: [] });
    expect(w1.payload.limits.maxBodyBytes).toBe(1234);
    const { welcome: w2 } = await h.shim('host:2', { defaultName: 'beta@host' });
    expect(w2.payload.peers.map((p) => p.id)).toEqual(['host:1']);
    expect(w2.payload.peers[0]).not.toHaveProperty('cwd');
  });

  it('rejects a second hello on the same connection', async () => {
    const h = await harness();
    const { shim } = await h.shim('host:1');
    const re = shim.send('hello', helloPayload(h.broker, { sessionId: 'host:9' }));
    expect((await shim.next('rejected')).payload).toMatchObject({ re, code: 'invalid' });
  });
});

describe('registry', () => {
  it('makes taken names unique with -2, -3', async () => {
    const h = await harness();
    const { shim: a } = await h.shim('host:1');
    const { shim: b } = await h.shim('host:2');
    const { shim: c } = await h.shim('host:3');
    expect((await a.register('ORCH')).payload.name).toBe('ORCH');
    expect((await b.register('orch')).payload.name).toBe('orch-2');
    expect((await c.register('ORCH')).payload.name).toBe('ORCH-3');
    // Re-registering one's own name keeps it.
    expect((await a.register('ORCH', 'new focus')).payload.name).toBe('ORCH');
  });

  it('makes taken default names unique too', async () => {
    const h = await harness();
    const { welcome: w1 } = await h.shim('host:1', { defaultName: 'repo@host' });
    const { welcome: w2 } = await h.shim('host:2', { defaultName: 'repo@host' });
    expect([w1.payload.name, w2.payload.name]).toEqual(['repo@host', 'repo@host-2']);
  });

  it('a hello with a known session ID from a new cwd updates the node in place', async () => {
    const h = await harness();
    const { ui } = await h.ui();
    const { shim } = await h.shim('host:1', { cwd: 'C:/one', repos: [{ key: 'github.com/a/one', name: 'one' }] });
    await shim.register('WORKER', 'focus', [{ key: 'github.com/a/extra', name: 'extra' }]);
    await shim.close();
    const { welcome } = await h.shim('host:1', { cwd: 'D:/two', platform: 'darwin', repos: [{ key: 'github.com/a/two', name: 'two' }] });
    expect(welcome.payload.name).toBe('WORKER');
    await ui.sync();
    const { snapshot } = await h.ui();
    expect(snapshot.payload.nodes).toHaveLength(1);
    const node = snapshot.payload.nodes[0];
    expect(node).toMatchObject({ id: 'host:1', cwd: 'D:/two', platform: 'darwin', name: 'WORKER', connected: true });
    expect(node?.repos.map((r) => r.key).sort()).toEqual(['github.com/a/extra', 'github.com/a/two']);
  });

  it('a second connection for the same session replaces the first', async () => {
    const h = await harness();
    const { shim: first } = await h.shim('host:1');
    const { shim: second } = await h.shim('host:1');
    expect((await first.closed).code).toBe(WS_CLOSE.replaced);
    await second.sync();
    const { snapshot } = await h.ui();
    expect(snapshot.payload.nodes).toEqual([expect.objectContaining({ id: 'host:1', connected: true })]);
  });

  it('broadcasts peers (minus the recipient) on every node change', async () => {
    const h = await harness();
    const { shim: a } = await h.shim('host:1');
    await h.shim('host:2');
    const peers = await a.next('peers', (f) => f.payload.peers.some((p) => p.id === 'host:2'));
    expect(peers.payload.peers.map((p) => p.id)).toEqual(['host:2']);
  });
});

describe('aliasing on register', () => {
  it('keeps the old disconnected ID canonical and aliases the new one to it', async () => {
    const h = await harness();
    const { shim: peer } = await h.shim('host:peer');
    await peer.register('PEER');
    const { shim: old } = await h.shim('host:old', { defaultName: 'old@host' });
    await old.register('WORKER');
    expect((await peer.sendMessage('WORKER', 'before')).type).toBe('sent');
    await old.next('deliver');
    await old.close();

    const { ui, snapshot: before } = await h.ui();
    expect(before.payload.nodes.find((n) => n.id === 'host:old')?.connected).toBe(false);

    const { shim: fresh, welcome } = await h.shim('host:new', { defaultName: 'new@host' });
    expect(welcome.payload.sessionId).toBe('host:new');
    const reg = await fresh.register('WORKER', 'resumed');
    expect(reg.payload).toMatchObject({ sessionId: 'host:old', name: 'WORKER' });

    // The UI sees the new ID removed and the old one upserted, connected.
    await ui.next('node', (f) => f.payload.op === 'remove' && f.payload.id === 'host:new');
    await ui.next('node', (f) => f.payload.op === 'upsert' && f.payload.node.id === 'host:old' && f.payload.node.connected);

    // Messages keep flowing on the old thread ID, by name and by either ID.
    const s1 = await peer.sendMessage('WORKER', 'by name');
    const s2 = await peer.sendMessage('host:new', 'by alias');
    expect(s1.type === 'sent' && s1.payload.threadId).toBe('host:old|host:peer');
    expect(s2.type === 'sent' && s2.payload.threadId).toBe('host:old|host:peer');
    const d = await fresh.next('deliver', (f) => f.payload.message.body === 'by alias');
    expect(d.payload.message.to).toEqual({ kind: 'session', id: 'host:old' });

    // Messages the new connection sends come from the canonical ID.
    const back = await fresh.sendMessage('PEER', 'reply');
    expect(back.type === 'sent' && back.payload.threadId).toBe('host:old|host:peer');
    expect((await peer.next('deliver', (f) => f.payload.message.body === 'reply')).payload.message.from).toEqual({
      kind: 'session',
      id: 'host:old',
    });

    // A later hello with the aliased ID resolves to the canonical one.
    await fresh.close();
    const { welcome: again } = await h.shim('host:new');
    expect(again.payload).toMatchObject({ sessionId: 'host:old', name: 'WORKER' });
    const { snapshot } = await h.ui();
    expect(snapshot.payload.nodes.map((n) => n.id).sort()).toEqual(['host:old', 'host:peer']);
    expect(snapshot.payload.edges.map((e) => e.threadId)).toEqual(['host:old|host:peer']);
  });

  it('never aliases over a connected node; the name gets a suffix instead', async () => {
    const h = await harness();
    const { shim: a } = await h.shim('host:a');
    await a.register('WORKER');
    const { shim: b } = await h.shim('host:b');
    expect((await b.register('WORKER')).payload).toMatchObject({ sessionId: 'host:b', name: 'WORKER-2' });
  });

  it('does not alias across hostnames', async () => {
    const h = await harness();
    const { shim: a } = await h.shim('one:a');
    await a.register('WORKER');
    await a.close();
    const { shim: b } = await h.shim('two:b');
    expect((await b.register('WORKER')).payload).toMatchObject({ sessionId: 'two:b', name: 'WORKER-2' });
  });

  it('redelivers unseen buffered messages to the canonical session after aliasing', async () => {
    const h = await harness();
    const { shim: peer } = await h.shim('host:peer');
    await peer.register('PEER');
    const { shim: old } = await h.shim('host:old');
    await old.register('WORKER');
    await old.close();
    await peer.sendMessage('WORKER', 'queued 1');
    await peer.sendMessage('WORKER', 'queued 2');
    const { shim: fresh } = await h.shim('host:new');
    await fresh.register('WORKER');
    expect((await fresh.next('deliver')).payload.message.body).toBe('queued 1');
    expect((await fresh.next('deliver')).payload.message.body).toBe('queued 2');
  });
});
