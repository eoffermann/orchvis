import { OWNER_ADDRESS, PROTOCOL_VERSION, sessionAddress, threadIdFor, type BrokerToUiFrame } from '@orchvis/protocol';
import { describe, expect, it } from 'vitest';
import { FakeClock, MockWorld, UiStateMirror, diffUiStates, generateScenario, type UiDelta } from '../src/index.js';

const MIN = 60_000;

function asFrame(delta: UiDelta | { type: 'snapshot'; payload: ReturnType<MockWorld['snapshot']> }, ts: number, n: number): BrokerToUiFrame {
  return { v: PROTOCOL_VERSION, type: delta.type, id: `t${n}`, ts, payload: delta.payload } as BrokerToUiFrame;
}

describe('MockWorld stale retention', () => {
  it('keeps a retired session until staleRetentionMs after lastSeen, then purges it with its threads, media and controls', () => {
    const clock = new FakeClock();
    const stale = 30 * MIN;
    const world = new MockWorld({
      scenario: generateScenario({ sessions: 8, hosts: 2, repos: 2, seed: 11 }),
      clock,
      churnRate: 1,
      limits: { staleRetentionMs: stale, mediaTtlMs: 24 * 60 * MIN },
      traffic: { rate: 1, mediaRate: 0.2, disconnectMeanMs: 10 * MIN },
    });
    let n = 0;
    const mirror = new UiStateMirror();
    mirror.apply(asFrame({ type: 'snapshot', payload: world.snapshot() }, clock.now(), n++));

    const purges: { id: string; sinceLastSeen: number; mediaLeft: number; hadThreads: boolean }[] = [];
    const kinds: string[] = [];
    world.subscribe((d) => {
      kinds.push(d.type === 'node' || d.type === 'media' ? `${d.type}:${d.payload.op}` : d.type);
      if (d.type === 'node' && d.payload.op === 'remove') {
        const id = d.payload.id;
        const before = mirror.state();
        const node = before.nodes.find((x) => x.id === id);
        const involves = (t: string) => t.split('|').includes(id);
        purges.push({
          id,
          sinceLastSeen: clock.now() - (node?.lastSeen ?? Number.NaN),
          mediaLeft: before.media.filter((m) => involves(m.threadId)).length,
          hadThreads: before.edges.some((e) => involves(e.threadId)),
        });
      }
      mirror.apply(asFrame(d, clock.now(), n++));
    });

    // A control naming every original session's Owner thread, so purges have controls to drop.
    for (const id of world.sessionIds()) world.applyControl({ action: 'mute_thread', threadId: threadIdFor(sessionAddress(id), OWNER_ADDRESS) });
    world.start();

    let goneRejections = 0;
    for (let minute = 0; minute < 150; minute++) {
      clock.advance(MIN);
      if (minute % 5 !== 0) continue;
      for (const node of world.snapshot().nodes) {
        if (node.connected) continue;
        const r = world.ownerSend({ to: node.id, kind: 'chat', body: 'are you there?', attachments: [] });
        if (!r.ok) {
          expect(r.code).toBe('recipient_gone');
          goneRejections++;
        }
      }
      if (minute % 25 === 0) expect(diffUiStates(mirror.state(), fromSnapshot(world), clock.now())).toEqual([]);
    }
    world.stop();

    // Past their queue window, retired sessions were still shown and answered recipient_gone.
    expect(goneRejections).toBeGreaterThan(0);
    // Purges happened, each exactly staleRetentionMs after lastSeen, with media already expired by then.
    expect(purges.length).toBeGreaterThanOrEqual(2);
    expect(purges.some((p) => p.hadThreads)).toBe(true);
    for (const p of purges) {
      expect(p.sinceLastSeen).toBe(stale);
      expect(p.mediaLeft).toBe(0);
    }
    expect(kinds).toContain('media:expire');
    // The purge removed the mutes on its threads.
    const removeAt = kinds.indexOf('node:remove');
    expect(kinds[removeAt + 1]).toBe('control_state');

    // Nothing of a purged session is left, and the replayed state equals a fresh snapshot.
    const snap = world.snapshot();
    for (const { id } of purges) {
      const involves = (t: string) => t.split('|').includes(id);
      expect(snap.nodes.some((x) => x.id === id)).toBe(false);
      expect(snap.edges.some((e) => involves(e.threadId))).toBe(false);
      expect(snap.messages.some((m) => involves(m.threadId))).toBe(false);
      expect(snap.media.some((m) => involves(m.threadId))).toBe(false);
      expect(snap.control.mutedThreads.some(involves)).toBe(false);
    }
    expect(diffUiStates(mirror.state(), fromSnapshot(world), clock.now())).toEqual([]);
  }, 30_000);
});

function fromSnapshot(world: MockWorld): ReturnType<UiStateMirror['state']> {
  const fresh = new UiStateMirror();
  const snap = world.snapshot();
  fresh.apply({ v: PROTOCOL_VERSION, type: 'snapshot', id: 'fresh', ts: snap.now, payload: snap });
  return fresh.state();
}
