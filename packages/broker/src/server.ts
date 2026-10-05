import Fastify from 'fastify';
import { PROTOCOL_VERSION } from '@orchvis/protocol';
import { systemClock, type Clock } from './clock.js';
import { resolveConfig, type BrokerConfigInput } from './config.js';
import { createLogger, type LogSink } from './log.js';
import { BROKER_VERSION } from './version.js';

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

/**
 * Starts a broker. With no options it binds an ephemeral port on 127.0.0.1
 * with fresh tokens and default limits, which is what tests want.
 */
export async function startBroker(opts: StartBrokerOptions = {}): Promise<RunningBroker> {
  const config = resolveConfig({
    ...opts.config,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.host !== undefined ? { bind: opts.host } : {}),
  });
  const clock = opts.clock ?? systemClock;
  const logger = createLogger(opts.logSink, () => clock.now());

  const app = Fastify({ logger: false });
  app.get('/healthz', async () => ({
    ok: true,
    version: BROKER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    nodes: 0,
    media: 0,
  }));

  await app.listen({ port: config.port, host: config.bind });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const host = config.bind === '0.0.0.0' || config.bind === '::' ? '127.0.0.1' : config.bind;
  logger.log('listening', { host: config.bind, port });

  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    shimToken: config.shimToken,
    ownerToken: config.ownerToken,
    close: async () => {
      await app.close();
    },
  };
}
