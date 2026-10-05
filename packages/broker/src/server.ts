import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Fastify from 'fastify';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { HEALTH_PATH, PROTOCOL_VERSION, SHIM_WS_PATH, UI_WS_PATH } from '@orchvis/protocol';
import { OwnerSessions, uiUpgradeVerdict } from './auth.js';
import { systemClock, type Clock } from './clock.js';
import { resolveConfig, type BrokerConfigInput } from './config.js';
import { BrokerCore, type BrokerStats, type Conn, type ConnHandler } from './core.js';
import { createLogger, type LogSink } from './log.js';
import { MediaStore, defaultMediaDir } from './media.js';
import { registerApiRoutes } from './routes.js';
import { WEB_CSP, defaultPublicDir, registerStatic } from './static.js';
import { BROKER_VERSION } from './version.js';

/** Options for {@link startBroker}. */
export interface StartBrokerOptions {
  /** Port to listen on. Overrides `config.port`. Default 0 (ephemeral). */
  port?: number;
  /** Address to bind. Overrides `config.bind`. Default `127.0.0.1`. */
  host?: string;
  /** Config values; anything missing gets a default, and missing tokens are generated. Never read from disk. */
  config?: BrokerConfigInput;
  /** Clock for timestamps, timers, TTLs and rate limits. Default: the system clock. */
  clock?: Clock;
  /** Where structured log lines go. Default: stdout. */
  logSink?: LogSink;
  /** Media directory. Wiped on start and on close. Default: a fresh per-process directory under the OS temp dir. */
  mediaDir?: string;
  /** Built web app to serve at `/`. Default: `packages/broker/public`; a placeholder page is served when it is missing. */
  publicDir?: string;
}

/** A running broker. */
export interface RunningBroker {
  /** Base HTTP URL, such as `http://127.0.0.1:54321`. WebSocket URLs swap the scheme. */
  url: string;
  /** Token shims must present in `hello` and on media requests. */
  shimToken: string;
  /** Owner token, exchanged at `POST /api/login` for the Owner session cookie. */
  ownerToken: string;
  /** This broker's media directory, for tests that inspect it. Deleted on close. */
  mediaDir: string;
  /** Sizes of the broker's in-memory structures, for soak and leak tests. */
  stats(): BrokerStats;
  /** Every media store entry (ID, size, expiry, attached), in upload order, for orphan checks against {@link RunningBroker.mediaDir}. */
  mediaEntries(): { mediaId: string; bytes: number; expiresAt: number; attached: boolean }[];
  /** Closes every connection and the listener, then deletes the media directory. */
  close(): Promise<void>;
}

function wsConn(ws: WebSocket): Conn {
  return {
    send: (text) => {
      if (ws.readyState !== ws.OPEN) return false;
      ws.send(text);
      return true;
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
  const media = new MediaStore(opts.mediaDir ?? defaultMediaDir(), config.limits.mediaStoreBytes);
  const core = new BrokerCore(config.limits, config.shimToken, clock, logger, media);
  const sessions = new OwnerSessions();

  const app = Fastify({ logger: false });
  // Bodies are read by the handlers themselves: login as capped JSON, media as streamed multipart.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, _payload, done) => done(null));
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', WEB_CSP);
  });
  app.setErrorHandler(async (err, _request, reply) => {
    logger.log('http_error', { code: (err as { code?: string }).code ?? 'unknown' });
    if (reply.sent) return;
    return reply.code(500).type('application/json; charset=utf-8').send({ error: 'invalid' });
  });

  app.get(HEALTH_PATH, async () => ({
    ok: true,
    version: BROKER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    nodes: core.nodeCount,
    media: media.files,
  }));
  registerApiRoutes(app, {
    core,
    limits: config.limits,
    clock,
    logger,
    shimToken: config.shimToken,
    ownerToken: config.ownerToken,
    sessions,
  });
  registerStatic(app, opts.publicDir ?? defaultPublicDir());

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
      // Accept, then close with a WS_CLOSE code: a browser cannot read the status of a refused upgrade.
      const verdict = uiUpgradeVerdict(request.headers, sessions);
      uiWss.handleUpgrade(request, socket, head, (ws) => {
        if (!verdict.ok) {
          logger.log('rejected', { endpoint: 'ui', frame: 'upgrade', code: verdict.code, detail: verdict.reason });
          ws.close(verdict.code, verdict.reason);
          return;
        }
        attach(ws, core.openUi(wsConn(ws), verdict.ownerSession));
      });
    } else {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });

  await app.listen({ port: config.port, host: config.bind });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const host = config.bind === '0.0.0.0' || config.bind === '::' ? '127.0.0.1' : config.bind;
  logger.log('listening', { host: config.bind, port, mediaDir: media.dir });

  let closed = false;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    shimToken: config.shimToken,
    ownerToken: config.ownerToken,
    mediaDir: media.dir,
    stats: () => core.stats(),
    mediaEntries: () => media.list(),
    close: async () => {
      if (closed) return;
      closed = true;
      core.dispose();
      for (const ws of [...shimWss.clients, ...uiWss.clients]) ws.terminate();
      shimWss.close();
      uiWss.close();
      await app.close();
      media.wipe();
      logger.log('stopped');
    },
  };
}
