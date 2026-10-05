import {
  OWNER_COOKIE,
  createFrameFactory,
  type BrokerToUiFrame,
} from '@orchvis/protocol';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FeedClient } from '../src/net/feedClient';
import { login } from '../src/net/login';
import { uploadMedia } from '../src/net/media';
import type { TransportFactory } from '../src/net/transport';
import { ownerThreadId } from '../src/overlays/model';
import { sendDraft, type OverlayActions } from '../src/overlays/sendFlow';
import { initialState } from '../src/store/reducer';
import { createStore, type Store } from '../src/store/store';
import type { AppState } from '../src/store/types';
import { loadSimulator, type MockUiFeed, type SimulatorApi, type UiState } from './simulatorApi';

let sim: SimulatorApi;
beforeAll(async () => {
  sim = await loadSimulator();
});

let feed: MockUiFeed | undefined;
const clients: FeedClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  await feed?.close();
  feed = undefined;
});

/** A transport over the `ws` package, so the test can send the Owner cookie the browser would. */
function wsTransport(url: string, cookie?: string): TransportFactory {
  return (handlers) => {
    const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
    let opened = false;
    let closed = false;
    ws.on('open', () => {
      opened = true;
      handlers.onOpen();
    });
    ws.on('message', (data) => handlers.onMessage(data.toString()));
    ws.on('close', (code) => {
      if (closed) return;
      closed = true;
      handlers.onClose({ code, opened });
    });
    ws.on('error', () => undefined);
    return {
      send: (raw) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      },
      close: () => ws.close(1000),
    };
  };
}

function startClient(store: Store, url: string, cookie?: string): FeedClient {
  const client = new FeedClient({ store, connect: wsTransport(url, cookie), log: () => undefined });
  clients.push(client);
  client.start();
  return client;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The web store's data in the simulator's comparable shape. */
function toUiState(s: AppState): UiState {
  const byKey = <T>(key: (t: T) => string) => (x: T, y: T) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0);
  return structuredClone({
    now: s.now,
    limits: s.data.limits,
    nodes: Object.values(s.data.nodes).sort(byKey((n) => n.id)),
    edges: Object.values(s.data.edges).sort(byKey((e) => e.threadId)),
    messages: Object.values(s.data.messages).flat().sort(byKey((m) => m.id)),
    media: Object.values(s.data.media).sort(byKey((m) => m.ref.mediaId)),
    control: {
      mutedThreads: [...s.data.control.mutedThreads].sort(),
      pausedSessions: [...s.data.control.pausedSessions].sort(),
      pausedAll: s.data.control.pausedAll,
    },
    mediaStore: s.data.mediaStore,
  });
}

/** The state a fresh snapshot of the mock world would give. */
function expectedState(f: MockUiFeed): UiState {
  const mirror = new sim.UiStateMirror();
  mirror.apply(createFrameFactory<BrokerToUiFrame>('x')('snapshot', f.world.snapshot()));
  return mirror.state();
}

/** `fetch` bound to the feed's origin, carrying the Owner cookie like a same-origin browser request. */
function originFetch(base: string, cookie?: string): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    fetch(`${base}${String(url)}`, { ...init, headers: { ...(init?.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } })) as typeof fetch;
}

