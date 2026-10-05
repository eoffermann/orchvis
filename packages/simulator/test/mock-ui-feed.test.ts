import { MediaRefSchema, PROTOCOL_VERSION, type BrokerToUiFrame } from '@orchvis/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { diffUiStates, FakeClock, startMockUiFeed, UiStateMirror, type MockUiFeed, type SnapshotPayload } from '../src/index.js';
import { connectUiClient, waitUntil, type UiClient } from './helpers.js';

const MIN = 60_000;

/** Differences between a mirror and a fresh snapshot. */
function diffAgainst(mirror: UiStateMirror, snap: SnapshotPayload): string[] {
  const fresh = new UiStateMirror();
  fresh.apply({ v: PROTOCOL_VERSION, type: 'snapshot', id: 'fresh', ts: snap.now, payload: snap });
  return diffUiStates(mirror.state(), fresh.state(), snap.now);
}

let feed: MockUiFeed | undefined;
const clients: UiClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await feed?.close();
  feed = undefined;
});

async function client(url: string): Promise<UiClient> {
  const c = await connectUiClient(url);
  clients.push(c);
  await c.next('snapshot');
  return c;
}

describe('mock /ws/ui feed', () => {
  it('runs 30 simulated minutes with 30 nodes: every frame valid, snapshot plus deltas equals a fresh snapshot', async () => {
    const clock = new FakeClock();
    feed = await startMockUiFeed({
      port: 0,
      clock,
      nodes: 30,
      seed: 1,
      // A short stale retention, so retired sessions are purged (node remove) within the run.
      limits: { mediaTtlMs: 5 * MIN, mediaStoreBytes: 200_000, staleRetentionMs: 12 * MIN },
      traffic: { mediaRate: 0.15, disconnectMeanMs: 8 * MIN },
      churnRate: 0.6,
      onProblem: (p) => {
        throw new Error(p);
      },
    });
    expect(feed.world.engine.pairs.length).toBe(60);
    const c = await client(feed.url);
    const f = feed;
    const caughtUp = () => waitUntil(() => c.raw.length === f.stats.framesSent, 20_000, 'client to catch up');

    const target = f.world.sessionIds()[3] as string;
    for (let minute = 0; minute < 30; minute++) {
      if (minute === 7) c.send(c.mk('control', { action: 'pause_session', sessionId: target }));
      if (minute === 9) c.send(c.mk('owner_send', { to: target, kind: 'request', body: 'status?', attachments: [] }));
      if (minute === 12) c.send(c.mk('control', { action: 'pause_all' }));
      if (minute === 14) c.send(c.mk('control', { action: 'resume_all' }));
      await clock.advanceAsync(MIN, 1000);
      if (minute % 10 === 9) {
        await caughtUp();
        expect(diffAgainst(c.mirror, f.world.snapshot())).toEqual([]);
      }
    }
    await caughtUp();

    expect(c.invalid).toEqual([]);
    expect(f.stats.invalidOutbound).toBe(0);
    expect(f.stats.invalidInbound).toBe(0);

    // A second client's fresh snapshot, over the wire, equals the first client's replayed state.
    const fresh = await client(f.url);
    const snap = fresh.frames[0] as Extract<BrokerToUiFrame, { type: 'snapshot' }>;
    expect(diffAgainst(c.mirror, snap.payload)).toEqual([]);

    // The run exercised every delta kind the web app must handle.
    const kinds = new Set(c.frames.map((x) => (x.type === 'node' || x.type === 'media' ? `${x.type}:${x.payload.op}` : x.type)));
    for (const k of ['snapshot', 'node:upsert', 'node:remove', 'message', 'seen', 'media:add', 'media:expire', 'control_state', 'sent', 'ping']) {
      expect(kinds, k).toContain(k);
    }
    expect(snap.payload.nodes.length).toBeGreaterThanOrEqual(28);
    expect(c.frames.filter((x) => x.type === 'message').length).toBeGreaterThan(500);
  }, 60_000);

  it('produces an identical frame sequence for the same seed and clock, and a different one for another seed', async () => {
    const run = async (seed: number) => {
      const clock = new FakeClock();
      const fd = await startMockUiFeed({ port: 0, clock, nodes: 12, seed, traffic: { rate: 2 } });
      const c = await connectUiClient(fd.url);
      await c.next('snapshot');
      await clock.advanceAsync(5 * MIN, 1000);
      await waitUntil(() => c.raw.length === fd.stats.framesSent);
      const raw = [...c.raw];
      await c.close();
      await fd.close();
      return raw;
    };
    const a = await run(42);
    const b = await run(42);
    const other = await run(43);
    expect(a.length).toBeGreaterThan(50);
    expect(b).toEqual(a);
    expect(other).not.toEqual(a);
  }, 30_000);

  it('answers owner_send with sent, echoes the message, and the target replies', async () => {
    const clock = new FakeClock();
    feed = await startMockUiFeed({ port: 0, clock, nodes: 6, seed: 3, traffic: { rate: 0, ownerRatePerHour: 0, statusMeanMs: 0, disconnectMeanMs: 0 } });
    const c = await client(feed.url);
    const to = feed.world.sessionIds()[2] as string;
    const req = c.mk('owner_send', { to, kind: 'request', body: 'What are you working on?', attachments: [] });
    c.send(req);
    const sent = await c.next('sent', (f) => f.payload.re === req.id);
    const echoed = await c.next('message', (f) => f.payload.message.id === sent.payload.messageId);
    expect(c.frames.indexOf(sent)).toBeLessThan(c.frames.indexOf(echoed));
    expect(echoed.payload.message).toMatchObject({ senderKind: 'owner', fromName: 'owner', from: { kind: 'owner' }, to: { kind: 'session', id: to } });
    expect(echoed.payload.edge).toMatchObject({ a: to, b: 'owner', sentByB: 1, sentByA: 0 });

    await clock.advanceAsync(2 * MIN, 1000);
    const reply = await c.next('message', (f) => f.payload.message.replyTo === sent.payload.messageId);
    expect(reply.payload.message).toMatchObject({ kind: 'response', senderKind: 'peer', to: { kind: 'owner' }, from: { kind: 'session', id: to } });
    const seen = await c.next('seen', (f) => f.payload.ids.includes(sent.payload.messageId));
    expect(seen.payload.by).toBe(to);

    const bad = c.mk('owner_send', { to: 'nohost:nobody', kind: 'chat', body: 'hi', attachments: [] });
    c.send(bad);
    const rejected = await c.next('rejected', (f) => f.payload.re === bad.id);
    expect(rejected.payload.code).toBe('unknown_recipient');
    expect(c.invalid).toEqual([]);
  });

  it('applies controls, broadcasts control_state, and blocks peer traffic but never the Owner', async () => {
    const clock = new FakeClock();
    feed = await startMockUiFeed({ port: 0, clock, nodes: 10, seed: 5, traffic: { rate: 6, ownerRatePerHour: 0 } });
    const c = await client(feed.url);
    const watcher = await client(feed.url);
    await clock.advanceAsync(3 * MIN, 1000);
    c.send(c.mk('control', { action: 'pause_all' }));
    const state = await watcher.next('control_state', (f) => f.payload.pausedAll);
    expect(state.payload).toEqual({ mutedThreads: [], pausedSessions: [], pausedAll: true });
    await waitUntil(() => c.frames.some((f) => f.type === 'control_state'));

    const before = c.frames.length;
    await clock.advanceAsync(5 * MIN, 1000);
    const to = feed.world.sessionIds()[0] as string;
    const req = c.mk('owner_send', { to, kind: 'chat', body: 'still there?', attachments: [] });
    c.send(req);
    await c.next('sent', (f) => f.payload.re === req.id);
    const peerToPeer = c.frames
      .slice(before)
      .filter((f) => f.type === 'message' && f.payload.message.to.kind === 'session' && f.payload.message.from.kind === 'session');
    expect(peerToPeer).toEqual([]);

    const threadId = feed.world.snapshot().edges.find((e) => e.b !== 'owner' && e.a !== 'owner')?.threadId as string;
    c.send(c.mk('control', { action: 'resume_all' }));
    c.send(c.mk('control', { action: 'mute_thread', threadId }));
    await c.next('control_state', (f) => f.payload.mutedThreads.includes(threadId));
    const mark = c.frames.length;
    await clock.advanceAsync(10 * MIN, 1000);
    const sync = c.mk('ping', {});
    c.send(sync);
    await c.next('pong', (f) => f.payload.re === sync.id);
    const after = c.frames.slice(mark).filter((f) => f.type === 'message');
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((f) => f.type === 'message' && f.payload.message.threadId === threadId)).toEqual([]);
  });

  it('serves Owner uploads, attaches them once only, and serves byte ranges', async () => {
    const clock = new FakeClock();
    feed = await startMockUiFeed({ port: 0, clock, nodes: 4, seed: 9, traffic: { rate: 0, ownerRatePerHour: 0 } });
    const c = await client(feed.url);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'shot.png');
    form.append('caption', 'A test image');
    const res = await fetch(`${feed.httpUrl}/api/media`, { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const ref = MediaRefSchema.parse(await res.json());
    expect(ref).toMatchObject({ mime: 'image/png', filename: 'shot.png', bytes: 10, caption: 'A test image' });

    const ranged = await fetch(`${feed.httpUrl}/api/media/${ref.mediaId}`, { headers: { range: 'bytes=0-3' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(png.slice(0, 4));

    const to = feed.world.sessionIds()[1] as string;
    const first = c.mk('owner_send', { to, kind: 'chat', body: 'see attached', attachments: [ref.mediaId] });
    c.send(first);
    await c.next('sent', (f) => f.payload.re === first.id);
    const added = await c.next('media', (f) => f.payload.op === 'add');
    expect(added.payload.op === 'add' && added.payload.entry.ref.mediaId).toBe(ref.mediaId);
    expect(added.payload.edge.media.image).toBe(1);

    const again = c.mk('owner_send', { to, kind: 'chat', body: 'again', attachments: [ref.mediaId] });
    c.send(again);
    const rejected = await c.next('rejected', (f) => f.payload.re === again.id);
    expect(rejected.payload.code).toBe('invalid');
  });

  it('rejects an invalid inbound frame without dropping the connection', async () => {
    feed = await startMockUiFeed({ port: 0, clock: new FakeClock(), nodes: 3, onProblem: () => {} });
    const c = await client(feed.url);
    const ping = c.mk('ping', {});
    (c as unknown as { send(x: unknown): void }).send({ v: PROTOCOL_VERSION, type: 'owner_send', id: 'bad1', ts: 0, payload: { to: 'x' } });
    const rej = await c.next('rejected', (f) => f.payload.re === 'bad1');
    expect(rej.payload.code).toBe('invalid');
    c.send(ping);
    await c.next('pong', (f) => f.payload.re === ping.id);
  });
});
