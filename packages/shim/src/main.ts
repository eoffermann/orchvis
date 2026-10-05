/**
 * Entry point of the bundled shim (`dist/shim.cjs`). stdout carries MCP only;
 * every log line goes to stderr. Exits when stdin closes.
 */
import { startShim } from './app.js';
import { createLogger } from './log.js';
import { SHIM_VERSION } from './version.js';

const log = createLogger();
log.info(`orchvis shim ${SHIM_VERSION} starting (pid ${process.pid}, node ${process.version})`);

process.on('uncaughtException', (err) => {
  log.warn(`uncaught exception: ${err.stack ?? err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.warn(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

startShim({
  log,
  onExit: () => {
    log.info('exited cleanly');
    process.exit(0);
  },
})
  .then((shim) => {
    const stop = (signal: string) => void shim.shutdown(signal);
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
  })
  .catch((err: unknown) => {
    log.warn(`failed to start: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  });
