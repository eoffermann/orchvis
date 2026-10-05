/**
 * Logging for the shim. stdout carries MCP only, so every log line goes to
 * stderr, written synchronously per line and prefixed with the seconds since
 * the process started, so a stall is easy to spot. Never log message bodies or
 * tokens.
 */

/** A minimal leveled logger. */
export interface Logger {
  /** Progress and state changes. */
  info(message: string): void;
  /** Recoverable problems. */
  warn(message: string): void;
  /** Detail that is only useful when debugging; shown when `ORCHVIS_LOG=debug`. */
  debug(message: string): void;
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Where lines go. Defaults to `process.stderr`. */
  write?: (line: string) => void;
  /** Clock origin for elapsed seconds. Defaults to process start. */
  startedAt?: number;
  /** Emit debug lines. Defaults to `ORCHVIS_LOG=debug`. */
  debug?: boolean;
}

/** Creates a stderr logger with an elapsed-seconds prefix. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const startedAt = options.startedAt ?? Date.now() - Math.round(process.uptime() * 1000);
  const debugOn = options.debug ?? process.env['ORCHVIS_LOG'] === 'debug';
  const emit = (level: string, message: string): void => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    write(`[orchvis +${elapsed}s] ${level} ${message}\n`);
  };
  return {
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    debug: (m) => {
      if (debugOn) emit('debug', m);
    },
  };
}

/** A logger that discards everything, for tests. */
export const silentLogger: Logger = { info: () => {}, warn: () => {}, debug: () => {} };
