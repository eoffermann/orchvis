import { BrokerToUiFrameSchema, DEFAULT_LIMITS, type BrokerToUiFrame } from '@orchvis/protocol';
import { describe, expect, it } from 'vitest';
import { initialState, reducer, type Action } from '../src/store/reducer';
import { createStore } from '../src/store/store';
import type { AppState } from '../src/store/types';
import { T0, edge, frames, mediaEntry, message, node, snapshotFrame } from './fixtures';

const A = 'alpha:1';
const B = 'beta:2';
const C = 'gamma:3';

function run(actions: Action[], start: AppState = initialState(T0)): AppState {
  return actions.reduce(reducer, start);
}

function frame(f: BrokerToUiFrame, receivedAt = T0): Action {
  // Every fixture frame must itself be valid on the wire.
  expect(BrokerToUiFrameSchema.safeParse(f).success).toBe(true);
  return { type: 'frame', frame: f, receivedAt };
}

const open: Action = { type: 'connection', status: 'open' };

describe('reducer: snapshot then deltas', () => {
  it('applies a snapshot and every delta kind to the expected state', () => {
    const mk = frames();
    const m1 = message(A, B, T0 - 1000);
    const m2 = message(B, A, T0 + 10);
    const m3 = message(A, B, T0 + 20, { attachments: [mediaEntry(message(A, B), 'm1').ref] });
    const e1 = edge(A, B, 1);
    const e2 = edge(A, B, 2, { sentByB: 1 });
    const e3 = edge(A, B, 3, { sentByA: 2, sentByB: 1, media: { image: 1, audio: 0, video: 0, other: 0 } });
    const entry = { ...mediaEntry(m3, 'm1'), messageId: m3.id };
    const store = { bytes: 1000, capBytes: DEFAULT_LIMITS.mediaStoreBytes, files: 1 };
    // A variable, not a literal, so it type-checks with and without `seenAt` in the contract.
    const seenPayload = { by: B, ids: [m1.id, m3.id], seenAt: T0 + 30 };

    const state = run([
      open,
      frame(snapshotFrame(mk, { nodes: [node(A), node(B)], edges: [e1], messages: [m1] }), T0 - 500),
      frame(mk('node', { op: 'upsert', node: node(C, { status: 'working' }) })),
      frame(mk('node', { op: 'upsert', node: node(B, { status: 'blocked' }) })),
      frame(mk('message', { message: m2, edge: e2 })),
      frame(mk('message', { message: m3, edge: e3 })),
      frame(mk('media', { op: 'add', entry, edge: e3, mediaStore: store })),
      frame(mk('seen', seenPayload)),
      frame(mk('control_state', { mutedThreads: [e1.threadId], pausedSessions: [], pausedAll: true })),
      frame(mk('node', { op: 'remove', id: C })),
    ]);

    expect(state.synced).toBe(true);
    expect(state.clockOffsetMs).toBe(500);
    expect(Object.keys(state.data.nodes).sort()).toEqual([A, B]);
    expect(state.data.nodes[B]?.status).toBe('blocked');
    expect(state.data.edges[e1.threadId]).toEqual(e3);
    const thread = state.data.messages[e1.threadId] ?? [];
    expect(thread.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
    expect(thread.map((m) => m.seenAt)).toEqual([T0 + 30, undefined, T0 + 30]);
    expect(Object.keys(state.data.media)).toEqual(['m1']);
    expect(state.data.mediaStore).toEqual(store);
    expect(state.data.control.pausedAll).toBe(true);
    expect(state.data.control.mutedThreads).toEqual([e1.threadId]);
  });

  it('node remove purges the node and its threads, so state equals a fresh snapshot without them', () => {
    const mk = frames();
    const ab = message(A, B, T0 - 300);
    const ac = message(A, C, T0 - 200);
    const acMedia = message(C, A, T0 - 100);
    const entry = { ...mediaEntry(acMedia, 'mc'), messageId: acMedia.id };
    const acWithAttachment = { ...acMedia, attachments: [entry.ref] };
    const eAB = edge(A, B, 1);
    const eAC = edge(A, C, 2, { media: { image: 1, audio: 0, video: 0, other: 0 } });
    const control = { mutedThreads: [eAC.threadId, eAB.threadId], pausedSessions: [C, B], pausedAll: false };
    const usage = { bytes: 10, capBytes: 100, files: 1 };

    const purged = run([
      open,
      frame(
        snapshotFrame(mk, {
          nodes: [node(A), node(B), node(C)],
          edges: [eAB, eAC],
          messages: [ab, ac, acWithAttachment],
          media: [entry],
          control,
          mediaStore: usage,
        }),
      ),
      { type: 'select', selection: { kind: 'edge', threadId: eAC.threadId } },
      frame(mk('node', { op: 'remove', id: C })),
    ]);

    const fresh = run([
      open,
      frame(
        snapshotFrame(frames(), {
          nodes: [node(A), node(B)],
          edges: [eAB],
          messages: [ab],
          control: { mutedThreads: [eAB.threadId], pausedSessions: [B], pausedAll: false },
          mediaStore: usage,
        }),
      ),
    ]);
    expect(purged.data).toEqual(fresh.data);
    expect(purged.view.selection).toBeNull();
  });

  it('removes expired media and updates the edge counts', () => {
    const mk = frames();
    const m = message(A, B);
    const entry = mediaEntry(m, 'm9');
    const withMedia = edge(A, B, 1, { media: { image: 1, audio: 0, video: 0, other: 0 } });
    const afterExpire = edge(A, B, 1);
    const usage = { bytes: 0, capBytes: 10, files: 0 };
    const state = run([
      open,
      frame(snapshotFrame(mk, { nodes: [node(A), node(B)], edges: [withMedia], messages: [m], media: [entry] })),
      frame(mk('media', { op: 'expire', mediaId: 'm9', threadId: m.threadId, edge: afterExpire, mediaStore: usage })),
    ]);
    expect(state.data.media).toEqual({});
    expect(state.data.edges[m.threadId]?.media.image).toBe(0);
    expect(state.data.mediaStore).toEqual(usage);
  });

  it('ignores a duplicate message delta', () => {
    const mk = frames();
    const m = message(A, B);
    const state = run([
      open,
      frame(snapshotFrame(mk, { nodes: [node(A), node(B)], edges: [edge(A, B)], messages: [m] })),
      frame(mk('message', { message: m, edge: edge(A, B, 1) })),
    ]);
    expect(state.data.messages[m.threadId]).toHaveLength(1);
  });

  it('caps each thread at the ring buffer size', () => {
    const mk = frames();
    const snap = snapshotFrame(mk, { nodes: [node(A), node(B)] });
    if (snap.type !== 'snapshot') throw new Error('unreachable');
    snap.payload.limits = { ...snap.payload.limits, ringBufferPerThread: 3 };
    const msgs = Array.from({ length: 5 }, (_, i) => message(A, B, T0 + i));
    const state = run([open, frame(snap), ...msgs.map((m) => frame(mk('message', { message: m, edge: edge(A, B) })))]);
    const kept = state.data.messages[msgs[0]!.threadId] ?? [];
    expect(kept.map((m) => m.id)).toEqual(msgs.slice(2).map((m) => m.id));
    expect(Object.keys(state.data.messageThread)).toHaveLength(3);
  });

  it('drops deltas that arrive before the snapshot', () => {
    const mk = frames();
    const state = run([open, frame(mk('node', { op: 'upsert', node: node(A) }))]);
    expect(state.data.nodes).toEqual({});
    expect(state.synced).toBe(false);
  });

  it('keeps the broker clock offset on tick', () => {
    const mk = frames();
    const state = run([open, frame(snapshotFrame(mk, { now: T0 + 5000 }), T0), { type: 'tick', localNow: T0 + 1000 }]);
    expect(state.now).toBe(T0 + 6000);
  });
});

describe('reducer: reconnect', () => {
  it('drops sync on disconnect, ignores deltas until the fresh snapshot, then equals a clean load', () => {
    const mk = frames();
    const m1 = message(A, B);
    const before = run([
      open,
      frame(snapshotFrame(mk, { nodes: [node(A), node(B)], edges: [edge(A, B)], messages: [m1] })),
      frame(mk('node', { op: 'upsert', node: node(C) })),
      { type: 'select', selection: { kind: 'node', id: C } },
      { type: 'filters', filters: { repos: ['github.com/acme/app'], hosts: [] } },
    ]);
    expect(Object.keys(before.data.nodes)).toHaveLength(3);

    const dropped = run([{ type: 'connection', status: 'reconnecting' }], before);
    expect(dropped.synced).toBe(false);
    const stale = run([frame(mk('node', { op: 'upsert', node: node('late:9') }))], dropped);
    expect(stale.data.nodes['late:9']).toBeUndefined();

    const freshSnap = snapshotFrame(mk, { nodes: [node(B)], edges: [], messages: [] });
    const after = run([open, frame(freshSnap)], stale);
    const clean = run([open, frame(freshSnap)]);

    expect(after.data).toEqual(clean.data);
    expect(after.synced).toBe(true);
    // The selected node is gone after the reset, so the selection is cleared;
    // filters are view state and survive.
    expect(after.view.selection).toBeNull();
    expect(after.view.filters.repos).toEqual(['github.com/acme/app']);
  });
});

describe('createStore', () => {
  it('emits a traffic event once per new message, and none from a snapshot', () => {
    const mk = frames();
    const store = createStore(initialState(T0));
    const events: string[] = [];
    store.onTraffic((e) => events.push(e.message.id));
    store.dispatch(open);
    const old = message(A, B);
    store.dispatch(frame(snapshotFrame(mk, { nodes: [node(A), node(B)], edges: [edge(A, B)], messages: [old] })));
    const m = message(B, A);
    store.dispatch(frame(mk('message', { message: m, edge: edge(A, B, 2) })));
    store.dispatch(frame(mk('message', { message: m, edge: edge(A, B, 2) })));
    expect(events).toEqual([m.id]);
  });

  it('notifies subscribers only on change', () => {
    const store = createStore(initialState(T0));
    let calls = 0;
    store.subscribe(() => calls++);
    store.dispatch({ type: 'hover', nodeId: null });
    expect(calls).toBe(0);
    store.dispatch({ type: 'hover', nodeId: A });
    expect(calls).toBe(1);
  });
});
