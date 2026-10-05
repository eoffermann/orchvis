import { EventEmitter } from 'node:events';
import {
  BrokerToShimFrameSchema,
  MEDIA_CAPTION_FIELD,
  MEDIA_FILE_FIELD,
  MEDIA_PATH,
  MediaRefSchema,
  SHIM_TOKEN_HEADER,
  UPLOAD_KEY_HEADER,
  PROTOCOL_VERSION,
  SHIM_WS_PATH,
  ShimToBrokerFrameSchema,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  type BrokerToShimFrame,
  type DeliveryMode,
  type FrameOf,
  type Limits,
  type MediaRef,
  type Message,
  type MessageKind,
  type PeerInfo,
  type Platform,
  type RejectCode,
  type RepoRef,
  type SessionId,
  type SessionStatus,
  type ShimToBrokerFrame,
} from '@orchvis/protocol';
import WebSocket from 'ws';
import { realClock, TimerGroup, type Clock, type TimerHandle } from './clock.js';
import type { MediaSample } from './media.js';
import { Rng } from './random.js';

/** Who a fake shim claims to be in `hello`. */
export interface SimShimIdentity {
  hostname: string;
  sessionId: SessionId;
  platform: Platform;
  cwd: string;
  repos: RepoRef[];
  defaultName: string;
}

/** Reconnect backoff: exponential from `initialMs` to `maxMs`, with ± `jitter` fraction. */
export interface BackoffOptions {
  /** Default 1000. */
  initialMs?: number;
  /** Default 30000. */
  maxMs?: number;
  /** Default 0.2 (±20%). */
  jitter?: number;
}

/** Options for {@link SimShim}. */
export interface SimShimOptions {
  /** Broker URL: `ws://host:port/ws/shim`, or `ws://host:port` (the path is added). */
  url: string;
  /** Shim token, sent in `hello` and as `X-Orchvis-Token` on uploads. */
  token: string;
  identity: SimShimIdentity;
  /** `push` marks each delivery seen at once; `poll` batches them like a polling session. Default `push`. */
  persona?: DeliveryMode;
  /** Clock for timestamps, backoff, heartbeats and poll batches. Default the real clock. */
  clock?: Clock;
  /** RNG for backoff jitter and poll intervals. Default `new Rng(1)`. */
  rng?: Rng;
  backoff?: BackoffOptions;
  /** Mean interval between poll-persona seen batches, in ms. Default 20000. */
  pollIntervalMs?: number;
  /** Reconnect after an unexpected close. Default true. */
  reconnect?: boolean;
  /** After each `welcome`, send `status { delivery: persona }`. Default true. */
  announceDelivery?: boolean;
  /** Send `ping` every `limits.heartbeatIntervalMs`. Default true. */
  heartbeat?: boolean;
  /** Frames kept for {@link SimShim.next}; the oldest are dropped beyond this. Default 1000. */
  bufferLimit?: number;
  /** Reported as `shimVersion`. Default `sim-0.1.0`. */
  shimVersion?: string;
  /** Receives one line per notable event (connect, reconnect, invalid frame). */
  log?: (line: string) => void;
}

/** A message draft for {@link SimShim.send}. */
export interface SendDraft {
  /** Peer name, session ID, or `owner`. */
  to: string;
  kind?: MessageKind;
  body: string;
  replyTo?: string;
  /** Media IDs from {@link SimShim.uploadMedia}. */
  attachments?: string[];
}

/** Outcome of a send. `broker_unreachable` means the shim was not connected, as a real shim would report. */
export type SendResult =
  | { ok: true; messageId: string; threadId: string; ts: number }
  | { ok: false; code: RejectCode | 'broker_unreachable'; detail: string };

/** Counters kept by a {@link SimShim}. */
export interface SimShimStats {
  framesIn: number;
  framesOut: number;
  /** Inbound frames that failed `BrokerToShimFrameSchema`. Any entry is a test failure. */
  invalidInbound: string[];
  /** Deliveries of a message ID already delivered (expected after a reconnect). */
  duplicateDeliveries: number;
  delivered: number;
  sent: number;
  rejected: number;
  connects: number;
  reconnectsScheduled: number;
}

type BrokerFrameType = BrokerToShimFrame['type'];
type BrokerFrame<T extends BrokerFrameType> = FrameOf<BrokerToShimFrame, T>;

interface Waiter {
  type: BrokerFrameType;
  predicate: (frame: BrokerToShimFrame) => boolean;
  resolve: (frame: BrokerToShimFrame) => void;
}

