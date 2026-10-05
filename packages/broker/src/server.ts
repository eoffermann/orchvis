import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Fastify from 'fastify';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, SHIM_WS_PATH, UI_WS_PATH } from '@orchvis/protocol';
import { systemClock, type Clock } from './clock.js';
import { resolveConfig, type BrokerConfigInput } from './config.js';
import { BrokerCore, timingSafeEqualStr, type Conn, type ConnHandler } from './core.js';
import { createLogger, type LogSink } from './log.js';
import { BROKER_VERSION } from './version.js';

/** Name of the cookie carrying the Owner credential on `/ws/ui`. */
export const OWNER_COOKIE = 'orchvis_owner';

/** Options for {@link startBroker}. */
export interface StartBrokerOptions {
  /** Port to listen on. Overrides `config.port`. Default 0 (ephemeral). */
  port?: number;
  /** Address to bind. Overrides `config.bind`. Default `127.0.0.1`. */
  host?: string;
  /** Config values; anything missing gets a default, and missing tokens are generated. Never read from disk. */
  config?: BrokerConfigInput;
  /** Clock for timestamps and timers. Default: the system clock. */
  clock?: Clock;
  /** Where structured log lines go. Default: stdout. */
  logSink?: LogSink;
}

/** A running broker. */
export interface RunningBroker {
  /** Base HTTP URL, such as `http://127.0.0.1:54321`. WebSocket URLs swap the scheme. */
  url: string;
  /** Token shims must present in `hello`. */
  shimToken: string;
  /** Owner token; the `orchvis_owner` cookie must carry it on `/ws/ui`. */
  ownerToken: string;
  /** Closes every connection and the listener. */
  close(): Promise<void>;
}

/** Parses a `Cookie` header into name/value pairs. Malformed pairs are skipped. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * Decides whether a `/ws/ui` upgrade request comes from the Owner: it must
 * carry an `orchvis_owner` cookie equal to the Owner token.
 */
// WP3: replaced by a login session (POST /api/login sets an HttpOnly, SameSite=Strict
// session cookie) plus an Origin check on the upgrade. Keep every /ws/ui auth decision here.
export function authorizeUi(request: IncomingMessage, ownerToken: string): boolean {
  const cookie = parseCookies(request.headers.cookie).get(OWNER_COOKIE);
  return cookie !== undefined && timingSafeEqualStr(cookie, ownerToken);
}

function wsConn(ws: WebSocket): Conn {
  return {
    send: (text) => {
      if (ws.readyState === ws.OPEN) ws.send(text);
    },
    close: (code, reason) => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
    },
  };
}

function attach(ws: WebSocket, handler: ConnHandler): void {
  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      handler.onFrame('');
      return;
    }
    handler.onFrame(Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8'));
  });
  ws.on('close', () => handler.onClose());
  ws.on('error', () => handler.onClose());
}

/**
 * Starts a broker. With no options it binds an ephemeral port on 127.0.0.1
 * with fresh tokens and default limits, which is what tests want. The CLI
 * passes a config loaded from `orchvis.config.json` instead.
 */
export async function startBroker(opts: StartBrokerOptions = {}): Promise<RunningBroker> {
  const config = resolveConfig({
    ...opts.config,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.host !== undefined ? { bind: opts.host } : {}),
  });
  const clock = opts.clock ?? systemClock;
  const logger = createLogger(opts.logSink, () => clock.now());
  const core = new BrokerCore(config.limits, config.shimToken, clock, logger);

  const app = Fastify({ logger: false });
  app.get('/healthz', async () => ({
    ok: true,
    version: BROKER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    nodes: core.nodeCount,
    media: 0,
  }));
  // Placeholder until the web build lands in public/.
  app.get('/', async (_req, reply) =>
    reply.type('text/plain; charset=utf-8').send('orchvis broker is running. The web app is not built yet.\n'),
  );

  const maxPayload = Math.max(1024 * 1024, config.limits.maxBodyBytes * 8);
  const shimWss = new WebSocketServer({ noServer: true, maxPayload });
  const uiWss = new WebSocketServer({ noServer: true, maxPayload });

  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (request.url ?? '').split('?')[0];
    if (path === SHIM_WS_PATH) {
      shimWss.handleUpgrade(request, socket, head, (ws) => {
        attach(ws, core.openShim(wsConn(ws)));
      });
    } else if (path === UI_WS_PATH) {
      if (!authorizeUi(request, config.ownerToken)) {
        logger.log('rejected', { endpoint: 'ui', frame: 'upgrade', code: 'unauthorized', detail: 'owner credential missing or wrong' });
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      uiWss.handleUpgrade(request, socket, head, (ws) => {
        attach(ws, core.openUi(wsConn(ws)));
      });
    } else {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });

  await app.listen({ port: config.port, host: config.bind });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const host = config.bind === '0.0.0.0' || config.bind === '::' ? '127.0.0.1' : config.bind;
  logger.log('listening', { host: config.bind, port });

  let closed = false;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    shimToken: config.shimToken,
    ownerToken: config.ownerToken,
    close: async () => {
      if (closed) return;
      closed = true;
      core.dispose();
      for (const ws of [...shimWss.clients, ...uiWss.clients]) ws.terminate();
      shimWss.close();
      uiWss.close();
      await app.close();
      logger.log('stopped');
    },
  };
}
