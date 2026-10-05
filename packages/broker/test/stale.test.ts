/**
 * Stale-session retention: a disconnected node keeps its queue for
 * `offlineRetentionMs`, then stays inspectable (graph, peers, history, media)
 * until `staleRetentionMs` after it was last seen, then is purged with every
 * thread it took part in.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, type BrokerToUiFrame, type Limits, type RejectCode } from '@orchvis/protocol';
import { UiStateMirror, diffUiStates } from '@orchvis/simulator';
import {
  LIMIT_ENV_VARS,
  MAX_TIMER_DELAY_MS,
  ManualClock,
  loadConfig,
  resolveConfig,
  startBroker,
  type BrokerStats,
  type TimerHandle,
} from '../src/index.js';
import { FakeUi } from './helpers/fake.js';
import { dirFiles, png, shimCreds, uploadOk } from './helpers/media.js';
import { harness, type Harness } from './helpers/setup.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOUR = 3_600_000;
const OFFLINE = DEFAULT_LIMITS.offlineRetentionMs;
const STALE = DEFAULT_LIMITS.staleRetentionMs;

/**
 * No heartbeat within a 100 h jump (so the shims that stay are not timed
 * out), and media that outlives the jump (so the purge, not the TTL, deletes
 * it).
 */
const LONG: Partial<Limits> = { heartbeatIntervalMs: 200 * HOUR, disconnectAfterMs: 400 * HOUR, mediaTtlMs: 300 * HOUR };

function code(frame: { type: string; payload: unknown }): RejectCode | 'sent' {
  return frame.type === 'sent' ? 'sent' : (frame.payload as { code: RejectCode }).code;
}

/** Replays every frame the UI received and compares with a fresh snapshot. */
async function replayDiff(h: Harness, ui: FakeUi): Promise<string[]> {
  await ui.sync();
  const mirror = new UiStateMirror();
  for (const f of ui.frames) mirror.apply(f);
  const { ui: other, snapshot } = await h.ui();
  const fresh = new UiStateMirror();
  fresh.apply(snapshot);
  await other.close();
  return diffUiStates(mirror.state(), fresh.state(), snapshot.payload.now);
}

async function ownerSend(ui: FakeUi, to: string, body: string, attachments: string[] = []): Promise<RejectCode | 'sent'> {
  const re = ui.send('owner_send', { to, kind: 'chat', body, attachments });
  // The answer comes before the pong for a later ping.
  await ui.sync();
  const answer = ui.frames.find((f) => (f.type === 'sent' || f.type === 'rejected') && f.payload.re === re);
  if (!answer) throw new Error('no answer to owner_send');
  return code(answer);
}

/**
 * Waits until the broker has `connected` connected nodes, so a close has been
 * processed (and its retention timers armed) before the clock moves.
 */
