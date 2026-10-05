import {
  BrokerToUiFrameSchema,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  type ControlAction,
  type PayloadOf,
  type UiToBrokerFrame,
} from '@orchvis/protocol';
import type { Store } from '../store/store';
import { backoffDelay } from './backoff';
import { isUnauthorizedClose, type Transport, type TransportFactory } from './transport';

/** Options for {@link FeedClient}. */
export interface FeedClientOptions {
  /** The store to feed. */
  store: Store;
  /** Opens one connection. */
  connect: TransportFactory;
  /** Local clock. Defaults to `Date.now`. */
  clock?: () => number;
  /** Random source for backoff jitter and frame ID prefixes. */
  random?: () => number;
  /** Timer functions, injectable for tests. */
  timers?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
  /** Diagnostic log. Never receives frame bodies. */
  log?: (line: string) => void;
}

/**
 * Keeps one `/ws/ui` connection alive: validates inbound frames with the
 * protocol schema, feeds the store, answers pings, and reconnects with
 * exponential backoff. Every connection starts with a fresh snapshot, since
 * the store drops sync whenever the connection leaves `open`.
 */
export class FeedClient {
  private readonly store: Store;
  private readonly connectFn: TransportFactory;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly timers: NonNullable<FeedClientOptions['timers']>;
  private readonly log: (line: string) => void;
  private transport: Transport | null = null;
  private attempt = 0;
  private retryHandle: unknown = null;
  private running = false;
  private connectionCount = 0;
  private everOpened = false;
  private mk = createFrameFactory<UiToBrokerFrame>('ui0-');

  /** Creates a client; call {@link FeedClient.start} to connect. */
  constructor(opts: FeedClientOptions) {
    this.store = opts.store;
    this.connectFn = opts.connect;
    this.clock = opts.clock ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.timers = opts.timers ?? {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.log = opts.log ?? ((line) => console.info(`[orchvis] ${line}`));
  }

  /** Connects, and keeps reconnecting until {@link FeedClient.stop}. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.open();
  }

  /** Closes the connection and cancels any retry. */
  stop(): void {
    this.running = false;
    if (this.retryHandle !== null) this.timers.clear(this.retryHandle);
    this.retryHandle = null;
    const t = this.transport;
    this.transport = null;
    t?.close();
  }

  /** Sends an Owner control. Returns the frame ID, or null when not connected. */
  sendControl(action: ControlAction): string | null {
    return this.sendFrame('control', action);
  }

  /** Sends an Owner message (used by the WP6 node chat). Returns the frame ID, or null. */
  sendOwnerMessage(payload: PayloadOf<UiToBrokerFrame, 'owner_send'>): string | null {
    return this.sendFrame('owner_send', payload);
  }

  private sendFrame<T extends UiToBrokerFrame['type']>(type: T, payload: PayloadOf<UiToBrokerFrame, T>): string | null {
    if (!this.transport || this.store.getState().connection !== 'open') return null;
    const frame = this.mk(type, payload);
    this.transport.send(encodeFrame(frame));
    return frame.id;
  }

  private open(): void {
    this.connectionCount += 1;
    // Frame IDs must be unique per connection; a counter prefix with a random
    // tag avoids crypto.randomUUID, which plain-http LAN origins lack.
    const tag = Math.floor(this.random() * 36 ** 4).toString(36);
    this.mk = createFrameFactory<UiToBrokerFrame>(`ui${this.connectionCount}${tag}-`, this.clock);
    this.store.dispatch({ type: 'connection', status: this.everOpened ? 'reconnecting' : 'connecting' });
    // Callbacks from a superseded connection are ignored. A transport may call
    // back synchronously from inside connectFn, so this checks an ID rather
    // than the transport object.
    const id = this.connectionCount;
    const live = () => id === this.connectionCount && this.running;
    const transport = this.connectFn({
      onOpen: () => {
        if (!live()) return;
        this.everOpened = true;
        this.log('feed connected, waiting for snapshot');
        this.store.dispatch({ type: 'connection', status: 'open' });
      },
      onMessage: (raw) => {
        if (!live()) return;
        this.handleRaw(raw);
      },
      onClose: (info) => {
        if (id !== this.connectionCount) return;
        this.transport = null;
        if (!this.running) return;
        if (isUnauthorizedClose(info.code)) {
          // The broker accepts the upgrade and then closes with 4401 when the
          // Owner cookie is missing or stale. Show the login screen; it calls
          // start() again. Any other close is transient.
          this.log(`feed closed (code ${info.code}): Owner cookie refused, login required`);
          this.running = false;
          this.store.dispatch({ type: 'connection', status: 'unauthorized' });
          return;
        }
        const delay = backoffDelay(this.attempt, this.random);
        this.attempt += 1;
        this.log(`feed closed (code ${info.code}); reconnecting in ${delay} ms`);
        this.store.dispatch({ type: 'connection', status: 'reconnecting' });
        this.retryHandle = this.timers.set(() => {
          this.retryHandle = null;
          if (this.running) this.open();
        }, delay);
      },
    });
    if (live()) this.transport = transport;
  }

  private handleRaw(raw: string): void {
    const result = decodeFrame(BrokerToUiFrameSchema, raw);
    if (!result.ok) {
      this.log(`dropped invalid frame ${result.id || '(no id)'}: ${result.error}`);
      return;
    }
    const frame = result.frame;
    if (frame.type === 'ping') {
      this.transport?.send(encodeFrame(this.mk('pong', { re: frame.id })));
      return;
    }
    if (frame.type === 'snapshot') this.attempt = 0;
    this.store.dispatch({ type: 'frame', frame, receivedAt: this.clock() });
  }
}
