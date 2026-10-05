/**
 * A fake orchvis broker for shim integration tests: a `ws` server on an
 * ephemeral port that speaks the protocol frames (validated with the protocol
 * schemas), plus `POST MEDIA_PATH` and `GET MEDIA_PATH/:id`, authenticated by
 * the protocol's `SHIM_TOKEN_HEADER`. A rejected `hello` is followed by a close
 * with `WS_CLOSE.helloRejected`, as the real broker does.
 *
 * Tests that only need a broker to talk to should depend on {@link TestBroker},
 * which matches the real broker's planned `startBroker({ port: 0 })` seam, so
 * the fake can be swapped for the real one later. Tests that inspect frames use
 * the {@link FakeBroker} extras.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_LIMITS,
  MEDIA_PATH,
  PROTOCOL_VERSION,
  SHIM_TOKEN_HEADER,
  SHIM_WS_PATH,
  WS_CLOSE,
  ShimToBrokerFrameSchema,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  threadIdFor,
  type Address,
  type BrokerToShimFrame,
  type FrameOf,
  type Limits,
  type MediaRef,
  type Message,
  type PeerInfo,
  type RejectCode,
  type ShimToBrokerFrame,
} from '@orchvis/protocol';
import { ulid } from './messages.js';

/** The minimal broker seam, shared with the real broker's `startBroker`. */
export interface TestBroker {
  /** Base URL, e.g. `http://127.0.0.1:54321`. */
  url: string;
  shimToken: string;
  close(): Promise<void>;
}

/** Inspection and control on top of {@link TestBroker}. */
export interface FakeBroker extends TestBroker {
  /** Every valid frame received from shims, in order. */
  received: ShimToBrokerFrame[];
  /** Raw frames that failed validation. */
  invalid: string[];
  /** Resolves with the first received frame of `type` at index ≥ `from` matching `pred`. */
  waitFor<T extends ShimToBrokerFrame['type']>(
    type: T,
    pred?: (f: FrameOf<ShimToBrokerFrame, T>) => boolean,
    options?: { from?: number; timeoutMs?: number },
  ): Promise<FrameOf<ShimToBrokerFrame, T>>;
  /** Number of frames of a type received so far. */
  count(type: ShimToBrokerFrame['type']): number;
  /** Queues a message for its recipient and sends it now if connected. */
  deliver(message: Message): void;
  /** Sends a raw frame to every connected shim. */
  sendRaw(frame: BrokerToShimFrame): void;
  /** Terminates every shim connection. */
  dropConnections(): void;
  /** Number of hellos accepted so far. */
  readonly helloCount: number;
  /** IDs reported seen. */
  seenIds: Set<string>;
  /** Limits sent in welcome. */
  limits: Limits;
  /** Peers listed in welcome and registered. */
  peers: PeerInfo[];
  /** Rejects the next `send` with this code. */
  rejectNextSend(code: RejectCode, detail?: string): void;
  /** Canonical session ID to return from `registered`, simulating aliasing. */
  aliasOnRegister: string | undefined;
  /** Uploaded media by ID. */
  uploads: Map<string, { ref: MediaRef; data: Buffer }>;
  /** Rejects every `hello` (with a valid token) with this code, then closes with `WS_CLOSE.helloRejected`. */
  rejectHellosWith: RejectCode | undefined;
  /** Number of WebSocket connections opened so far. */
  readonly connectionCount: number;
  /** Closes every shim connection with a close code, e.g. `WS_CLOSE.shuttingDown`. */
  closeConnections(code: number): void;
}

/** Options for {@link startFakeBroker}. */
export interface FakeBrokerOptions {
  limits?: Partial<Limits>;
  shimToken?: string;
  peers?: PeerInfo[];
}

