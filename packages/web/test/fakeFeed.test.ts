import {
  BrokerToUiFrameSchema,
  MessageSchema,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  type BrokerToUiFrame,
  type UiToBrokerFrame,
} from '@orchvis/protocol';
import { describe, expect, it } from 'vitest';
import { FakeBroker, fakeUlid, seededRandom } from '../src/dev/fakeFeed';
import { initialState, reducer } from '../src/store/reducer';
import { buildGraphModel } from '../src/graph/model';

const T0 = 1_760_000_000_000;

function expectValid(frame: BrokerToUiFrame): void {
  const parsed = BrokerToUiFrameSchema.safeParse(frame);
  if (!parsed.success) {
    throw new Error(`invalid ${frame.type} frame: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  // And through the same text path the app uses.
  const decoded = decodeFrame(BrokerToUiFrameSchema, encodeFrame(frame));
  expect(decoded.ok).toBe(true);
}

describe('fakeUlid', () => {
  it('produces valid, time-ordered ULIDs', () => {
    const r = seededRandom(1);
    const a = fakeUlid(T0, r);
    const b = fakeUlid(T0 + 1, r);
    expect(MessageSchema.shape.id.safeParse(a).success).toBe(true);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });
});

describe('FakeBroker', () => {
  it('emits a schema-valid snapshot of ~30 sessions across several repos and hosts', () => {
    const fb = new FakeBroker({ seed: 42, now: T0 });
    const snap = fb.snapshot(T0);
    expectValid(snap);
    if (snap.type !== 'snapshot') throw new Error('expected snapshot');
    expect(snap.payload.nodes).toHaveLength(30);
    expect(new Set(snap.payload.nodes.map((n) => n.hostname)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(snap.payload.nodes.flatMap((n) => n.repos.map((r) => r.key))).size).toBeGreaterThanOrEqual(4);
    expect(snap.payload.nodes.some((n) => n.repos.length > 1)).toBe(true);
    expect(snap.payload.nodes.some((n) => n.delivery === 'poll')).toBe(true);
    expect(snap.payload.nodes.some((n) => !n.connected)).toBe(true);
    expect(snap.payload.messages.length).toBeGreaterThan(50);
    for (const m of snap.payload.messages) expect((m as { fromName?: string }).fromName).toBeTruthy();
  });

  it('emits only schema-valid deltas over a long random run, and the store accepts them', () => {
    const fb = new FakeBroker({ seed: 7, now: T0 });
    let state = reducer(initialState(T0), { type: 'connection', status: 'open' });
    const snap = fb.snapshot(T0);
    expectValid(snap);
    state = reducer(state, { type: 'frame', frame: snap, receivedAt: T0 });
    const seenTypes = new Set<string>();
    let t = T0;
    for (let i = 0; i < 3000; i++) {
      t += 250;
      for (const f of fb.step(t)) {
        expectValid(f);
        seenTypes.add(f.type === 'media' || f.type === 'node' ? `${f.type}:${f.payload.op}` : f.type);
        state = reducer(state, { type: 'frame', frame: f, receivedAt: t });
      }
    }
    for (const type of ['message', 'seen', 'node:upsert', 'media:add', 'media:expire']) expect(seenTypes).toContain(type);
    // The store's view of the world equals a fresh snapshot of the fake broker.
    const fresh = reducer(reducer(initialState(T0), { type: 'connection', status: 'open' }), {
      type: 'frame',
      frame: fb.snapshot(t),
      receivedAt: t,
    });
    expect(Object.keys(state.data.nodes).sort()).toEqual(Object.keys(fresh.data.nodes).sort());
    expect(state.data.edges).toEqual(fresh.data.edges);
    expect(Object.keys(state.data.media).sort()).toEqual(Object.keys(fresh.data.media).sort());
    expect(state.data.mediaStore).toEqual(fresh.data.mediaStore);
    expect(buildGraphModel(state).edges.length).toBeGreaterThan(10);
  });

  it('answers controls, pings and Owner sends with valid frames', () => {
    const fb = new FakeBroker({ seed: 3, now: T0 });
    const snap = fb.snapshot(T0);
    if (snap.type !== 'snapshot') throw new Error('expected snapshot');
    const target = snap.payload.nodes[0]!.id;
    const mk = createFrameFactory<UiToBrokerFrame>('u');
    const out = [
      ...fb.handle(encodeFrame(mk('control', { action: 'pause_all' })), T0 + 1),
      ...fb.handle(encodeFrame(mk('ping', {})), T0 + 2),
      ...fb.handle(
        encodeFrame(mk('owner_send', { to: target, kind: 'chat', body: 'hi <b>there</b>', attachments: [] })),
        T0 + 3,
      ),
      ...fb.handle('{not json', T0 + 4),
    ];
    for (const f of out) expectValid(f);
    expect(out.map((f) => f.type)).toEqual(['control_state', 'pong', 'sent', 'message', 'rejected']);
    // Paused: only Owner traffic flows. Pause never blocks messages to or from
    // the Owner, so the target's reply to the Owner is allowed.
    for (let i = 0; i < 200; i++) {
      for (const f of fb.step(T0 + 10 + i)) {
        if (f.type !== 'message') continue;
        const { from, to } = f.payload.message;
        expect(from.kind === 'owner' || to.kind === 'owner').toBe(true);
      }
    }
  });
});
