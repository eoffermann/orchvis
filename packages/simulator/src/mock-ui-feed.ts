import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BrokerToUiFrameSchema,
  HEALTH_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  LoginRequestSchema,
  MEDIA_PATH,
  OWNER_COOKIE,
  UI_WS_PATH,
  UiToBrokerFrameSchema,
  WS_CLOSE,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  type BrokerToUiFrame,
  type Limits,
} from '@orchvis/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { realClock, TimerGroup, type Clock } from './clock.js';
import { MockWorld, type UiDelta } from './mock-world.js';
import { generateScenario, type Scenario } from './scenario.js';
import type { TrafficOptions } from './traffic.js';

/** Options for {@link startMockUiFeed}. */
export interface MockUiFeedOptions {
  /** TCP port. 0 picks a free one. Default 0. */
  port?: number;
  /** Bind address. Default `127.0.0.1`. */
  host?: string;
  /** Number of sessions. Default 30. */
  nodes?: number;
  /** Number of hosts. Default 4. */
  hosts?: number;
  /** Number of repos. Default 6. */
  repos?: number;
  /** PRNG seed. Default 1. */
  seed?: number;
  /** Clock. Default the real clock. */
  clock?: Clock;
  /** A ready-made scenario, instead of generating one from `nodes`, `hosts`, `repos` and `seed`. */
  scenario?: Scenario;
  /** Limit overrides, e.g. a short `mediaTtlMs` to see expiry quickly. */
  limits?: Partial<Limits>;
  /** Traffic options (rate, media rate, and so on). */
  traffic?: TrafficOptions;
  /** Probability that a long disconnect retires a session. Default 0.3. */
  churnRate?: number;
  /**
   * Owner token. When set, the feed enforces login as the broker does:
   * `POST /api/login` answers 401 for any other token, and `/ws/ui` closes
   * with `WS_CLOSE.unauthorized` (4401) without a valid `OWNER_COOKIE`. When
   * unset, login accepts any non-empty token and `/ws/ui` is open.
   */
  ownerToken?: string;
  /** Start traffic at once. Default true; false leaves the world still until `world.start()`. */
  startTraffic?: boolean;
  /** Called when a `/ws/ui` client connects or disconnects, with the number open. */
  onClient?: (event: 'connect' | 'disconnect', open: number) => void;
  /** Called with each problem (an invalid outbound or inbound frame). Default: log to stderr. */
  onProblem?: (problem: string) => void;
}

/** Counters kept by the mock feed. */
export interface MockUiFeedStats {
  /** Connections accepted since start. */
  connections: number;
  /** Connections open now. */
  openConnections: number;
  framesSent: number;
  framesReceived: number;
  /** Outbound frames that failed `BrokerToUiFrameSchema`; they are not sent. Must stay 0. */
  invalidOutbound: number;
  /** Inbound frames that failed `UiToBrokerFrameSchema`; each is answered with `rejected`. */
  invalidInbound: number;
}

/** A running mock feed. */
export interface MockUiFeed {
  /** WebSocket URL of the feed, `ws://host:port/ws/ui`. */
  url: string;
  /** HTTP base URL, for `/healthz`, `/api/login` and `/api/media`. */
  httpUrl: string;
  port: number;
  /** The state behind the feed. */
  world: MockWorld;
  stats: MockUiFeedStats;
  /** Stops traffic, closes every connection and the server. */
  close(): Promise<void>;
}

/** Media served inline; anything else (HTML, SVG, ...) is served as a download. */
const INLINE_MIME = /^(image\/(png|jpeg|gif|webp)|audio\/|video\/|text\/plain)/i;

/**
 * Starts a standalone WebSocket server that speaks the broker-to-web half of
 * the protocol with no broker behind it. Each `/ws/ui` connection gets a
 * `snapshot`, then live `node`, `message`, `seen`, `media` and `control_state`
 * deltas from a simulated population. It answers `owner_send` (with `sent`,
 * the echoed `message`, and a reply from the target shortly after),
 * `control` (with a broadcast `control_state`) and `ping`.
 *
 * HTTP extras for web development: `GET /healthz`, `POST /api/login` and
 * `POST /api/logout` (the broker's contract; see `ownerToken`), `POST
 * /api/media` (multipart `file` + `caption`, Owner uploads for `owner_send`)
 * and `GET /api/media/:id` (with single-range support). Unlike the broker, the
 * mock does not check Origin.
 */