interface PendingRequest {
  resolve: (frame: BrokerToShimFrame | undefined) => void;
}

/**
 * A fake shim: a client of the real wire protocol on a broker's `/ws/shim`.
 * It sends `hello`, handles `welcome`, registers, sends messages, receives and
 * dedupes `deliver`, marks messages seen (at once or in batches, by persona),
 * reports status, answers and sends heartbeats, requests threads, uploads
 * media, and reconnects with backoff, resending `hello` and the last
 * `register`. Every inbound frame is validated; failures land in
 * `stats.invalidInbound`.
 *
 * Events: `frame` (every valid inbound frame), one event per frame type
 * (`deliver`, `welcome`, ...), `connected`, `disconnected`, `reconnecting`
 * (delay in ms) and `invalid` (reason).
 */
export class SimShim extends EventEmitter {
  /** Counters. */
  readonly stats: SimShimStats = {
    framesIn: 0,
    framesOut: 0,
    invalidInbound: [],
    duplicateDeliveries: 0,
    delivered: 0,
    sent: 0,
    rejected: 0,
    connects: 0,
    reconnectsScheduled: 0,
  };
  /** Canonical session ID: from the identity, then from `welcome` and `registered`. */
  sessionId: SessionId;
  /** Name the broker assigned, once welcomed. */
  name: string | undefined;
  /** Limits from the last `welcome`. */
  limits: Limits | undefined;
  /** Upload key from the last `welcome`, sent on media uploads. */
  uploadKey: string | undefined;
  /** Latest peer list. */
  peers: PeerInfo[] = [];
  /** The persona in force. */
  readonly persona: DeliveryMode;

