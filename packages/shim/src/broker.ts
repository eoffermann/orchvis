import WebSocket from 'ws';
import {
  BrokerToShimFrameSchema,
  DEFAULT_LIMITS,
  PROTOCOL_VERSION,
  REJECT_EXPLANATIONS,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  type BrokerToShimFrame,
  type FrameOf,
  type Limits,
  type Message,
  type PayloadOf,
  type PeerInfo,
  type RejectCode,
  type ShimToBrokerFrame,
} from '@orchvis/protocol';
import type { Logger } from './log.js';

/** `hello` payload without the token, which the client adds. */
export type HelloInfo = Omit<PayloadOf<ShimToBrokerFrame, 'hello'>, 'token' | 'protocolVersion'>;

/** `register` payload. */
export type RegisterPayload = PayloadOf<ShimToBrokerFrame, 'register'>;

/** `send` payload. */
export type SendPayload = PayloadOf<ShimToBrokerFrame, 'send'>;

/** `status` payload. */
export type StatusPayload = PayloadOf<ShimToBrokerFrame, 'status'>;

/** A `welcome` frame's payload. */
export type WelcomePayload = PayloadOf<BrokerToShimFrame, 'welcome'>;

/** A `registered` frame's payload. */
export type RegisteredPayload = PayloadOf<BrokerToShimFrame, 'registered'>;

/** A `rejected` frame's payload. */
export type RejectedPayload = PayloadOf<BrokerToShimFrame, 'rejected'>;

/** Thrown when a request needs the broker and there is no live session with it. */
export class BrokerUnreachableError extends Error {
  /** The URL the client tried. */
  readonly url: string;
  /** Why, in a few words. */
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`broker_unreachable: ${url} (${reason})`);
    this.name = 'BrokerUnreachableError';
    this.url = url;
    this.reason = reason;
  }
}

/** Plain-language rendering of a `rejected` payload. */
export function explainRejection(rejected: Pick<RejectedPayload, 'code' | 'detail'>): string {
  const explanation = REJECT_EXPLANATIONS[rejected.code as RejectCode] ?? '';
  return `${rejected.code}: ${explanation}${rejected.detail ? ` (${rejected.detail})` : ''}`;
}

/** Events from {@link BrokerClient}. */
export interface BrokerEvents {
  /**
   * The session is live: `welcome` arrived and, when a register had been made
   * before, it was resent and answered. Fired on every (re)connect.
   */
  onReady?: (info: { welcome: WelcomePayload; registered: RegisteredPayload | undefined }) => void;
  /** One inbound message. */
  onDeliver?: (message: Message) => void;
  /** The peer list changed (from `welcome`, `registered` or `peers`). */
  onPeers?: (peers: PeerInfo[]) => void;
  /** The connection was lost. */
  onDisconnect?: (reason: string) => void;
}

/** Options for {@link BrokerClient}. */
export interface BrokerClientOptions extends BrokerEvents {
  /** The `/ws/shim` URL. */
  url: string;
  /** Shim token. Never logged. */
  token: string;
  /** Identity for `hello`. */
  hello: HelloInfo;
  log: Logger;
  /** First reconnect delay. Default 1 s. */
  backoffInitialMs?: number;
  /** Maximum reconnect delay. Default 30 s. */
  backoffMaxMs?: number;
  /** How long a request waits for its answer. Default 15 s. */
  requestTimeoutMs?: number;
  /** Random source for jitter, for tests. */
  random?: () => number;
}

type Pending = {
  types: ReadonlyArray<BrokerToShimFrame['type']>;
  resolve: (frame: BrokerToShimFrame) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * Reconnect delay for attempt `n` (0-based): `initial · 2^n` capped at `max`,
 * with jitter that keeps it between half and all of that.
 */
export function backoffDelay(attempt: number, initialMs: number, maxMs: number, random: () => number): number {
  const base = Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 30));
  return Math.round(base / 2 + random() * (base / 2));
}

/**
 * The shim's one outbound WebSocket to the broker. Connects in the background
 * with exponential backoff, sends `hello`, waits for `welcome`, and on every
 * reconnect resends `hello` (always with the original session ID) and the last
 * `register` and `status`. Adopts the canonical session ID from `welcome` and
 * `registered`. Correlates requests with answers by the payload's `re`. Sends
 * heartbeat pings and drops a silent connection.
 */
export class BrokerClient {
  private readonly opts: BrokerClientOptions;
  private ws: WebSocket | undefined;
  private mk = createFrameFactory<ShimToBrokerFrame>('s');
  private readonly pending = new Map<string, Pending>();
  private helloId: string | undefined;
  private welcome: WelcomePayload | undefined;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private lastInbound = 0;
  private stopped = true;
  private lastError = 'connecting';
  private lastRegister: RegisterPayload | undefined;
  private lastStatus: StatusPayload | undefined;
  private canonicalId: string;
  private assignedName: string;

