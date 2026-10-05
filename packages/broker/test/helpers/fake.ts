import WebSocket from 'ws';
import {
  BrokerToShimFrameSchema,
  BrokerToUiFrameSchema,
  LOGIN_PATH,
  PROTOCOL_VERSION,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  type BrokerToShimFrame,
  type BrokerToUiFrame,
  type FrameOf,
  type PayloadOf,
  type ShimToBrokerFrame,
  type UiToBrokerFrame,
} from '@orchvis/protocol';
import type { RunningBroker } from '../../src/index.js';

const WAIT_MS = 3_000;

type Inbound = BrokerToShimFrame | BrokerToUiFrame;

/** A WebSocket test client that records every inbound frame and lets tests await them in order. */
class FrameClient<In extends Inbound, Out extends ShimToBrokerFrame | UiToBrokerFrame> {
  readonly frames: In[] = [];
  private unconsumed: In[] = [];
  private waiters: (() => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly mk = createFrameFactory<Out>('t');
  /** When true, broker pings are answered automatically. */
  autoPong = true;

  constructor(
    readonly ws: WebSocket,
    schema: typeof BrokerToShimFrameSchema | typeof BrokerToUiFrameSchema,
  ) {
    ws.on('message', (data) => {
      const decoded = decodeFrame(schema, data.toString());
      if (!decoded.ok) throw new Error(`broker sent an invalid frame: ${decoded.error}`);
      const frame = decoded.frame as In;
      this.frames.push(frame);
      if (frame.type === 'ping' && this.autoPong) {
        this.send('pong' as Out['type'], { re: frame.id } as never);
        return;
      }
      this.unconsumed.push(frame);
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        for (const w of this.waiters.splice(0)) w();
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  /** Sends a frame; returns its ID. */
  send<T extends Out['type']>(type: T, payload: PayloadOf<Out, T>): string {
    const frame = this.mk(type, payload);
    this.ws.send(encodeFrame(frame));
    return frame.id;
  }

  /** Sends raw text. */
  sendRaw(text: string): void {
    this.ws.send(text);
  }

  /** Waits for, and consumes, the next unconsumed frame of `type` matching `pred`. */
  async next<T extends In['type']>(
    type: T,
    pred: (f: Extract<In, { type: T }>) => boolean = () => true,
    timeoutMs = WAIT_MS,
  ): Promise<Extract<In, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.unconsumed.findIndex((f) => f.type === type && pred(f as Extract<In, { type: T }>));
      if (idx >= 0) return this.unconsumed.splice(idx, 1)[0] as Extract<In, { type: T }>;
      const left = deadline - Date.now();
      if (left <= 0 || this.ws.readyState === WebSocket.CLOSED) {
        throw new Error(`timed out waiting for ${type}; unconsumed: ${this.unconsumed.map((f) => f.type).join(',')}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Drops every unconsumed frame of `type` (or all), returning them. */
  drain<T extends In['type']>(type?: T): In[] {
    const out = this.unconsumed.filter((f) => !type || f.type === type);
    this.unconsumed = this.unconsumed.filter((f) => type && f.type !== type);
    return out;
  }

  /** Unconsumed frames of `type`, without consuming them. */
  pending<T extends In['type']>(type: T): Extract<In, { type: T }>[] {
    return this.unconsumed.filter((f) => f.type === type) as Extract<In, { type: T }>[];
  }

  /** Round-trips a ping, so every frame sent before it has been processed and its effects received. */
  async sync(): Promise<void> {
    const id = this.send('ping' as Out['type'], {} as never);
    await this.next('pong' as In['type'], (f) => (f.payload as { re: string }).re === id);
  }

  /** Closes the socket and waits for the close. */
  async close(): Promise<void> {
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.close();
    await this.closed;
  }
}

function wsUrl(broker: RunningBroker, path: string): string {
  return `${broker.url.replace(/^http/, 'ws')}${path}`;
}

function connecting(url: string, headers: Record<string, string> = {}): WebSocket {
  return new WebSocket(url, { headers });
}

async function opened(ws: WebSocket): Promise<WebSocket> {
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return ws;
}

/** Identity a fake shim presents in `hello`. */
export interface FakeIdentity {
  sessionId: string;
  hostname?: string;
  cwd?: string;
  defaultName?: string;
  platform?: 'win32' | 'darwin' | 'linux';
  repos?: { key: string; name: string; branch?: string }[];
  token?: string;
}

/** A fake shim speaking the real wire protocol to `/ws/shim`. */
export class FakeShim extends FrameClient<BrokerToShimFrame, ShimToBrokerFrame> {
  /** Opens a socket without saying hello. */
  static async open(broker: RunningBroker): Promise<FakeShim> {
    const shim = new FakeShim(connecting(wsUrl(broker, '/ws/shim')), BrokerToShimFrameSchema);
    await opened(shim.ws);
    return shim;
  }

  /** Opens a socket, says hello and waits for welcome. */
  static async connect(broker: RunningBroker, id: FakeIdentity): Promise<{ shim: FakeShim; welcome: FrameOf<BrokerToShimFrame, 'welcome'> }> {
    const shim = await FakeShim.open(broker);
    const welcome = await shim.hello(broker, id);
    return { shim, welcome };
  }

  /** Sends hello and waits for welcome. */
  async hello(broker: RunningBroker, id: FakeIdentity): Promise<FrameOf<BrokerToShimFrame, 'welcome'>> {
    this.send('hello', helloPayload(broker, id));
    return this.next('welcome');
  }

  /** Sends register and waits for registered. */
  async register(name: string, focus = '', repos: { key: string; name: string }[] = []): Promise<FrameOf<BrokerToShimFrame, 'registered'>> {
    const re = this.send('register', { name, focus, repos });
    return this.next('registered', (f) => f.payload.re === re);
  }

  /** Sends a chat message and waits for its sent or rejected answer. */
  async sendMessage(
    to: string,
    body: string,
    extra: Partial<PayloadOf<ShimToBrokerFrame, 'send'>> = {},
  ): Promise<FrameOf<BrokerToShimFrame, 'sent'> | FrameOf<BrokerToShimFrame, 'rejected'>> {
    const re = this.send('send', { to, kind: 'chat', body, attachments: [], ...extra });
    return this.answer(re);
  }

  /** Waits for the sent or rejected frame answering `re`. */
  async answer(re: string): Promise<FrameOf<BrokerToShimFrame, 'sent'> | FrameOf<BrokerToShimFrame, 'rejected'>> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const sent = this.pending('sent').find((f) => f.payload.re === re);
      if (sent) return this.next('sent', (f) => f === sent);
      const rej = this.pending('rejected').find((f) => f.payload.re === re);
      if (rej) return this.next('rejected', (f) => f === rej);
      if (Date.now() > deadline) throw new Error(`no answer to ${re}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

/** The hello payload for an identity. */
export function helloPayload(broker: RunningBroker, id: FakeIdentity): PayloadOf<ShimToBrokerFrame, 'hello'> {
  const hostname = id.hostname ?? id.sessionId.split(':')[0] ?? 'host';
  return {
    token: id.token ?? broker.shimToken,
    sessionId: id.sessionId,
    hostname,
    platform: id.platform ?? 'win32',
    cwd: id.cwd ?? 'C:/work/repo',
    repos: id.repos ?? [{ key: 'github.com/acme/repo', name: 'repo' }],
    defaultName: id.defaultName ?? `repo@${hostname}`,
    shimVersion: 'test',
    protocolVersion: PROTOCOL_VERSION,
  };
}

/**
 * Logs in at `POST /api/login` and returns the `Cookie` header value for the
 * new Owner session.
 */
export async function login(broker: RunningBroker, token = broker.ownerToken): Promise<string> {
  const res = await fetch(`${broker.url}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (res.status !== 204) throw new Error(`login failed: HTTP ${res.status}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

/** Headers a browser on the broker's own page sends on the `/ws/ui` upgrade. */
export function uiHeaders(broker: RunningBroker, cookie: string): Record<string, string> {
  return { cookie, origin: broker.url };
}

/** A fake web app on `/ws/ui`, logged in as the Owner. */
export class FakeUi extends FrameClient<BrokerToUiFrame, UiToBrokerFrame> {
  /** The Owner cookie this client connected with. */
  cookie = '';

  /** Logs in (or reuses `cookie`), connects from the broker's own origin, and waits for the snapshot. */
  static async connect(broker: RunningBroker, cookie?: string): Promise<{ ui: FakeUi; snapshot: FrameOf<BrokerToUiFrame, 'snapshot'> }> {
    const c = cookie ?? (await login(broker));
    const ui = new FakeUi(connecting(wsUrl(broker, '/ws/ui'), uiHeaders(broker, c)), BrokerToUiFrameSchema);
    ui.cookie = c;
    await opened(ui.ws);
    const snapshot = await ui.next('snapshot');
    return { ui, snapshot };
  }

  /**
   * Tries to connect with arbitrary headers. Resolves to the close code the
   * broker sent, or 101 when a snapshot arrived (the socket is then closed).
   */
  static async tryConnect(broker: RunningBroker, headers: Record<string, string>): Promise<number> {
    const ws = connecting(wsUrl(broker, '/ws/ui'), headers);
    return new Promise<number>((resolve) => {
      ws.once('message', () => {
        resolve(101);
        ws.close();
      });
      ws.once('close', (code) => resolve(code));
      ws.once('error', () => resolve(-1));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? -1));
    });
  }
}
