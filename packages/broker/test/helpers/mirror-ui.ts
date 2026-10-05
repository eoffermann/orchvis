import WebSocket from 'ws';
import {
  BrokerToUiFrameSchema,
  UI_WS_PATH,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  type BrokerToUiFrame,
  type PayloadOf,
  type UiToBrokerFrame,
} from '@orchvis/protocol';
import { UiStateMirror } from '@orchvis/simulator';
import type { RunningBroker } from '../../src/index.js';
import { login, uiHeaders } from './fake.js';

/**
 * A web app stand-in for long runs: it applies every `/ws/ui` frame to a
 * {@link UiStateMirror} and keeps nothing else, so its memory stays bounded
 * by the broker's own limits. Answers pings, counts frames, and resolves
 * `sent`/`rejected` answers and `pong`s by `re`.
 */
export class MirrorUi {
  readonly mirror = new UiStateMirror();
  /** Frames received, by type. */
  readonly counts: Record<string, number> = {};
  /** Invalid frames received; any entry is a failure. */
  readonly invalid: string[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly mk = createFrameFactory<UiToBrokerFrame>('m');
  private readonly answers = new Map<string, (f: BrokerToUiFrame) => void>();
  private snapshotWaiter: (() => void) | undefined;

  private constructor(
    readonly ws: WebSocket,
    /** The Owner cookie (`name=value`) this client connected with. */
    readonly cookie: string,
  ) {
    ws.on('message', (data) => {
      const decoded = decodeFrame(BrokerToUiFrameSchema, data.toString());
      if (!decoded.ok) {
        this.invalid.push(decoded.error);
        return;
      }
      const f = decoded.frame;
      this.counts[f.type] = (this.counts[f.type] ?? 0) + 1;
      if (f.type === 'ping') {
        this.send('pong', { re: f.id });
        return;
      }
      this.mirror.apply(f);
      if (f.type === 'snapshot') this.snapshotWaiter?.();
      const re = (f.payload as { re?: unknown }).re;
      if (typeof re === 'string') {
        const done = this.answers.get(re);
        if (done) {
          this.answers.delete(re);
          done(f);
        }
      }
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        for (const [, done] of this.answers) done({ type: 'rejected' } as BrokerToUiFrame);
        this.answers.clear();
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  /** Logs in (or reuses `cookie`), connects from the broker's own origin, and waits for the snapshot. */
  static async connect(broker: RunningBroker, cookie?: string): Promise<MirrorUi> {
    const c = cookie ?? (await login(broker));
    const ws = new WebSocket(`${broker.url.replace(/^http/, 'ws')}${UI_WS_PATH}`, { headers: uiHeaders(broker, c) });
    const ui = new MirrorUi(ws, c);
    await new Promise<void>((resolve, reject) => {
      ui.snapshotWaiter = resolve;
      ws.once('error', reject);
      ws.once('close', (code) => reject(new Error(`closed with ${code} before the snapshot`)));
    });
    ui.snapshotWaiter = undefined;
    return ui;
  }

  /** Sends a frame and resolves with the frame answering it (`sent`, `rejected` or `pong`). */
  request<T extends UiToBrokerFrame['type']>(type: T, payload: PayloadOf<UiToBrokerFrame, T>): Promise<BrokerToUiFrame> {
    return new Promise((resolve) => {
      const id = this.send<T>(type, payload as never);
      this.answers.set(id, resolve);
    });
  }

  /** Round-trips a ping, so every delta caused before it has arrived. */
  async sync(): Promise<void> {
    await this.request('ping', {});
  }

  private send<T extends UiToBrokerFrame['type']>(type: T, payload: PayloadOf<UiToBrokerFrame, T>): string {
    const frame = this.mk(type, payload as never);
    this.ws.send(encodeFrame(frame));
    return frame.id;
  }

  /** Closes and waits for the close. */
  async close(): Promise<void> {
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.close();
    await this.closed;
  }
}
