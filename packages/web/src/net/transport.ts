import { UI_WS_PATH, WS_CLOSE } from '@orchvis/protocol';

/** Why a transport closed. */
export interface CloseInfo {
  /** WebSocket close code (1006 for an abnormal drop). */
  code: number;
  /** Whether the transport ever reached the open state. */
  opened: boolean;
}

/** Callbacks a transport reports to. */
export interface TransportHandlers {
  /** The connection is open and frames may be sent. */
  onOpen(): void;
  /** One raw text frame arrived. It is untrusted until decoded. */
  onMessage(raw: string): void;
  /** The connection closed; it will not be reused. */
  onClose(info: CloseInfo): void;
}

/**
 * One connection's worth of text-frame transport. The real one wraps a
 * WebSocket; the dev fake feed implements the same shape in-process.
 */
export interface Transport {
  /** Sends one raw text frame. Dropped if not open. */
  send(raw: string): void;
  /** Closes the connection. `onClose` still fires. */
  close(): void;
}

/** Opens a new transport that reports to `handlers`. */
export type TransportFactory = (handlers: TransportHandlers) => Transport;

/**
 * Whether a `/ws/ui` close means the Owner cookie was refused, so the login
 * screen should show. Only `WS_CLOSE.unauthorized` (4401) means that; every
 * other code, including `forbiddenOrigin` (4403), is treated as transient and
 * retried with backoff, as the protocol prescribes.
 */
export function isUnauthorizedClose(code: number): boolean {
  return code === WS_CLOSE.unauthorized;
}

/** The `/ws/ui` URL for the page's own origin. */
export function feedUrl(loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}${UI_WS_PATH}`;
}

/** A {@link TransportFactory} over the browser WebSocket. The cookie rides along. */
export function webSocketTransport(url: string = feedUrl()): TransportFactory {
  return (handlers) => {
    const ws = new WebSocket(url);
    let opened = false;
    let closed = false;
    ws.onopen = () => {
      opened = true;
      handlers.onOpen();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') handlers.onMessage(ev.data);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (closed) return;
      closed = true;
      handlers.onClose({ code: ev.code, opened });
    };
    return {
      send(raw) {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      },
      close() {
        ws.close(1000);
      },
    };
  };
}