export async function startMockUiFeed(options: MockUiFeedOptions = {}): Promise<MockUiFeed> {
  const clock = options.clock ?? realClock;
  const scenario =
    options.scenario ??
    generateScenario({ sessions: options.nodes ?? 30, hosts: options.hosts ?? 4, repos: options.repos ?? 6, seed: options.seed ?? 1 });
  const worldOptions: ConstructorParameters<typeof MockWorld>[0] = { scenario, clock, seed: options.seed ?? scenario.seed };
  if (options.limits) worldOptions.limits = options.limits;
  if (options.traffic) worldOptions.traffic = options.traffic;
  if (options.churnRate !== undefined) worldOptions.churnRate = options.churnRate;
  const world = new MockWorld(worldOptions);
  const problem = options.onProblem ?? ((p: string) => process.stderr.write(`[mock-ui] ${p}\n`));
  const stats: MockUiFeedStats = { connections: 0, openConnections: 0, framesSent: 0, framesReceived: 0, invalidOutbound: 0, invalidInbound: 0 };
  const timers = new TimerGroup(clock);
  const sockets = new Set<WebSocket>();
  const ownerSessions = new Set<string>();
  let connectionCount = 0;

  function ownerSessionOf(req: IncomingMessage): string | undefined {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0 && part.slice(0, eq).trim() === OWNER_COOKIE) {
        const value = part.slice(eq + 1).trim();
        return ownerSessions.has(value) ? value : undefined;
      }
    }
    return undefined;
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  const server = createServer((req, res) => {
    handleHttp(req, res).catch((err: unknown) => {
      problem(`http error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-orchvis-token, range');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
  }

  async function readBody(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) return undefined;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cors(req, res);
    const url = new URL(req.url ?? '/', 'http://mock');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === HEALTH_PATH) {
      const snap = world.snapshot();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: snap.brokerVersion, mock: true, nodes: snap.nodes.length, media: snap.media.length }));
      return;
    }
    if (req.method === 'POST' && url.pathname === LOGIN_PATH) {
      const raw = await readBody(req, 4096);
      let parsed: ReturnType<typeof LoginRequestSchema.safeParse> | undefined;
      try {
        parsed = raw ? LoginRequestSchema.safeParse(JSON.parse(raw.toString('utf8'))) : undefined;
      } catch {
        parsed = undefined;
      }
      if (!parsed?.success) {
        json(res, 400, { error: 'invalid' });
        return;
      }
      if (options.ownerToken !== undefined && parsed.data.token !== options.ownerToken) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      const sessionId = randomBytes(24).toString('base64url');
      ownerSessions.add(sessionId);
      res.writeHead(204, { 'set-cookie': `${OWNER_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/` }).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === LOGOUT_PATH) {
      const session = ownerSessionOf(req);
      if (session) ownerSessions.delete(session);
      res.writeHead(204, { 'set-cookie': `${OWNER_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === MEDIA_PATH) {
      const body = await readBody(req, world.limits.maxMediaBytes + 64 * 1024);
      if (!body) {
        res.writeHead(413).end();
        return;
      }
      const form = await new Request('http://mock/api/media', {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? '' },
        body,
      }).formData();
      const file = form.get('file');
      const caption = form.get('caption');
      if (!(file instanceof Blob) || typeof caption !== 'string' || caption.trim() === '') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'multipart fields file and caption are required' }));
        return;
      }
      const data = new Uint8Array(await file.arrayBuffer());
      const ref = world.ownerUpload(
        { filename: (file as File).name || 'upload.bin', mime: file.type || 'application/octet-stream', data },
        caption,
      );
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ref));
      return;
    }
    const mediaMatch = /^\/api\/media\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && mediaMatch) {
      const item = world.mediaData(decodeURIComponent(mediaMatch[1] as string));
      if (!item) {
        res.writeHead(404).end();
        return;
      }
      const headers: Record<string, string> = {
        'content-type': item.mime,
        'x-content-type-options': 'nosniff',
        'accept-ranges': 'bytes',
        'content-disposition': `${INLINE_MIME.test(item.mime) ? 'inline' : 'attachment'}; filename="${item.filename.replace(/["\\\r\n]/g, '_')}"`,
      };
      const total = item.data.byteLength;
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : total - Number(range[2]);
        let end = range[1] && range[2] ? Number(range[2]) : total - 1;
        start = Math.max(0, start);
        end = Math.min(total - 1, end);
        if (start > end) {
          res.writeHead(416, { 'content-range': `bytes */${total}` }).end();
          return;
        }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1) });
        res.end(Buffer.from(item.data.subarray(start, end + 1)));
        return;
      }
      res.writeHead(200, { ...headers, 'content-length': String(total) });
      res.end(Buffer.from(item.data));
      return;
    }
    res.writeHead(404).end();
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://mock').pathname;
    if (path !== UI_WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const authorized = options.ownerToken === undefined || ownerSessionOf(req) !== undefined;
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!authorized) {
        ws.close(WS_CLOSE.unauthorized, 'unauthorized');
        return;
      }
      onConnection(ws);
    });
  });

  function onConnection(ws: WebSocket): void {
    stats.connections++;
    sockets.add(ws);
    stats.openConnections = sockets.size;
    options.onClient?.('connect', sockets.size);
    const mk = createFrameFactory<BrokerToUiFrame>(`m${++connectionCount}-`, () => clock.now());
    const send = (frame: BrokerToUiFrame) => {
      const check = BrokerToUiFrameSchema.safeParse(frame);
      if (!check.success) {
        stats.invalidOutbound++;
        problem(`invalid outbound ${frame.type}: ${check.error.issues[0]?.message ?? ''}`);
        return;
      }
      if (ws.readyState !== ws.OPEN) return;
      stats.framesSent++;
      ws.send(encodeFrame(frame));
    };
    send(mk('snapshot', world.snapshot()));
    // While handling this connection's owner_send, its deltas wait so `sent` goes out first.
    let held: UiDelta[] | undefined;
    const sendDelta = (delta: UiDelta) => send(mk(delta.type, delta.payload as never));
    const unsubscribe = world.subscribe((delta: UiDelta) => (held ? held.push(delta) : sendDelta(delta)));
    const stopPing = timers.every(world.limits.heartbeatIntervalMs, () => send(mk('ping', {})));
    ws.on('message', (data) => {
      stats.framesReceived++;
      const decoded = decodeFrame(UiToBrokerFrameSchema, data.toString());
      if (!decoded.ok) {
        stats.invalidInbound++;
        problem(`invalid inbound frame: ${decoded.error}`);
        send(mk('rejected', { re: decoded.id, code: 'invalid', detail: decoded.error.slice(0, 1024) }));
        return;
      }
      const frame = decoded.frame;
      switch (frame.type) {
        case 'ping':
          send(mk('pong', { re: frame.id }));
          break;
        case 'pong':
          break;
        case 'control':
          world.applyControl(frame.payload);
          break;
        case 'owner_send': {
          held = [];
          const result = world.ownerSend(frame.payload);
          const pending = held;
          held = undefined;
          if (result.ok) {
            const m = result.message;
            send(mk('sent', { re: frame.id, messageId: m.id, threadId: m.threadId, ts: m.ts }));
          } else {
            send(mk('rejected', { re: frame.id, code: result.code, detail: result.detail }));
          }
          pending.forEach(sendDelta);
          break;
        }
      }
    });
    ws.on('close', () => {
      unsubscribe();
      stopPing();
      sockets.delete(ws);
      stats.openConnections = sockets.size;
      options.onClient?.('disconnect', sockets.size);
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const host = options.host ?? '127.0.0.1';
  const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  if (options.startTraffic !== false) world.start();

  return {
    url: `ws://${shownHost}:${port}${UI_WS_PATH}`,
    httpUrl: `http://${shownHost}:${port}`,
    port,
    world,
    stats,
    close: async () => {
      world.stop();
      timers.close();
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
