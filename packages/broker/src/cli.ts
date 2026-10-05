/**
 * Broker command-line entry: `pnpm --filter @orchvis/broker start`.
 *
 * Loads `orchvis.config.json` (from `--config <path>`, `ORCHVIS_CONFIG`, or
 * `~/.orchvis/orchvis.config.json`), creating it with fresh tokens on first
 * run, checks that the port is free, and starts the broker. Human-readable
 * progress goes to stderr; structured logs go to stdout. No token is ever
 * printed. `--init` only creates the config file (if missing), prints its
 * path and `created` or `exists` on stdout, and exits 0 without binding.
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
        'Usage: orchvis-broker [--config <path>] [--init]',
        '',
        'Config file: --config, else ORCHVIS_CONFIG, else ~/.orchvis/orchvis.config.json.',
        'On first run the broker creates it with a fresh shim token and owner token. Tokens are',
        'never printed; read them from the config file.',
        '',
        '  --init   Create the config file with fresh tokens if it is missing, print its path and',
        '           whether it was created or already existed, then exit without starting.',
        '',
        'Environment overrides:',
        ...Object.values(CONFIG_ENV_VARS).map((v) => `  ${v}`),
        ...Object.values(LIMIT_ENV_VARS).map((v) => `  ${v}`),
        '',
      ].join('\n'),
    );
    return;
  }

  const configPath = argValue('--config');
  const init = process.argv.includes('--init');
  progress(`reading config${configPath ? ` from ${configPath}` : ''}...`);
  // Tokens are never printed: launchers redirect this output to log files.
  const loaded = loadConfig(configPath ? { path: configPath } : {});
  const { config } = loaded;
  if (loaded.generatedTokens) {
    progress(`created config file ${loaded.path}`);
    progress('it holds the shim token (for each machine running sessions) and the owner token (for the web app login)');
  }
  if (init) {
    if (!loaded.generatedTokens) progress(`config file already exists: ${loaded.path}`);
    process.stdout.write(`${loaded.path}\n${loaded.generatedTokens ? 'created' : 'exists'}\n`);
    return;
  }
  progress(`config: ${loaded.path} (port ${config.port}, bind ${config.bind})`);

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
