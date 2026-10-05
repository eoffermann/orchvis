import {
  BrokerToUiFrameSchema,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  type BrokerToUiFrame,
  type UiToBrokerFrame,
} from '@orchvis/protocol';
import WebSocket from 'ws';
import { UiStateMirror } from '../src/index.js';

/** Waits (in real time) until `check` is true. */
export async function waitUntil(check: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A test client of a `/ws/ui` feed that validates and mirrors every frame. */
export interface UiClient {
  raw: string[];
  frames: BrokerToUiFrame[];
  invalid: string[];
  mirror: UiStateMirror;
  mk: ReturnType<typeof createFrameFactory<UiToBrokerFrame>>;
  send(frame: UiToBrokerFrame): void;
  next<T extends BrokerToUiFrame['type']>(type: T, pred?: (f: Extract<BrokerToUiFrame, { type: T }>) => boolean): Promise<Extract<BrokerToUiFrame, { type: T }>>;
  close(): Promise<void>;
}

/** Connects a validating client to `url`. Resolves once the socket is open. */
export async function connectUiClient(url: string): Promise<UiClient> {
  const ws = new WebSocket(url);
  const client: UiClient = {
    raw: [],
    frames: [],
    invalid: [],
    mirror: new UiStateMirror(),
    mk: createFrameFactory<UiToBrokerFrame>('u'),
    send: (frame) => ws.send(encodeFrame(frame)),
    next: async (type, pred) => {
      let seen = 0;
      for (;;) {
        for (; seen < client.frames.length; seen++) {
          const f = client.frames[seen] as BrokerToUiFrame;
          if (f.type === type && (!pred || pred(f as never))) return f as never;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', () => resolve());
        ws.close();
      }),
  };
  ws.on('message', (data) => {
    const text = data.toString();
    client.raw.push(text);
    const d = decodeFrame(BrokerToUiFrameSchema, text);
    if (!d.ok) {
      client.invalid.push(d.error);
      return;
    }
    client.frames.push(d.frame);
    client.mirror.apply(d.frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return client;
}