/** Starts a fake broker on 127.0.0.1 port 0. */
export async function startFakeBroker(options: FakeBrokerOptions = {}): Promise<FakeBroker> {
  const shimToken = options.shimToken ?? `tok-${randomBytes(8).toString('hex')}`;
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const received: ShimToBrokerFrame[] = [];
  const invalid: string[] = [];
  const waiters = new Set<() => void>();
  const seenIds = new Set<string>();
  const queued: Message[] = [];
  const sentLog: Message[] = [];
  const uploads = new Map<string, { ref: MediaRef; data: Buffer }>();
  const sockets = new Map<WebSocket, { sessionId: string; mk: ReturnType<typeof createFrameFactory<BrokerToShimFrame>> }>();
  let helloCount = 0;
  let nextReject: { code: RejectCode; detail: string } | undefined;

  const state: Pick<FakeBroker, 'aliasOnRegister' | 'peers' | 'limits' | 'rejectHellosWith'> = {
    aliasOnRegister: undefined,
    rejectHellosWith: undefined,
    peers: options.peers ?? [],
    limits,
  };

  const http = createServer((req, res) => void handleHttp(req, res));
  const wss = new WebSocketServer({ server: http, path: SHIM_WS_PATH });

  // Checked against the protocol constants, not the shim's helper, so the two cannot drift together.
  function authorized(req: IncomingMessage): boolean {
    return req.headers[SHIM_TOKEN_HEADER] === shimToken;
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!authorized(req)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (req.method === 'POST' && url.pathname === MEDIA_PATH) {
      const request = new Request(`http://x${MEDIA_PATH}`, {
        method: 'POST',
        headers: req.headers as Record<string, string>,
        body: req as unknown as ReadableStream,
        duplex: 'half',
      } as RequestInit);
      const form = await request.formData();
      const caption = form.get('caption');
      const file = form.get('file');
      if (typeof caption !== 'string' || !caption || !(file instanceof Blob)) {
        res.writeHead(400).end('caption and file required');
        return;
      }
      const data = Buffer.from(await file.arrayBuffer());
      const ref: MediaRef = {
        mediaId: `m${randomBytes(8).toString('hex')}`,
        mime: file.type || 'application/octet-stream',
        filename: (file as File).name || 'file',
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
        caption,
        expiresAt: Date.now() + state.limits.mediaTtlMs,
      };
      uploads.set(ref.mediaId, { ref, data });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ref));
      return;
    }
    const prefix = `${MEDIA_PATH}/`;
    if (req.method === 'GET' && url.pathname.startsWith(prefix) && !url.pathname.slice(prefix.length).includes('/')) {
      const item = uploads.get(decodeURIComponent(url.pathname.slice(prefix.length)));
      if (!item) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': item.ref.mime, 'content-length': item.data.length }).end(item.data);
      return;
    }
    res.writeHead(404).end();
  }

  function send(ws: WebSocket, frame: BrokerToShimFrame): void {
    ws.send(encodeFrame(frame));
  }

  function resolveTo(to: string): Address {
    if (to === 'owner') return { kind: 'owner' };
    const peer = state.peers.find((p) => p.name === to || p.id === to);
    return { kind: 'session', id: peer?.id ?? (to.includes(':') ? to : `peerhost:${to}`) };
  }

  let connectionCount = 0;
  wss.on('connection', (ws) => {
    connectionCount++;
    const conn = { sessionId: '', mk: createFrameFactory<BrokerToShimFrame>('b') };
    ws.on('message', (data) => {
      const raw = data.toString();
      const decoded = decodeFrame(ShimToBrokerFrameSchema, raw);
      if (!decoded.ok) {
        invalid.push(raw);
        send(ws, conn.mk('rejected', { re: decoded.id, code: 'invalid', detail: decoded.error }));
        return;
      }
      const frame = decoded.frame;
      received.push(frame);
      for (const w of [...waiters]) w();
      const mk = conn.mk;
      switch (frame.type) {
        case 'hello': {
          const helloReject: { code: RejectCode; detail: string } | undefined =
            frame.payload.token !== shimToken
              ? { code: 'unauthorized', detail: 'bad token' }
              : state.rejectHellosWith
                ? { code: state.rejectHellosWith, detail: 'test rejection' }
                : undefined;
          if (helloReject) {
            send(ws, mk('rejected', { re: frame.id, ...helloReject }));
            ws.close(WS_CLOSE.helloRejected, helloReject.code);
            return;
          }
          helloCount++;
          conn.sessionId = state.aliasOnRegister ?? frame.payload.sessionId;
          sockets.set(ws, conn);
          send(
            ws,
            mk('welcome', {
              re: frame.id,
              sessionId: conn.sessionId,
              name: frame.payload.defaultName,
              limits: state.limits,
              peers: state.peers,
              brokerVersion: 'fake-0',
              protocolVersion: PROTOCOL_VERSION,
            }),
          );
          for (const m of queued) {
            if (!seenIds.has(m.id)) send(ws, mk('deliver', { message: m }));
          }
          return;
        }
        case 'register':
          if (state.aliasOnRegister) conn.sessionId = state.aliasOnRegister;
          send(
            ws,
            mk('registered', { re: frame.id, sessionId: conn.sessionId, name: frame.payload.name, peers: state.peers }),
          );
          return;
        case 'send': {
          if (nextReject) {
            send(ws, mk('rejected', { re: frame.id, ...nextReject }));
            nextReject = undefined;
            return;
          }
          const from: Address = { kind: 'session', id: conn.sessionId };
          const to = resolveTo(frame.payload.to);
          const attachments: MediaRef[] = [];
          for (const id of frame.payload.attachments) {
            const item = uploads.get(id);
            if (!item) {
              send(ws, mk('rejected', { re: frame.id, code: 'invalid', detail: `unknown media ${id}` }));
              return;
            }
            attachments.push(item.ref);
          }
          const message: Message = {
            id: ulid(),
            threadId: threadIdFor(from, to),
            from,
            fromName: 'ME',
            to,
            senderKind: 'peer',
            kind: frame.payload.kind,
            body: frame.payload.body,
            attachments,
            ts: Date.now(),
            ...(frame.payload.replyTo ? { replyTo: frame.payload.replyTo } : {}),
          };
          sentLog.push(message);
          send(ws, mk('sent', { re: frame.id, messageId: message.id, threadId: message.threadId, ts: message.ts }));
          return;
        }
        case 'seen':
          for (const id of frame.payload.ids) seenIds.add(id);
          return;
        case 'thread_request': {
          const peer = resolveTo(frame.payload.peer);
          const threadId = threadIdFor({ kind: 'session', id: conn.sessionId }, peer);
          const messages = [...queued, ...sentLog].filter((m) => m.threadId === threadId).sort((a, b) => a.ts - b.ts);
          send(ws, mk('thread', { re: frame.id, threadId, messages }));
          return;
        }
        case 'ping':
          send(ws, mk('pong', { re: frame.id }));
          return;
        default:
          return;
      }
    });
    ws.on('close', () => sockets.delete(ws));
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  const broker: FakeBroker = {
    url: `http://127.0.0.1:${port}`,
    shimToken,
    received,
    invalid,
    seenIds,
    uploads,
    get helloCount() {
      return helloCount;
    },
    get limits() {
      return state.limits;
    },
    set limits(value) {
      state.limits = value;
    },
    get peers() {
      return state.peers;
    },
    set peers(value) {
      state.peers = value;
    },
    get aliasOnRegister() {
      return state.aliasOnRegister;
    },
    set rejectHellosWith(value) {
      state.rejectHellosWith = value;
    },
    get rejectHellosWith() {
      return state.rejectHellosWith;
    },
    get connectionCount() {
      return connectionCount;
    },
    closeConnections(code) {
      for (const ws of wss.clients) ws.close(code);
    },
    set aliasOnRegister(value) {
      state.aliasOnRegister = value;
    },
    waitFor(type, pred, opts = {}) {
      const from = opts.from ?? 0;
      const timeoutMs = opts.timeoutMs ?? 10_000;
      type F = FrameOf<ShimToBrokerFrame, typeof type>;
      const find = (): F | undefined =>
        received.slice(from).find((f): f is F => f.type === type && (!pred || pred(f as F)));
      return new Promise((resolve, reject) => {
        const hit = find();
        if (hit) return resolve(hit);
        const check = (): void => {
          const found = find();
          if (found) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve(found);
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`fake broker: no ${type} frame within ${timeoutMs} ms`));
        }, timeoutMs);
        waiters.add(check);
      });
    },
    count(type) {
      return received.filter((f) => f.type === type).length;
    },
    deliver(message) {
      queued.push(message);
      for (const [ws, conn] of sockets) {
        if (message.to.kind === 'session' && message.to.id === conn.sessionId) {
          send(ws, conn.mk('deliver', { message }));
        }
      }
    },
    sendRaw(frame) {
      for (const ws of sockets.keys()) send(ws, frame);
    },
    dropConnections() {
      for (const ws of wss.clients) ws.terminate();
    },
    rejectNextSend(code, detail = '') {
      nextReject = { code, detail };
    },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
  return broker;
}
