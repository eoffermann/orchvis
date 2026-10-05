import { WS_CLOSE, createFrameFactory, encodeFrame, type BrokerToUiFrame } from '@orchvis/protocol';
import { describe, expect, it } from 'vitest';
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, backoffDelay } from '../src/net/backoff';
import { FeedClient } from '../src/net/feedClient';
import type { TransportHandlers } from '../src/net/transport';
import { initialState } from '../src/store/reducer';
import { createStore } from '../src/store/store';
import { T0, node, snapshotFrame } from './fixtures';

describe('backoffDelay', () => {
  it('grows exponentially from 1 s and caps at 30 s, with jitter in [base/2, base]', () => {
    expect(backoffDelay(0, () => 0)).toBe(BACKOFF_MIN_MS / 2);
    expect(backoffDelay(0, () => 0.999999)).toBe(BACKOFF_MIN_MS);
    expect(backoffDelay(3, () => 0.999999)).toBe(8000);
    expect(backoffDelay(20, () => 0.999999)).toBe(BACKOFF_MAX_MS);
  });
});

class Harness {
  handlers: TransportHandlers[] = [];
  sent: string[][] = [];
  closed: boolean[] = [];
  timers: { fn: () => void; ms: number }[] = [];
  store = createStore(initialState(T0));
  client = new FeedClient({
    store: this.store,
    connect: (h) => {
      const i = this.handlers.length;
      this.handlers.push(h);
      this.sent.push([]);
      this.closed.push(false);
      return {
        send: (raw) => this.sent[i]!.push(raw),
        close: () => {
          this.closed[i] = true;
        },
      };
    },
    clock: () => T0,
    random: () => 0.5,
    timers: {
      set: (fn, ms) => this.timers.push({ fn, ms }),
      clear: () => undefined,
    },
    log: () => undefined,
  });
  mk = createFrameFactory<BrokerToUiFrame>('b');

  get last(): TransportHandlers {
    return this.handlers[this.handlers.length - 1]!;
  }

  runTimers() {
    const pending = this.timers.splice(0);
    for (const t of pending) t.fn();
  }
}

describe('FeedClient', () => {
  it('validates inbound frames, answers pings and feeds the store', () => {
    const h = new Harness();
    h.client.start();
    h.last.onOpen();
    expect(h.store.getState().connection).toBe('open');
    h.last.onMessage(encodeFrame(snapshotFrame(h.mk, { nodes: [node('a:1')] })));
    h.last.onMessage('{"v":1,"type":"node","id":"x","ts":0,"payload":{"op":"upsert","node":{"id":"bad"}}}');
    h.last.onMessage('not json');
    h.last.onMessage(encodeFrame(h.mk('ping', {})));
    const state = h.store.getState();
    expect(state.synced).toBe(true);
    expect(Object.keys(state.data.nodes)).toEqual(['a:1']);
    expect(h.sent[0]).toHaveLength(1);
    expect(JSON.parse(h.sent[0]![0]!)).toMatchObject({ v: 1, type: 'pong', payload: { re: 'b2' } });
  });

  it('reconnects with backoff after a drop and takes a fresh snapshot', () => {
    const h = new Harness();
    h.client.start();
    h.last.onOpen();
    h.last.onMessage(encodeFrame(snapshotFrame(h.mk, { nodes: [node('a:1'), node('b:2')] })));
    h.last.onClose({ code: 1006, opened: true });
    expect(h.store.getState().connection).toBe('reconnecting');
    expect(h.store.getState().synced).toBe(false);
    expect(h.timers[0]?.ms).toBe(750);
    h.runTimers();
    expect(h.handlers).toHaveLength(2);
    // A stale delta before the new snapshot is dropped.
    h.last.onOpen();
    h.last.onMessage(encodeFrame(h.mk('node', { op: 'upsert', node: node('c:3') })));
    expect(h.store.getState().data.nodes['c:3']).toBeUndefined();
    h.last.onMessage(encodeFrame(snapshotFrame(h.mk, { nodes: [node('b:2')] })));
    expect(Object.keys(h.store.getState().data.nodes)).toEqual(['b:2']);
  });

  it('shows login only on WS_CLOSE.unauthorized (4401), and stops retrying', () => {
    const h = new Harness();
    h.client.start();
    h.last.onOpen();
    h.last.onClose({ code: WS_CLOSE.unauthorized, opened: true });
    expect(h.store.getState().connection).toBe('unauthorized');
    expect(h.timers).toHaveLength(0);
    // The login screen restarts the client after a successful login.
    h.client.start();
    expect(h.handlers).toHaveLength(2);
    expect(h.store.getState().connection).toBe('reconnecting');
  });

  it.each([
    ['forbiddenOrigin', WS_CLOSE.forbiddenOrigin, true],
    ['shuttingDown', WS_CLOSE.shuttingDown, true],
    ['policy violation', 1008, true],
    ['abnormal drop before open', 1006, false],
  ])('treats %s as transient and reconnects with backoff', (_label, code, opened) => {
    const h = new Harness();
    h.client.start();
    if (opened) h.last.onOpen();
    h.last.onClose({ code, opened });
    expect(h.store.getState().connection).toBe('reconnecting');
    expect(h.timers).toHaveLength(1);
    h.runTimers();
    expect(h.handlers).toHaveLength(2);
  });

  it('sends controls only while open, with unique frame IDs', () => {
    const h = new Harness();
    expect(h.client.sendControl({ action: 'pause_all' })).toBeNull();
    h.client.start();
    h.last.onOpen();
    const a = h.client.sendControl({ action: 'pause_all' });
    const b = h.client.sendControl({ action: 'resume_all' });
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
    expect(JSON.parse(h.sent[0]![0]!)).toMatchObject({ type: 'control', payload: { action: 'pause_all' } });
  });
});
