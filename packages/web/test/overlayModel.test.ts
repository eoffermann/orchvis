import { OWNER_ADDRESS, sessionAddress, threadIdFor } from '@orchvis/protocol';
import { describe, expect, it } from 'vitest';
import { swipeDirection } from '../src/overlays/media';
import {
  formatCountdown,
  isMediaExpired,
  isNearBottom,
  mediaItemsFor,
  nameForKey,
  ownerThreadId,
  peerThreadsOf,
} from '../src/overlays/model';
import { reducer } from '../src/store/reducer';
import { initialState } from '../src/store/reducer';
import { T0, edge, frames, mediaEntry, message, node, snapshotFrame } from './fixtures';

describe('overlay model', () => {
  it('derives the Owner thread ID from the protocol helper', () => {
    expect(ownerThreadId('h:1')).toBe(threadIdFor(OWNER_ADDRESS, sessionAddress('h:1')));
  });

  it('lists a session’s peer threads by last activity, excluding the Owner thread', () => {
    const nodes = { 'h:1': node('h:1'), 'h:2': node('h:2'), 'h:3': node('h:3') };
    const e12 = edge('h:1', 'h:2', 1, { lastMessageAt: T0 + 10 });
    const e13 = edge('h:1', 'h:3', 1, { lastMessageAt: T0 + 50 });
    const e23 = edge('h:2', 'h:3', 1, { lastMessageAt: T0 + 99 });
    const owner = { ...edge('h:1', 'h:2'), threadId: ownerThreadId('h:1'), a: 'h:1', b: 'owner', lastMessageAt: T0 + 1000 };
    const edges = Object.fromEntries([e12, e13, e23, owner].map((e) => [e.threadId, e]));
    const list = peerThreadsOf('h:1', { nodes, edges, messages: {} });
    expect(list.map((p) => p.peerKey)).toEqual(['h:3', 'h:2']);
    expect(list[0]?.peerName).toBe(nodes['h:3'].name);
  });

  it('names removed sessions from the fromName stamped on their messages', () => {
    const m = message('gone:1', 'h:2', T0, { fromName: 'old-name' });
    expect(nameForKey('gone:1', { nodes: {} }, [m])).toBe('old-name');
    expect(nameForKey('owner', { nodes: {} })).toBe('Owner');
    expect(nameForKey('x:9', { nodes: {} })).toBe('x:9');
  });

  it('decides follow mode from the distance to the bottom', () => {
    expect(isNearBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
    expect(isNearBottom({ scrollTop: 660, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
    expect(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 300 })).toBe(false);
  });

  it('formats expiry countdowns', () => {
    expect(formatCountdown(0)).toBe('expired');
    expect(formatCountdown(9_001)).toBe('10s');
    expect(formatCountdown(45 * 60_000)).toBe('45m 00s');
    expect(formatCountdown(2 * 3600_000 + 5 * 60_000)).toBe('2h 05m');
  });

  it('reads swipes: horizontal travel beyond the threshold, not taps or vertical drags', () => {
    expect(swipeDirection(-80, 10)).toBe('next');
    expect(swipeDirection(80, -5)).toBe('prev');
    expect(swipeDirection(20, 0)).toBeNull();
    expect(swipeDirection(60, 90)).toBeNull();
  });

  it('filters the media browser to one thread and kind, unexpired, oldest first', () => {
    const m1 = message('h:1', 'h:2', T0 + 2);
    const m2 = message('h:1', 'h:2', T0 + 1);
    const m3 = message('h:1', 'h:3', T0);
    const a = mediaEntry(m1, 'a');
    const b = mediaEntry(m2, 'b');
    const c = mediaEntry(m3, 'c');
    const d = { ...mediaEntry(m1, 'd'), kind: 'audio' as const };
    const media = { a, b, c, d };
    expect(mediaItemsFor({ media }, m1.threadId, 'image', T0).map((e) => e.ref.mediaId)).toEqual(['b', 'a']);
    expect(mediaItemsFor({ media }, m1.threadId, 'image', T0 + 60_000)).toEqual([]);
  });
});

describe('expired media in the store', () => {
  it('marks attachments missing from the snapshot and expired by a media delta', () => {
    const mk = frames();
    const n1 = node('h:1');
    const n2 = node('h:2');
    const live = message('h:1', 'h:2');
    const gone = message('h:1', 'h:2');
    const liveEntry = mediaEntry(live, 'live');
    const goneEntry = mediaEntry(gone, 'gone');
    live.attachments = [liveEntry.ref];
    gone.attachments = [goneEntry.ref];
    let s = reducer(initialState(T0), { type: 'connection', status: 'open' });
    s = reducer(s, {
      type: 'frame',
      frame: snapshotFrame(mk, { nodes: [n1, n2], edges: [edge('h:1', 'h:2')], messages: [live, gone], media: [liveEntry] }),
      receivedAt: T0,
    });
    expect(isMediaExpired(goneEntry.ref, s.data, s.now)).toBe(true);
    expect(isMediaExpired(liveEntry.ref, s.data, s.now)).toBe(false);
    s = reducer(s, {
      type: 'frame',
      frame: mk('media', {
        op: 'expire',
        mediaId: 'live',
        threadId: live.threadId,
        edge: edge('h:1', 'h:2'),
        mediaStore: { bytes: 0, capBytes: 1, files: 0 },
      }),
      receivedAt: T0,
    });
    expect(isMediaExpired(liveEntry.ref, s.data, s.now)).toBe(true);
    expect(s.data.media).toEqual({});
  });

  it('treats a passed expiresAt as expired even before the broker says so', () => {
    const m = message('h:1', 'h:2');
    const ref = mediaEntry(m, 'x').ref;
    expect(isMediaExpired(ref, { expiredMedia: {} }, ref.expiresAt)).toBe(true);
    expect(isMediaExpired(ref, { expiredMedia: {} }, ref.expiresAt - 1)).toBe(false);
  });
});