  constructor(options: BrokerClientOptions) {
    this.opts = options;
    this.canonicalId = options.hello.sessionId;
    this.assignedName = options.hello.defaultName;
  }

  /** The URL this client dials. */
  get url(): string {
    return this.opts.url;
  }

  /** Whether `welcome` has been received on the current connection. */
  get ready(): boolean {
    return this.welcome !== undefined && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Limits from the latest `welcome`, or the defaults before one arrives. */
  get limits(): Limits {
    return this.welcome?.limits ?? DEFAULT_LIMITS;
  }

  /** Canonical session ID: the latest one the broker assigned, else the original. */
  get sessionId(): string {
    return this.canonicalId;
  }

  /** Session name as assigned by the broker. */
  get name(): string {
    return this.assignedName;
  }

  /** The reason the client is not ready, for error messages. */
  get notReadyReason(): string {
    return this.lastError;
  }

  /** Starts connecting in the background. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Closes the connection and stops reconnecting. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.teardown('shim stopping');
  }

  /** Throws {@link BrokerUnreachableError} unless the session is live. */
  assertReady(): void {
    if (!this.ready) throw new BrokerUnreachableError(this.opts.url, this.lastError);
  }

  /**
   * Sends `register` and waits for `registered` (or `rejected`). Remembers it so
   * it is resent after a reconnect. When the broker is unreachable it is still
   * remembered, then the call throws.
   */
  async register(payload: RegisterPayload): Promise<RegisteredPayload | RejectedPayload> {
    this.lastRegister = payload;
    const answer = await this.request('register', payload, ['registered']);
    if (answer.type === 'registered') {
      this.adoptRegistered(answer.payload);
      return answer.payload;
    }
    return answer.payload as RejectedPayload;
  }

  /**
   * Sends a `status` frame. Fields accumulate into the last status, which is
   * resent after a reconnect. Throws when the broker is unreachable.
   */
  status(payload: StatusPayload): void {
    this.lastStatus = { ...this.lastStatus, ...payload };
    this.assertReady();
    this.sendFrame(this.mk('status', payload));
  }

  /** Records a status field for resending without requiring a connection. */
  rememberStatus(payload: StatusPayload): void {
    this.lastStatus = { ...this.lastStatus, ...payload };
  }

  /** Sends `seen` for some message IDs, if connected. Returns whether it was sent. */
  seen(ids: string[]): boolean {
    if (!this.ready || ids.length === 0) return false;
    for (let i = 0; i < ids.length; i += 500) {
      this.sendFrame(this.mk('seen', { ids: ids.slice(i, i + 500) }));
    }
    return true;
  }

  /**
   * Sends a frame and waits for the frame whose payload `re` names it and whose
   * type is one of `types`, or a `rejected`. Throws
   * {@link BrokerUnreachableError} when not connected or when no answer comes
   * in time.
   */
  request<T extends ShimToBrokerFrame['type'], R extends BrokerToShimFrame['type']>(
    type: T,
    payload: PayloadOf<ShimToBrokerFrame, T>,
    types: R[],
  ): Promise<FrameOf<BrokerToShimFrame, R> | FrameOf<BrokerToShimFrame, 'rejected'>> {
    this.assertReady();
    const frame = this.mk(type, payload);
    return new Promise((resolve, reject) => {
      const timeoutMs = this.opts.requestTimeoutMs ?? 15_000;
      const timer = setTimeout(() => {
        this.pending.delete(frame.id);
        reject(new BrokerUnreachableError(this.opts.url, `no answer to ${type} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(frame.id, {
        types,
        resolve: resolve as (f: BrokerToShimFrame) => void,
        reject,
        timer,
      });
      this.sendFrame(frame);
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const { url, log } = this.opts;
    log.info(`connecting to broker ${url} (attempt ${this.attempt + 1})`);
    this.mk = createFrameFactory<ShimToBrokerFrame>('s');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    } catch (err) {
      this.lastError = `cannot connect: ${(err as Error).message}`;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.lastInbound = Date.now();
      const hello = this.mk('hello', {
        ...this.opts.hello,
        token: this.opts.token,
        protocolVersion: PROTOCOL_VERSION,
      });
      this.helloId = hello.id;
      this.lastError = 'waiting for welcome';
      log.info(`connected; sent hello as ${this.opts.hello.sessionId}`);
      this.sendFrame(hello);
    });
    ws.on('message', (data) => {
      if (ws !== this.ws) return;
      this.lastInbound = Date.now();
      this.onFrame(data.toString());
    });
    ws.on('error', (err) => {
      if (ws !== this.ws) return;
      const code = (err as NodeJS.ErrnoException).code;
      this.lastError = code ? `${code}: ${err.message}` : err.message;
      log.debug(`broker socket error: ${this.lastError}`);
    });
    ws.on('close', (code) => {
      if (ws !== this.ws) return;
      const wasReady = this.welcome !== undefined;
      if (wasReady) this.lastError = `connection closed (${code})`;
      this.teardown(this.lastError);
      log.info(`broker connection closed (${code}); ${this.lastError}`);
      if (wasReady) this.opts.onDisconnect?.(this.lastError);
      this.scheduleReconnect();
    });
  }

  private onFrame(raw: string): void {
    const decoded = decodeFrame(BrokerToShimFrameSchema, raw);
    if (!decoded.ok) {
      this.opts.log.warn(`ignoring invalid broker frame ${decoded.id || '(no id)'}: ${decoded.error}`);
      return;
    }
    const frame = decoded.frame;
    switch (frame.type) {
      case 'ping':
        this.sendFrame(this.mk('pong', { re: frame.id }));
        return;
      case 'pong':
        return;
      case 'welcome':
        if (frame.payload.re === this.helloId) void this.onWelcome(frame.payload);
        return;
      case 'deliver':
        this.opts.onDeliver?.(frame.payload.message);
        return;
      case 'peers':
        this.opts.onPeers?.(frame.payload.peers);
        return;
      case 'rejected':
        if (frame.payload.re && frame.payload.re === this.helloId) {
          this.lastError = `broker rejected hello: ${explainRejection(frame.payload)}`;
          this.opts.log.warn(this.lastError);
          return;
        }
        this.settle(frame.payload.re, frame);
        return;
      default:
        this.settle(frame.payload.re, frame);
    }
  }

  private settle(re: string, frame: BrokerToShimFrame): void {
    const p = this.pending.get(re);
    if (!p) {
      this.opts.log.debug(`unmatched ${frame.type} for ${re || '(none)'}`);
      return;
    }
    if (frame.type !== 'rejected' && !p.types.includes(frame.type)) {
      this.opts.log.warn(`unexpected ${frame.type} answering ${re}`);
      return;
    }
    this.pending.delete(re);
    clearTimeout(p.timer);
    p.resolve(frame);
  }

  private async onWelcome(welcome: WelcomePayload): Promise<void> {
    this.welcome = welcome;
    this.attempt = 0;
    this.canonicalId = welcome.sessionId;
    this.assignedName = welcome.name;
    this.lastError = 'connected';
    this.opts.log.info(
      `welcome: session ${welcome.sessionId} as ${welcome.name}, ${welcome.peers.length} peer(s), broker ${welcome.brokerVersion}`,
    );
    this.startHeartbeat();
    this.opts.onPeers?.(welcome.peers);

    let registered: RegisteredPayload | undefined;
    if (this.lastRegister) {
      try {
        const answer = await this.request('register', this.lastRegister, ['registered']);
        if (answer.type === 'registered') {
          registered = answer.payload;
          this.adoptRegistered(registered);
        } else {
          this.opts.log.warn(`re-register rejected: ${explainRejection(answer.payload)}`);
        }
      } catch (err) {
        this.opts.log.warn(`re-register failed: ${(err as Error).message}`);
        return;
      }
    }
    if (this.lastStatus && this.ready) this.sendFrame(this.mk('status', this.lastStatus));
    if (this.ready) this.opts.onReady?.({ welcome, registered });
  }

  private adoptRegistered(registered: RegisteredPayload): void {
    if (registered.sessionId !== this.canonicalId) {
      this.opts.log.info(`broker aliased this session to canonical ID ${registered.sessionId}`);
    }
    this.canonicalId = registered.sessionId;
    this.assignedName = registered.name;
    this.opts.onPeers?.(registered.peers);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const { heartbeatIntervalMs, disconnectAfterMs } = this.limits;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastInbound > disconnectAfterMs) {
        this.opts.log.warn(`no traffic from broker for ${disconnectAfterMs} ms; reconnecting`);
        this.lastError = 'broker stopped answering heartbeats';
        this.ws.terminate();
        return;
      }
      this.sendFrame(this.mk('ping', {}));
    }, heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private teardown(reason: string): void {
    this.stopHeartbeat();
    this.welcome = undefined;
    this.helloId = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BrokerUnreachableError(this.opts.url, reason));
      this.pending.delete(id);
    }
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.removeAllListeners('message');
      ws.on('error', () => {});
      try {
        ws.terminate();
      } catch {
        // Already closing.
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = backoffDelay(
      this.attempt,
      this.opts.backoffInitialMs ?? 1000,
      this.opts.backoffMaxMs ?? 30_000,
      this.opts.random ?? Math.random,
    );
    this.attempt++;
    this.opts.log.info(`reconnecting to broker in ${(delay / 1000).toFixed(1)} s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private sendFrame(frame: ShimToBrokerFrame): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeFrame(frame), (err) => {
      if (err) this.opts.log.debug(`send ${frame.type} failed: ${err.message}`);
    });
  }
}
