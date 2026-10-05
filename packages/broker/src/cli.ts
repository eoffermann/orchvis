/**
 * Broker command-line entry: `pnpm --filter @orchvis/broker start`.
 *
 * Loads `orchvis.config.json` (from `--config <path>`, `ORCHVIS_CONFIG`, or
 * `~/.orchvis/orchvis.config.json`), creating it with fresh tokens on first
 * run, checks that the port is free, and starts the broker. Human-readable
 * progress goes to stderr; structured logs go to stdout.
 *
 * @packageDocumentation
 */
import { checkPortFree } from './ports.js';

const started = Date.now();

/** Prints one progress line to stderr with seconds since start. */
function progress(text: string): void {
  process.stderr.write(`[orchvis +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}\n`);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  progress('starting orchvis broker; loading modules (a second or two)...');
  const t0 = Date.now();
  const { loadConfig, startBroker, CONFIG_ENV_VARS, LIMIT_ENV_VARS, BROKER_VERSION } = await import('./index.js');
  progress(`modules loaded in ${Date.now() - t0} ms (broker ${BROKER_VERSION})`);

  if (process.argv.includes('--help')) {
    process.stderr.write(
      [
        'Usage: orchvis-broker [--config <path>]',
        '',
        'Config file: --config, else ORCHVIS_CONFIG, else ~/.orchvis/orchvis.config.json.',
        'Environment overrides:',
        ...Object.values(CONFIG_ENV_VARS).map((v) => `  ${v}`),
        ...Object.values(LIMIT_ENV_VARS).map((v) => `  ${v}`),
        '',
      ].join('\n'),
    );
    return;
  }

  const configPath = argValue('--config');
  progress(`reading config${configPath ? ` from ${configPath}` : ''}...`);
  const loaded = loadConfig(configPath ? { path: configPath } : {});
  const { config } = loaded;
  progress(`config: ${loaded.path} (port ${config.port}, bind ${config.bind})`);
  if (loaded.generatedTokens) {
    process.stderr.write(
      [
        '',
        'First run: generated tokens and wrote them to the config file. They are shown once:',
        `  shim token:  ${config.shimToken}`,
        `  owner token: ${config.ownerToken}`,
        'The shim token goes in each machine\'s ~/.orchvis/config.json. The owner token is for the web app login only.',
        '',
      ].join('\n'),
    );
  }

  progress(`checking that port ${config.port} is free on ${config.bind}...`);
  try {
    await checkPortFree(config.port, config.bind);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const why =
      code === 'EADDRINUSE'
        ? `port ${config.port} is already in use on ${config.bind}. Is another broker running? Stop it, or set ORCHVIS_PORT.`
        : `cannot bind ${config.bind}:${config.port}: ${(err as Error).message}`;
    progress(`error: ${why}`);
    process.exitCode = 1;
    return;
  }

  progress('starting HTTP and WebSocket listener...');
  const broker = await startBroker({ config });
  progress(`ready: ${broker.url.replace('127.0.0.1', config.bind === '0.0.0.0' ? '<this host>' : config.bind)}`);
  progress(`shims connect to ${broker.url.replace(/^http/, 'ws')}/ws/shim; health at ${broker.url}/healthz`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    progress(`${signal}: shutting down...`);
    broker.close().then(
      () => progress('stopped'),
      (err: unknown) => {
        progress(`error during shutdown: ${(err as Error).message}`);
        process.exitCode = 1;
      },
    );
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((err: unknown) => {
  progress(`fatal: ${(err as Error).message}`);
  process.exitCode = 1;
});