async function settle(h: Harness, connected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (h.broker.stats().connectedNodes !== connected) {
    if (Date.now() > deadline) throw new Error(`still ${h.broker.stats().connectedNodes} connected nodes, expected ${connected}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Stats without the web app connection count, which the snapshot checks below change. */
function withoutUi(stats: BrokerStats): Omit<BrokerStats, 'uiLinks'> {
  const { uiLinks: _ui, ...rest } = stats;
  return rest;
}

describe('stale retention', () => {
  it('keeps a disconnected node inspectable until 100 h after it was last seen, then purges it and everything keyed by it', async () => {
    const h = await harness({ limits: LONG });
    const { ui } = await h.ui();
    const { shim: a } = await h.shim('host:a');
    await a.register('ALPHA');
    await ui.sync();
    const baseline = h.broker.stats();

    // b: registered once, disconnected, then taken over by an alias (host:b2 -> host:b).
    const { shim: b0 } = await h.shim('host:b');
    await b0.register('BETA');
    await b0.close();
    await settle(h, 1);
    await a.next('peers', (f) => f.payload.peers.some((p) => p.id === 'host:b' && !p.connected));
    const { shim: b, welcome: wb } = await h.shim('host:b2', { hostname: 'host' });
    expect((await b.register('BETA')).payload.sessionId).toBe('host:b');

    // Traffic on every kind of thread b has: with a, and with the Owner, with media and seen state.
    expect(code(await a.sendMessage('BETA', 'a to b'))).toBe('sent');
    const delivered = (await b.next('deliver')).payload.message;
    b.send('seen', { ids: [delivered.id] });
    const ref = await uploadOk(h.broker, shimCreds(h.broker, wb), png());
    expect(code(await b.sendMessage('ALPHA', 'b to a, with media', { attachments: [ref.mediaId] }))).toBe('sent');
    expect(code(await b.sendMessage('owner', 'b to owner'))).toBe('sent');
    expect(await ownerSend(ui, 'host:b', 'owner to b')).toBe('sent');
    ui.send('control', { action: 'mute_thread', threadId: 'host:a|host:b' });
    ui.send('control', { action: 'pause_session', sessionId: 'host:b' });
    await ui.next('control_state', (f) => f.payload.pausedSessions.length === 1);
    expect(dirFiles(h.broker)).toEqual([ref.mediaId]);
    expect(h.broker.stats()).toMatchObject({ nodes: 2, aliases: 1, threads: 2, mediaFiles: 1, mutedThreads: 1, pausedSessions: 1 });

    const seenAt = h.clock.now();
    await b.close();
    await settle(h, 1);

    // At 10 min the queue window has passed: recipient_gone, but the node, its peer entry and its history stay.
    h.clock.advance(OFFLINE);
    await a.sync();
    expect(h.broker.stats()).toMatchObject({ nodes: 2, expiredQueues: 1, queuedMessages: 0 });
    ui.send('control', { action: 'resume_session', sessionId: 'host:b' });
    ui.send('control', { action: 'unmute_thread', threadId: 'host:a|host:b' });
    await ui.next('control_state', (f) => f.payload.mutedThreads.length === 0);
    expect(code(await a.sendMessage('BETA', 'too late'))).toBe('recipient_gone');
    expect(code(await a.sendMessage('host:b2', 'too late, by alias'))).toBe('recipient_gone');
    expect(await ownerSend(ui, 'host:b', 'too late')).toBe('recipient_gone');
    const re = a.send('thread_request', { peer: 'BETA' });
    expect((await a.next('thread', (f) => f.payload.re === re)).payload.messages.map((m) => m.body)).toEqual(['a to b', 'b to a, with media']);
    // Put the controls back, so the purge has controls to drop.
    ui.send('control', { action: 'mute_thread', threadId: 'host:a|host:b' });
    ui.send('control', { action: 'pause_session', sessionId: 'host:b' });
    await ui.next('control_state', (f) => f.payload.pausedSessions.length === 1);

    // At 99 h, and 1 ms before 100 h, it is all still there.
    h.clock.advance(99 * HOUR - OFFLINE);
    await ui.sync();
    let snap = (await h.ui()).snapshot.payload;
    expect(snap.nodes.find((n) => n.id === 'host:b')).toMatchObject({ connected: false, name: 'BETA', lastSeen: seenAt });
    expect(snap.messages).toHaveLength(4);
    expect(snap.media).toHaveLength(1);
    h.clock.advance(STALE - 99 * HOUR - 1);
    await ui.sync();
    expect(ui.frames.some((f) => f.type === 'node' && f.payload.op === 'remove' && f.payload.id === 'host:b')).toBe(false);
    expect(h.clock.now()).toBe(seenAt + STALE - 1);

    // At 100 h after lastSeen: purged.
    h.clock.advance(1);
    await ui.next('node', (f) => f.payload.op === 'remove' && f.payload.id === 'host:b');
    await a.next('peers', (f) => f.payload.peers.length === 0);
    await ui.sync();
    snap = (await h.ui()).snapshot.payload;
    expect(snap.nodes.map((n) => n.id)).toEqual(['host:a']);
    expect(snap.messages).toEqual([]);
    expect(snap.edges).toEqual([]);
    expect(snap.media).toEqual([]);
    expect(snap.control).toEqual({ mutedThreads: [], pausedSessions: [], pausedAll: false });
    expect(snap.mediaStore).toMatchObject({ bytes: 0, files: 0 });
    expect(dirFiles(h.broker)).toEqual([]);
    expect(h.broker.mediaEntries()).toEqual([]);
    expect(h.logs.some((l) => l.includes('"node_purged"'))).toBe(true);

    // The purge was announced as: media expire (with the usage), node remove, control_state.
    const tail = ui.frames.slice(ui.frames.findIndex((f) => f.type === 'media' && f.payload.op === 'expire'));
    const kinds = tail.filter((f) => f.type !== 'pong').map((f) => (f.type === 'node' || f.type === 'media' ? `${f.type}:${f.payload.op}` : f.type));
    expect(kinds.slice(0, 3)).toEqual(['media:expire', 'node:remove', 'control_state']);
    const expire = tail[0] as Extract<BrokerToUiFrame, { type: 'media' }>;
    expect(expire.payload.mediaStore).toMatchObject({ bytes: 0, files: 0 });

    // Nothing keyed by the session is left: the broker is back to where it was before b existed.
    expect(withoutUi(h.broker.stats())).toEqual(withoutUi(baseline));
    // A send to it, by name, ID or alias, is now an unknown recipient.
    expect(code(await a.sendMessage('BETA', 'x'))).toBe('unknown_recipient');
    expect(code(await a.sendMessage('host:b', 'x'))).toBe('unknown_recipient');
    expect(code(await a.sendMessage('host:b2', 'x'))).toBe('unknown_recipient');
    expect(await ownerSend(ui, 'host:b', 'x')).toBe('unknown_recipient');

    // Snapshot equals replayed deltas across the purge.
    expect(await replayDiff(h, ui)).toEqual([]);

    // The same session ID coming back now is a brand-new node with no history.
    const { shim: b3, welcome } = await h.shim('host:b');
    expect(welcome.payload.name).toMatch(/^repo@host/);
    await b3.sync();
    expect(b3.frames.filter((f) => f.type === 'deliver')).toHaveLength(0);
  });

  it('a reconnect at 50 h resumes the same node with its history, and cancels both timers', async () => {
    const h = await harness({ limits: LONG });
    const { ui } = await h.ui();
    const { shim: a } = await h.shim('host:a');
    await a.register('ALPHA');
    const { shim: b } = await h.shim('host:b');
    await b.register('BETA');
    // c reconnects through register aliasing rather than with its own ID.
    const { shim: c } = await h.shim('host:c');
    await c.register('GAMMA');
    await a.sendMessage('BETA', 'before');
    await a.sendMessage('GAMMA', 'before');
    await b.close();
    await c.close();
    await settle(h, 1);
    await a.next('peers', (f) => f.payload.peers.length === 2 && f.payload.peers.every((p) => !p.connected));

    h.clock.advance(OFFLINE);
    await a.sync();
    expect(h.broker.stats().expiredQueues).toBe(2);
    h.clock.advance(50 * HOUR - OFFLINE);

    const { shim: b2, welcome } = await h.shim('host:b');
    expect(welcome.payload.name).toBe('BETA');
    const { shim: c2 } = await h.shim('host:c9', { hostname: 'host' });
    expect((await c2.register('GAMMA')).payload.sessionId).toBe('host:c');
    expect(h.broker.stats()).toMatchObject({ nodes: 3, expiredQueues: 0, connectedNodes: 3 });
    let re = b2.send('thread_request', { peer: 'ALPHA' });
    expect((await b2.next('thread', (f) => f.payload.re === re)).payload.messages.map((m) => m.body)).toEqual(['before']);
    re = c2.send('thread_request', { peer: 'ALPHA' });
    expect((await c2.next('thread', (f) => f.payload.re === re)).payload.messages.map((m) => m.body)).toEqual(['before']);
    expect(code(await a.sendMessage('BETA', 'after'))).toBe('sent');
    expect(code(await a.sendMessage('GAMMA', 'after'))).toBe('sent');

    // Well past 100 h from the original lastSeen: nothing is purged.
    h.clock.advance(60 * HOUR);
    await ui.sync();
    expect(ui.frames.some((f) => f.type === 'node' && f.payload.op === 'remove' && f.payload.id !== 'host:c9')).toBe(false);
    expect(h.broker.stats()).toMatchObject({ nodes: 3, connectedNodes: 3, threads: 2 });
    expect(code(await a.sendMessage('BETA', 'still here'))).toBe('sent');
    expect(await replayDiff(h, ui)).toEqual([]);
  });

  it('a purge deletes every media file on the purged threads, and only those', async () => {
    const h = await harness({ limits: LONG });
    const { ui } = await h.ui();
    const owner = { cookie: ui.cookie };
    const { shim: a, welcome: wa } = await h.shim('host:a');
    await a.register('ALPHA');
    const { shim: b, welcome: wb } = await h.shim('host:b');
    await b.register('BETA');

    const fromB = await uploadOk(h.broker, shimCreds(h.broker, wb), png());
    expect(code(await b.sendMessage('ALPHA', 'b to a', { attachments: [fromB.mediaId] }))).toBe('sent');
    const fromA = await uploadOk(h.broker, shimCreds(h.broker, wa), png());
    expect(code(await a.sendMessage('BETA', 'a to b', { attachments: [fromA.mediaId] }))).toBe('sent');
    const fromOwner = await uploadOk(h.broker, owner, png());
    expect(await ownerSend(ui, 'host:b', 'owner to b', [fromOwner.mediaId])).toBe('sent');
    const unattached = await uploadOk(h.broker, shimCreds(h.broker, wb), png());
    // Unrelated: a thread without b keeps its media.
    const kept = await uploadOk(h.broker, shimCreds(h.broker, wa), png());
    expect(code(await a.sendMessage('owner', 'a to owner', { attachments: [kept.mediaId] }))).toBe('sent');
    await ui.sync();
    expect(dirFiles(h.broker)).toHaveLength(5);

    await b.close();
    await settle(h, 1);
    h.clock.advance(STALE);
    await ui.next('node', (f) => f.payload.op === 'remove' && f.payload.id === 'host:b');
    await ui.sync();

    expect(dirFiles(h.broker)).toEqual([kept.mediaId]);
    expect(h.broker.mediaEntries().map((e) => e.mediaId)).toEqual([kept.mediaId]);
    const expired = ui.frames.flatMap((f) => (f.type === 'media' && f.payload.op === 'expire' ? [f.payload.mediaId] : []));
    expect(expired.sort()).toEqual([fromA.mediaId, fromB.mediaId, fromOwner.mediaId].sort());
    expect(expired).not.toContain(unattached.mediaId);
    const snap = (await h.ui()).snapshot.payload;
    expect(snap.media.map((m) => m.ref.mediaId)).toEqual([kept.mediaId]);
    expect(snap.mediaStore).toMatchObject({ files: 1, bytes: kept.bytes });
    expect(snap.edges.map((e) => e.threadId)).toEqual(['host:a|owner']);
    expect(await replayDiff(h, ui)).toEqual([]);
  });

  it('stats return to baseline after churn and purge', async () => {
    const h = await harness({ limits: LONG });
    const { ui } = await h.ui();
    const { shim: a } = await h.shim('host:a');
    await a.register('ALPHA');
    await ui.sync();
    const baseline = h.broker.stats();

    for (let i = 0; i < 12; i++) {
      const { shim: s, welcome } = await h.shim(`host:s${i}`);
      await s.register(`S${i}`);
      const ref = await uploadOk(h.broker, shimCreds(h.broker, welcome), png());
      expect(code(await s.sendMessage('ALPHA', `hi ${i}`, { attachments: [ref.mediaId] }))).toBe('sent');
      expect(code(await s.sendMessage('owner', `hi owner ${i}`))).toBe('sent');
      expect(code(await a.sendMessage(`S${i}`, `back ${i}`))).toBe('sent');
      // The previous session left an hour ago: past its queue window, still registered.
      if (i > 0) expect(code(await s.sendMessage(`S${i - 1}`, 'neighbour'))).toBe('recipient_gone');
      if (i % 3 === 0) ui.send('control', { action: 'mute_thread', threadId: `host:a|host:s${i}` });
      if (i % 4 === 0) ui.send('control', { action: 'pause_session', sessionId: `host:s${i}` });
      await s.close();
      await settle(h, 1);
      if (i % 2 === 0) {
        // Comes back under a new ID and is aliased onto the old node, then leaves again.
        const { shim: again } = await h.shim(`host:s${i}x`, { hostname: 'host' });
        expect((await again.register(`S${i}`)).payload.sessionId).toBe(`host:s${i}`);
        await again.close();
        await settle(h, 1);
      }
      h.clock.advance(HOUR);
    }
    await a.sync();
    await ui.sync();
    const busy = h.broker.stats();
    expect(busy.nodes).toBe(13);
    expect(busy.aliases).toBe(6);
    expect(busy.threads).toBe(24);
    expect(busy.mediaFiles).toBe(12);
    expect(busy.expiredQueues).toBe(12);

    h.clock.advance(STALE);
    await a.next('peers', (f) => f.payload.peers.length === 0);
    await ui.sync();
    expect(withoutUi(h.broker.stats())).toEqual(withoutUi(baseline));
    expect(dirFiles(h.broker)).toEqual([]);
    expect(await replayDiff(h, ui)).toEqual([]);
  });
});

describe('retention timers', () => {
  it('a retention beyond the Node timer limit is reached in steps, never fired early', async () => {
    const delays: number[] = [];
    class RecordingClock extends ManualClock {
      override setTimeout(fn: () => void, ms: number): TimerHandle {
        delays.push(ms);
        return super.setTimeout(fn, ms);
      }
    }
    const clock = new RecordingClock();
    const day = 24 * HOUR;
    const broker = await startBroker({
      port: 0,
      clock,
      logSink: () => {},
      config: { limits: { ...LONG, mediaTtlMs: 10 * 60_000, staleRetentionMs: 60 * day } },
    });
    try {
      const { FakeShim } = await import('./helpers/fake.js');
      const { shim } = await FakeShim.connect(broker, { sessionId: 'host:a' });
      await shim.close();
      const deadline = Date.now() + 5_000;
      while (broker.stats().connectedNodes > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(broker.stats().connectedNodes).toBe(0);
      clock.advance(59 * day);
      expect(broker.stats().nodes).toBe(1);
      clock.advance(day);
      expect(broker.stats().nodes).toBe(0);
      expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
    } finally {
      await broker.close();
    }
  });
});

describe('stale retention config', () => {
  it('is overridable by ORCHVIS_STALE_RETENTION_MS', () => {
    expect(LIMIT_ENV_VARS.staleRetentionMs).toBe('ORCHVIS_STALE_RETENTION_MS');
    expect(DEFAULT_LIMITS.staleRetentionMs).toBe(100 * HOUR);
    const dir = mkdtempSync(join(tmpdir(), 'orchvis-stale-'));
    try {
      const { config } = loadConfig({ path: join(dir, 'c.json'), env: { ORCHVIS_STALE_RETENTION_MS: String(5 * HOUR) } });
      expect(config.limits.staleRetentionMs).toBe(5 * HOUR);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects staleRetentionMs below offlineRetentionMs with a clear error', () => {
    expect(() => resolveConfig({ limits: { offlineRetentionMs: 2_000, staleRetentionMs: 1_000 } })).toThrow(
      /staleRetentionMs \(1000 ms, ORCHVIS_STALE_RETENTION_MS\) must be at least offlineRetentionMs \(2000 ms/,
    );
    expect(() => resolveConfig({ limits: { offlineRetentionMs: 2_000, staleRetentionMs: 2_000 } })).not.toThrow();
    const dir = mkdtempSync(join(tmpdir(), 'orchvis-stale-'));
    try {
      expect(() => loadConfig({ path: join(dir, 'c.json'), env: { ORCHVIS_STALE_RETENTION_MS: '60000' } })).toThrow(/ORCHVIS_STALE_RETENTION_MS/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
