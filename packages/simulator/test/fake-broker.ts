import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_LIMITS,
  OWNER_ADDRESS,
  SHIM_WS_PATH,
  ShimToBrokerFrameSchema,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  sanitizeText,
  sessionAddress,
  threadIdFor,
  toPeerInfo,
  type Address,
  type BrokerToShimFrame,
  type Limits,
  type MediaRef,
  type Message,
  type SessionNode,
  type ShimToBrokerFrame,
} from '@orchvis/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { createUlidFactory, realClock, Rng, sha256Hex } from '../src/index.js';

interface Conn {
  ws: WebSocket;
  mk: ReturnType<typeof createFrameFactory<BrokerToShimFrame>>;
  node?: SessionNode;
}

/** Options for {@link startFakeBroker}. */
export interface FakeBrokerOptions {
  token?: string;
  limits?: Partial<Limits>;
  /** Close every connection right after it opens, to exercise backoff. */
  refuse?: boolean;
  /** Return this canonical session ID in `registered` (to test aliasing). */
  aliasTo?: string;
}

/**
 * A tiny in-test broker for `/ws/shim`: answers hello, register, send,
 * thread_request and ping; routes deliveries by name or session ID; accepts
 * media uploads. Every inbound frame is validated and recorded.
 */
export async function startFakeBroker(options: FakeBrokerOptions = {}) {
  const token = options.token ?? 'shim-token';
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const ulid = createUlidFactory(realClock, new Rng(99));
  const conns = new Set<Conn>();
  const frames: ShimToBrokerFrame[] = [];
  const invalid: string[] = [];
  const messages: Message[] = [];
  const uploads = new Map<string, MediaRef>();
  let refuse = options.refuse ?? false;
  let uploadCount = 0;

  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/media') {
      if (req.headers['x-orchvis-token'] !== token) {
        res.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = await new Request('http://x/', {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? '' },
        body: Buffer.concat(chunks),
      }).formData();
      const file = form.get('file') as File;
      const data = new Uint8Array(await file.arrayBuffer());
      const ref: MediaRef = {
        mediaId: `up${++uploadCount}`,
        mime: file.type,
        filename: file.name,
        bytes: data.byteLength,
        sha256: sha256Hex(data),
        caption: String(form.get('caption')),
        expiresAt: Date.now() + limits.mediaTtlMs,
      };
      uploads.set(ref.mediaId, ref);
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(ref));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: SHIM_WS_PATH });

  const send = (c: Conn, f: BrokerToShimFrame) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(encodeFrame(f));
  };
  const peersOf = (c: Conn) => [...conns].filter((o) => o !== c && o.node).map((o) => toPeerInfo(o.node as SessionNode));
  const find = (to: string) => [...conns].find((o) => o.node && (o.node.id === to || o.node.name === to));

  wss.on('connection', (ws) => {
    const c: Conn = { ws, mk: createFrameFactory<BrokerToShimFrame>('b') };
    conns.add(c);
    if (refuse) {
      ws.terminate();
      conns.delete(c);
      return;
    }
    ws.on('close', () => conns.delete(c));
    ws.on('message', (data) => {
      const d = decodeFrame(ShimToBrokerFrameSchema, data.toString());
      if (!d.ok) {
        invalid.push(d.error);
        return;
      }
      const f = d.frame;
      frames.push(f);
      switch (f.type) {
        case 'hello': {
          if (f.payload.token !== token) {
            send(c, c.mk('rejected', { re: f.id, code: 'unauthorized', detail: 'bad token' }));
            ws.close();
            return;
          }
          const p = f.payload;
          c.node = {
            id: p.sessionId,
            hostname: p.hostname,
            platform: p.platform,
            name: p.defaultName,
            focus: '',
            repos: p.repos,
            cwd: p.cwd,
            status: 'idle',
            delivery: 'poll',
            connected: true,
            lastSeen: Date.now(),
          };
          send(c, c.mk('welcome', { re: f.id, sessionId: p.sessionId, name: p.defaultName, uploadKey: `fake-upload-key-${f.id}`, limits, peers: peersOf(c), brokerVersion: 'fake', protocolVersion: 1 }));
          break;
        }
        case 'register': {
          if (!c.node) return;
          c.node.name = f.payload.name;
          if (options.aliasTo) c.node.id = options.aliasTo;
          send(c, c.mk('registered', { re: f.id, sessionId: c.node.id, name: c.node.name, peers: peersOf(c) }));
          break;
        }
        case 'send': {
          if (!c.node) return;
          const from = sessionAddress(c.node.id);
          let to: Address;
          let target: Conn | undefined;
          if (f.payload.to === 'owner') to = OWNER_ADDRESS;
          else {
            target = find(f.payload.to);
            if (!target?.node) {
              send(c, c.mk('rejected', { re: f.id, code: 'unknown_recipient', detail: f.payload.to }));
              return;
            }
            to = sessionAddress(target.node.id);
          }
          const attachments: MediaRef[] = [];
          for (const id of f.payload.attachments) {
            const ref = uploads.get(id);
            if (!ref) {
              send(c, c.mk('rejected', { re: f.id, code: 'invalid', detail: `media ${id}` }));
              return;
            }
            uploads.delete(id);
            attachments.push(ref);
          }
          const m: Message = {
            id: ulid(),
            threadId: threadIdFor(from, to),
            from,
            fromName: c.node.name,
            to,
            senderKind: 'peer',
            kind: f.payload.kind,
            body: sanitizeText(f.payload.body),
            attachments,
            ts: Date.now(),
          };
          if (f.payload.replyTo) m.replyTo = f.payload.replyTo;
          messages.push(m);
          send(c, c.mk('sent', { re: f.id, messageId: m.id, threadId: m.threadId, ts: m.ts }));
          if (target) send(target, target.mk('deliver', { message: m }));
          break;
        }
        case 'thread_request': {
          if (!c.node) return;
          const peer = f.payload.peer === 'owner' ? OWNER_ADDRESS : sessionAddress(find(f.payload.peer)?.node?.id ?? f.payload.peer);
          const threadId = threadIdFor(sessionAddress(c.node.id), peer);
          send(c, c.mk('thread', { re: f.id, threadId, messages: messages.filter((m) => m.threadId === threadId) }));
          break;
        }
        case 'ping':
          send(c, c.mk('pong', { re: f.id }));
          break;
        default:
          break;
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}${SHIM_WS_PATH}`,
    token,
    frames,
    invalid,
    messages,
    /** Frames of one type received so far. */
    received<T extends ShimToBrokerFrame['type']>(type: T): Extract<ShimToBrokerFrame, { type: T }>[] {
      return frames.filter((f) => f.type === type) as never;
    },
    /** Delivers a message to the session with this ID or name. */
    deliver(to: string, message: Message) {
      const c = find(to);
      if (c) send(c, c.mk('deliver', { message }));
    },
    /** Sends raw text to every connection. */
    sendRaw(text: string) {
      for (const c of conns) c.ws.send(text);
    },
    /** Sends a ping to every connection. */
    ping() {
      for (const c of conns) send(c, c.mk('ping', {}));
    },
    connections: () => conns.size,
    dropAll() {
      for (const c of conns) c.ws.terminate();
    },
    setRefuse(v: boolean) {
      refuse = v;
    },
    close: async () => {
      for (const c of conns) c.ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** A fake broker, as returned by {@link startFakeBroker}. */
export type FakeBroker = Awaited<ReturnType<typeof startFakeBroker>>;