describe('web store against the simulator mock /ws/ui feed', () => {
  it('shows login on 4401, logs in, then tracks the feed exactly through snapshot and deltas', async () => {
    const clock = new sim.FakeClock();
    feed = await sim.startMockUiFeed({ port: 0, nodes: 8, hosts: 3, repos: 3, seed: 7, ownerToken: 'mock', clock, limits: { mediaTtlMs: 20_000 }, traffic: { rate: 6, mediaRate: 0.5 } });

    // No cookie: the feed closes with 4401 and the app shows the login screen.
    const anon = createStore(initialState());
    startClient(anon, feed.url);
    await waitFor(() => anon.getState().connection === 'unauthorized', 'unauthorized');

    // Wrong then right token through the app's own login function.
    let setCookie = '';
    const capture = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(`${feed!.httpUrl}${String(url)}`, init);
      setCookie = res.headers.get('set-cookie') ?? '';
      return res;
    }) as typeof fetch;
    expect(await login('wrong', capture)).toEqual({ ok: false, reason: 'bad_token', status: 401 });
    expect(await login('mock', capture)).toEqual({ ok: true });
    const cookie = setCookie.split(';')[0] ?? '';
    expect(cookie.startsWith(`${OWNER_COOKIE}=`)).toBe(true);

    const store = createStore(initialState());
    startClient(store, feed.url, cookie);
    await waitFor(() => store.getState().synced, 'snapshot');
    expect(sim.diffUiStates(toUiState(store.getState()), expectedState(feed), clock.now())).toEqual([]);

    // Run traffic (messages, seen, media add and expire, churn) and compare again.
    await clock.advanceAsync(90_000, 500);
    let diff: string[] = [];
    await waitFor(() => {
      diff = sim.diffUiStates(toUiState(store.getState()), expectedState(feed!), clock.now());
      return diff.length === 0;
    }, `store to converge: ${diff.slice(0, 3).join('; ')}`);
    expect(feed.stats.invalidOutbound).toBe(0);
    expect(Object.values(store.getState().data.messages).flat().length).toBeGreaterThan(20);
    expect(Object.keys(store.getState().data.expiredMedia).length).toBeGreaterThan(0);
  }, 30_000);

  it('uploads an Owner attachment over HTTP, then owner_send delivers it in the Owner thread', async () => {
    const clock = new sim.FakeClock();
    feed = await sim.startMockUiFeed({ port: 0, nodes: 4, seed: 3, ownerToken: 'mock', clock, startTraffic: false });
    const res = await fetch(`${feed.httpUrl}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'mock' }) });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const store = createStore(initialState());
    const client = startClient(store, feed.url, cookie);
    await waitFor(() => store.getState().synced, 'snapshot');
    const target = Object.values(store.getState().data.nodes).find((n) => n.connected);
    expect(target).toBeDefined();
    const to = target!.id;

    const httpFetch = originFetch(feed.httpUrl, cookie);
    const actions: OverlayActions = {
      sendOwnerMessage: (p) => client.sendOwnerMessage(p),
      sendControl: (a) => client.sendControl(a),
      uploadMedia: (file, filename, caption) => uploadMedia(file, filename, caption, httpFetch),
    };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const outcome = await sendDraft(
      { to, kind: 'chat', body: 'see <b>this</b>', attachments: [{ key: 'k', file: new File([png], 'p.png', { type: 'image/png' }), caption: 'A tiny PNG' }] },
      store.getState().data.limits,
      actions,
      clock.now(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const thread = ownerThreadId(to);
    await waitFor(() => (store.getState().data.messages[thread] ?? []).some((m) => m.senderKind === 'owner'), 'owner message');
    const sent = (store.getState().data.messages[thread] ?? []).find((m) => m.senderKind === 'owner')!;
    expect(sent.body).toBe('see <b>this</b>');
    expect(sent.attachments.map((a) => [a.mediaId, a.caption])).toEqual([[outcome.mediaIds[0], 'A tiny PNG']]);
    expect(store.getState().data.lastRejection).toBeNull();

    // The media GET serves the uploaded bytes.
    const got = await httpFetch(`/api/media/${encodeURIComponent(outcome.mediaIds[0]!)}`);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);

    // Media IDs are single use: a second send with the same ID is rejected.
    const again = client.sendOwnerMessage({ to, kind: 'chat', body: 'again', attachments: outcome.mediaIds });
    await waitFor(() => store.getState().data.lastRejection?.re === again, 'rejection of reused media ID');
    expect(store.getState().data.lastRejection?.code).toBe('invalid');
  }, 30_000);
});
