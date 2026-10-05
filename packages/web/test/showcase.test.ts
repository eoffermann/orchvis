import { BrokerToUiFrameSchema, createFrameFactory, decodeFrame, encodeFrame, mediaKindOf, type BrokerToUiFrame, type UiToBrokerFrame } from '@orchvis/protocol';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShowcaseBroker, showcaseMediaFile } from '../src/dev/showcase';
import { buildGraphModel } from '../src/graph/model';
import { initialState, reducer } from '../src/store/reducer';

const T0 = 1_760_000_000_000;
const MEDIA_DIR = join(__dirname, '..', 'src', 'dev', 'showcase-media');

function expectValid(frame: BrokerToUiFrame): void {
  const parsed = BrokerToUiFrameSchema.safeParse(frame);
  if (!parsed.success) {
    throw new Error(`invalid ${frame.type} frame: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  expect(decodeFrame(BrokerToUiFrameSchema, encodeFrame(frame)).ok).toBe(true);
}

function snapshotOf(sb: ShowcaseBroker) {
  const snap = sb.snapshot(T0);
  expectValid(snap);
  if (snap.type !== 'snapshot') throw new Error('expected snapshot');
  return snap.payload;
}

describe('ShowcaseBroker', () => {
  it('emits a schema-valid snapshot with the curated cast and story', () => {
    const p = snapshotOf(new ShowcaseBroker({ now: T0 }));
    expect(p.nodes.length).toBeGreaterThanOrEqual(28);
    expect(new Set(p.nodes.map((n) => n.platform))).toEqual(new Set(['win32', 'darwin', 'linux']));
    expect(new Set(p.nodes.flatMap((n) => n.repos.map((r) => r.key))).size).toBeGreaterThanOrEqual(4);
    expect(p.nodes.filter((n) => n.repos.length > 1).length).toBeGreaterThanOrEqual(1);
    expect(p.nodes.some((n) => n.delivery === 'poll')).toBe(true);
    expect(p.nodes.filter((n) => !n.connected)).toHaveLength(1);
    expect(new Set(p.nodes.map((n) => n.status))).toEqual(new Set(['working', 'idle', 'blocked']));
    // Owner conversations, every message kind, and both seen and unseen messages.
    expect(p.messages.some((m) => m.senderKind === 'owner')).toBe(true);
    expect(new Set(p.messages.map((m) => m.kind))).toEqual(new Set(['chat', 'request', 'response', 'notice']));
    expect(p.messages.some((m) => m.seenAt !== undefined)).toBe(true);
    expect(p.messages.some((m) => m.to.kind === 'session' && m.seenAt === undefined)).toBe(true);
    // Image, audio and video media, each backed by a bundled file.
    expect(new Set(p.media.map((m) => mediaKindOf(m.ref.mime)))).toEqual(new Set(['image', 'audio', 'video']));
    for (const m of p.media) {
      const file = showcaseMediaFile(m.ref.mediaId);
      expect(file).toBeTruthy();
      expect(existsSync(join(MEDIA_DIR, file as string))).toBe(true);
      expect(m.ref.expiresAt).toBeGreaterThan(T0);
    }
    // One attachment has expired: it is on a message but not in the media index.
    const listed = new Set(p.media.map((m) => m.ref.mediaId));
    const expired = p.messages.flatMap((m) => m.attachments).filter((a) => !listed.has(a.mediaId));
    expect(expired).toHaveLength(1);
    expect(expired[0]!.expiresAt).toBeLessThanOrEqual(T0);
  });

  it('is deterministic for a given time and seed', () => {
    const a = new ShowcaseBroker({ now: T0 }).snapshot(T0);
    const b = new ShowcaseBroker({ now: T0 }).snapshot(T0);
    expect(encodeFrame(a)).toEqual(encodeFrame(b));
  });

  it('keeps live traffic flowing with valid deltas the store accepts, away from the quiet threads', () => {
    const sb = new ShowcaseBroker({ now: T0 });
    let state = reducer(initialState(T0), { type: 'connection', status: 'open' });
    state = reducer(state, { type: 'frame', frame: sb.snapshot(T0), receivedAt: T0 });
    let t = T0;
    let peerMessages = 0;
    for (let i = 0; i < 2000; i++) {
      t += 250;
      for (const f of sb.step(t)) {
        expectValid(f);
        if (f.type === 'message') {
          peerMessages++;
          expect(sb.quietThreads.has(f.payload.message.threadId)).toBe(false);
        }
        state = reducer(state, { type: 'frame', frame: f, receivedAt: t });
      }
    }
    expect(peerMessages).toBeGreaterThan(1500);
    const model = buildGraphModel(state);
    expect(model.groups.length).toBeGreaterThanOrEqual(4);
    expect(model.edges.length).toBeGreaterThan(25);
  });

  it('answers pings, controls and Owner sends, with a canned reply later', () => {
    const sb = new ShowcaseBroker({ now: T0 });
    const target = snapshotOf(sb).nodes.find((n) => n.connected && n.delivery === 'push')!.id;
    const mk = createFrameFactory<UiToBrokerFrame>('u');
    const out = [
      ...sb.handle(encodeFrame(mk('ping', {})), T0 + 1),
      ...sb.handle(encodeFrame(mk('control', { action: 'pause_all' })), T0 + 2),
      ...sb.handle(encodeFrame(mk('owner_send', { to: target, kind: 'chat', body: 'status?', attachments: [] })), T0 + 3),
      ...sb.handle('{nope', T0 + 4),
    ];
    for (const f of out) expectValid(f);
    expect(out.map((f) => f.type)).toEqual(['pong', 'control_state', 'sent', 'message', 'rejected']);
    // Paused: no peer traffic, but the reply to the Owner still arrives.
    const later = sb.step(T0 + 10_000);
    for (const f of later) expectValid(f);
    expect(later.map((f) => f.type)).toEqual(['message']);
    const reply = later[0];
    if (reply?.type !== 'message') throw new Error('expected message');
    expect(reply.payload.message.to.kind).toBe('owner');
  });
});