  private readonly opts: SimShimOptions;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly timers: TimerGroup;
  private ws: WebSocket | undefined;
  private mk = createFrameFactory<ShimToBrokerFrame>('s');
  private connection = 0;
  private welcomed = false;
  private closed = false;
  private attempt = 0;
  private reconnectTimer: TimerHandle | undefined;
  private stopHeartbeat: (() => void) | undefined;
  private lastRegister: { name: string; focus: string; repos: RepoRef[] } | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly buffer: BrokerToShimFrame[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly deliveredIds = new Set<string>();
  private readonly unseen = new Map<string, Message>();

  /** Creates a shim. Call {@link SimShim.start} to connect. */
  constructor(options: SimShimOptions) {
    super();
    this.opts = options;
    this.clock = options.clock ?? realClock;
    this.rng = options.rng ?? new Rng(1);
    this.timers = new TimerGroup(this.clock);
    this.sessionId = options.identity.sessionId;
    this.persona = options.persona ?? 'push';
  }

  /** WebSocket URL in use. */
  get url(): string {
    const u = new URL(this.opts.url);
    if (u.pathname === '/' || u.pathname === '') u.pathname = SHIM_WS_PATH;
    return u.toString();
  }

  /** Whether the shim is connected and welcomed. */
  get isReady(): boolean {
    return this.welcomed && this.ws?.readyState === WebSocket.OPEN;
  }

  private log(line: string): void {
    this.opts.log?.(`[${this.name ?? this.opts.identity.defaultName}] ${line}`);
  }

  /** Connects. Resolves on the first `welcome`. */
  start(): Promise<BrokerFrame<'welcome'>> {
    const welcome = this.next('welcome', undefined, 0);
    this.connect();
    return welcome;
  }

  private connect(): void {
    if (this.closed) return;
    this.reconnectTimer = undefined;
    this.connection++;
    this.mk = createFrameFactory<ShimToBrokerFrame>(`s${this.connection}-`, () => this.clock.now());
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.stats.connects++;
      this.emit('connected');
      this.log(`connected to ${this.url}`);
      const id = this.opts.identity;
      this.write(
        this.mk('hello', {
          token: this.opts.token,
          sessionId: this.sessionId,
          hostname: id.hostname,
          platform: id.platform,
          cwd: id.cwd,
          repos: id.repos,
          defaultName: id.defaultName,
          shimVersion: this.opts.shimVersion ?? 'sim-0.1.0',
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    });
    ws.on('message', (data) => {
      if (this.ws === ws) this.onRaw(data.toString());
    });
    ws.on('error', (err) => {
      if (this.ws === ws) this.log(`socket error: ${err.message}`);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.onClosed();
    });
  }

  private onClosed(): void {
    const wasWelcomed = this.welcomed;
    this.ws = undefined;
    this.welcomed = false;
    this.stopHeartbeat?.();
    this.stopHeartbeat = undefined;
    for (const [, p] of this.pending) p.resolve(undefined);
    this.pending.clear();
    if (wasWelcomed) this.emit('disconnected');
    if (this.closed || this.opts.reconnect === false || this.reconnectTimer) return;
    this.scheduleReconnect(this.backoffDelay());
  }

  /** Next backoff delay: exponential, capped, with jitter. Advances the attempt counter. */
  private backoffDelay(): number {
    const b = this.opts.backoff ?? {};
    const initial = b.initialMs ?? 1000;
    const max = b.maxMs ?? 30_000;
    const jitter = b.jitter ?? 0.2;
    const base = Math.min(max, initial * 2 ** this.attempt);
    this.attempt++;
    return Math.max(0, Math.round(base * (1 + this.rng.range(-jitter, jitter))));
  }

  private scheduleReconnect(delayMs: number): void {
    const delay = Math.round(delayMs);
    this.stats.reconnectsScheduled++;
    this.emit('reconnecting', delay);
    this.log(`reconnecting in ${delay} ms`);
    this.reconnectTimer = this.timers.after(delay, () => this.connect());
  }

  private write(frame: ShimToBrokerFrame): boolean {
    const check = ShimToBrokerFrameSchema.safeParse(frame);
    if (!check.success) throw new Error(`simulator bug: invalid outbound ${frame.type}: ${check.error.issues[0]?.message ?? ''}`);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    this.stats.framesOut++;
    ws.send(encodeFrame(frame));
    return true;
  }

  private onRaw(raw: string): void {
    this.stats.framesIn++;
    const decoded = decodeFrame(BrokerToShimFrameSchema, raw);
    if (!decoded.ok) {
      this.stats.invalidInbound.push(decoded.error);
      this.emit('invalid', decoded.error);
      this.log(`invalid frame: ${decoded.error}`);
      return;
    }
    const frame = decoded.frame;
    switch (frame.type) {
      case 'welcome':
        this.welcomed = true;
        this.attempt = 0;
        this.sessionId = frame.payload.sessionId;
        this.name = frame.payload.name;
        this.limits = frame.payload.limits;
        this.uploadKey = frame.payload.uploadKey;
        this.peers = frame.payload.peers;
        this.onWelcome();
        break;
      case 'registered':
        this.sessionId = frame.payload.sessionId;
        this.name = frame.payload.name;
        this.peers = frame.payload.peers;
        break;
      case 'peers':
        this.peers = frame.payload.peers;
        break;
      case 'ping':
        this.write(this.mk('pong', { re: frame.id }));
        break;
      case 'deliver':
        if (!this.onDeliver(frame)) return;
        break;
      case 'rejected':
        if (frame.payload.re && !this.pending.has(frame.payload.re)) this.log(`rejected ${frame.payload.code}: ${frame.payload.detail}`);
        break;
      default:
        break;
    }
    if ('re' in frame.payload && typeof frame.payload.re === 'string') {
      const p = this.pending.get(frame.payload.re);
      if (p) {
        this.pending.delete(frame.payload.re);
        p.resolve(frame);
      }
    }
    this.dispatch(frame);
  }

  private dispatch(frame: BrokerToShimFrame): void {
    this.emit('frame', frame);
    this.emit(frame.type, frame);
    const i = this.waiters.findIndex((w) => w.type === frame.type && w.predicate(frame));
    if (i !== -1) {
      const [w] = this.waiters.splice(i, 1);
      w?.resolve(frame);
      return;
    }
    this.buffer.push(frame);
    const limit = this.opts.bufferLimit ?? 1000;
    if (this.buffer.length > limit) this.buffer.splice(0, this.buffer.length - limit);
  }

  private onWelcome(): void {
    this.log(`welcomed as ${this.name} (${this.sessionId})`);
    if (this.opts.heartbeat !== false && this.limits) {
      this.stopHeartbeat?.();
      this.stopHeartbeat = this.timers.every(this.limits.heartbeatIntervalMs, () => {
        this.write(this.mk('ping', {}));
      });
    }
    if (this.lastRegister) {
      const r = this.lastRegister;
      this.write(this.mk('register', { name: r.name, focus: r.focus, repos: r.repos }));
    }
    if (this.opts.announceDelivery !== false) this.write(this.mk('status', { delivery: this.persona }));
    if (this.persona === 'push') this.flushSeen();
    else this.schedulePoll();
  }

  /** Records a delivery. Returns false for a duplicate, which is not dispatched. */
  private onDeliver(frame: BrokerFrame<'deliver'>): boolean {
    const m = frame.payload.message;
    if (this.deliveredIds.has(m.id)) {
      this.stats.duplicateDeliveries++;
      // The broker still thinks it is unread, so say again that it was read.
      if (!this.unseen.has(m.id) && this.persona === 'push') this.sendSeen([m.id]);
      return false;
    }
    this.deliveredIds.add(m.id);
    if (this.deliveredIds.size > 20_000) this.deliveredIds.delete(this.deliveredIds.values().next().value as string);
    this.stats.delivered++;
    if (this.persona === 'push') this.sendSeen([m.id]);
    else this.unseen.set(m.id, m);
    return true;
  }

  private sendSeen(ids: string[]): void {
    for (let i = 0; i < ids.length; i += 500) this.write(this.mk('seen', { ids: ids.slice(i, i + 500) }));
  }

  private pollTimer: TimerHandle | undefined;

  private schedulePoll(): void {
    if (this.pollTimer) return;
    const mean = this.opts.pollIntervalMs ?? 20_000;
    this.pollTimer = this.timers.after(this.rng.range(mean * 0.5, mean * 1.5), () => {
      this.pollTimer = undefined;
      if (this.closed) return;
      this.flushSeen();
      this.schedulePoll();
    });
  }

  /** Marks every unread delivery seen now (what `check_inbox` does). */
  flushSeen(filter?: (m: Message) => boolean): void {
    if (!this.isReady) return;
    const ids = [...this.unseen.values()].filter((m) => !filter || filter(m)).map((m) => m.id);
    if (ids.length === 0) return;
    for (const id of ids) this.unseen.delete(id);
    this.sendSeen(ids);
  }

  /** Number of deliveries not yet marked seen. */
  get unreadCount(): number {
    return this.unseen.size;
  }

  private request<T extends BrokerFrameType>(frame: ShimToBrokerFrame): Promise<BrokerFrame<T> | BrokerFrame<'rejected'> | undefined> {
    return new Promise((resolve) => {
      if (!this.write(frame)) {
        resolve(undefined);
        return;
      }
      this.pending.set(frame.id, { resolve: resolve as (f: BrokerToShimFrame | undefined) => void });
    });
  }

  /**
   * Sets name, focus and extra repos. Remembered and resent after every
   * reconnect. Resolves with `registered`, `rejected`, or undefined when not connected.
   */
  async register(name: string, focus: string, repos: RepoRef[] = []): Promise<BrokerFrame<'registered'> | BrokerFrame<'rejected'> | undefined> {
    this.lastRegister = { name, focus, repos };
    return this.request<'registered'>(this.mk('register', { name, focus, repos }));
  }

  /** Sends a message. Fails fast with `broker_unreachable` when not connected. */
  async send(draft: SendDraft): Promise<SendResult> {
    if (!this.isReady) return { ok: false, code: 'broker_unreachable', detail: `not connected to ${this.url}` };
    // A polling session marks a thread read when it next sends on it.
    if (this.persona === 'poll') {
      this.flushSeen((m) =>
        draft.to === 'owner'
          ? m.from.kind === 'owner'
          : m.from.kind === 'session' && (m.from.id === draft.to || m.fromName === draft.to),
      );
    }
    const payload: FrameOf<ShimToBrokerFrame, 'send'>['payload'] = {
      to: draft.to,
      kind: draft.kind ?? 'chat',
      body: draft.body,
      attachments: draft.attachments ?? [],
    };
    if (draft.replyTo !== undefined) payload.replyTo = draft.replyTo;
    const frame = this.mk('send', payload);
    if (!ShimToBrokerFrameSchema.safeParse(frame).success) return { ok: false, code: 'invalid', detail: 'draft fails the send schema' };
    const answer = await this.request<'sent'>(frame);
    if (!answer) return { ok: false, code: 'broker_unreachable', detail: 'connection lost before an answer' };
    if (answer.type === 'rejected') {
      this.stats.rejected++;
      return { ok: false, code: answer.payload.code, detail: answer.payload.detail };
    }
    this.stats.sent++;
    return { ok: true, messageId: answer.payload.messageId, threadId: answer.payload.threadId, ts: answer.payload.ts };
  }

  /** Reports a status, focus or delivery change. Returns false when not connected. */
  setStatus(change: { status?: SessionStatus; focus?: string; delivery?: DeliveryMode }): boolean {
    if (change.status === undefined && change.focus === undefined && change.delivery === undefined) return false;
    return this.write(this.mk('status', change));
  }

  /** Asks for recent history with a peer. */
  async threadRequest(peer: string, limit?: number): Promise<BrokerFrame<'thread'> | BrokerFrame<'rejected'> | undefined> {
    const payload: FrameOf<ShimToBrokerFrame, 'thread_request'>['payload'] = { peer };
    if (limit !== undefined) payload.limit = limit;
    return this.request<'thread'>(this.mk('thread_request', payload));
  }

  /** Sends a heartbeat and resolves with the `pong`. */
  async ping(): Promise<BrokerFrame<'pong'> | undefined> {
    const answer = await this.request<'pong'>(this.mk('ping', {}));
    return answer?.type === 'pong' ? answer : undefined;
  }

  /**
   * Resolves with the next inbound frame of `type` matching `predicate`,
   * taking it from the buffer if one already arrived. Rejects after
   * `timeoutMs` of real time (default 5000; 0 waits forever).
   */
  next<T extends BrokerFrameType>(type: T, predicate?: (frame: BrokerFrame<T>) => boolean, timeoutMs = 5000): Promise<BrokerFrame<T>> {
    const match = (f: BrokerToShimFrame) => f.type === type && (!predicate || predicate(f as BrokerFrame<T>));
    const i = this.buffer.findIndex(match);
    if (i !== -1) return Promise.resolve(this.buffer.splice(i, 1)[0] as BrokerFrame<T>);
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        type,
        predicate: match,
        resolve: (f) => {
          if (timer) clearTimeout(timer);
          resolve(f as BrokerFrame<T>);
        },
      };
      this.waiters.push(waiter);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const j = this.waiters.indexOf(waiter);
          if (j !== -1) this.waiters.splice(j, 1);
          reject(new Error(`timed out after ${timeoutMs} ms waiting for ${type}`));
        }, timeoutMs);
      }
    });
  }

  /** Drops the connection as a network failure would; the shim reconnects with backoff. */
  dropConnection(): void {
    this.ws?.terminate();
  }

  /** Drops the connection and stays away for `downMs` before reconnecting (backoff is not used). */
  disconnectFor(downMs: number): void {
    if (!this.ws || this.closed) return;
    const ws = this.ws;
    this.ws = undefined;
    ws.terminate();
    this.onClosedManually(downMs);
  }

  private onClosedManually(downMs: number): void {
    const wasWelcomed = this.welcomed;
    this.welcomed = false;
    this.stopHeartbeat?.();
    this.stopHeartbeat = undefined;
    for (const [, p] of this.pending) p.resolve(undefined);
    this.pending.clear();
    if (wasWelcomed) this.emit('disconnected');
    this.timers.cancel(this.reconnectTimer);
    this.scheduleReconnect(downMs);
  }

  /** Uploads a file to the broker's `POST /api/media` and returns the validated `MediaRef`. */
  async uploadMedia(sample: Pick<MediaSample, 'data' | 'mime' | 'filename' | 'caption'>): Promise<MediaRef> {
    const u = new URL(this.url);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = MEDIA_PATH;
    if (!this.uploadKey) throw new Error('upload failed: no upload key yet (not welcomed)');
    const form = new FormData();
    form.append(MEDIA_FILE_FIELD, new Blob([sample.data as Uint8Array<ArrayBuffer>], { type: sample.mime }), sample.filename);
    form.append(MEDIA_CAPTION_FIELD, sample.caption);
    const headers = { [SHIM_TOKEN_HEADER]: this.opts.token, [UPLOAD_KEY_HEADER]: this.uploadKey };
    const res = await fetch(u, { method: 'POST', headers, body: form });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    const ref = MediaRefSchema.safeParse(await res.json());
    if (!ref.success) throw new Error(`upload returned an invalid MediaRef: ${ref.error.issues[0]?.message ?? ''}`);
    return ref.data;
  }

  /** Closes for good: no reconnect, all timers cancelled. */
  close(): void {
    this.closed = true;
    this.timers.close();
    const ws = this.ws;
    this.ws = undefined;
    for (const [, p] of this.pending) p.resolve(undefined);
    this.pending.clear();
    ws?.close();
  }
}
