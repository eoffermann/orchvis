/** Where log lines go. Receives one complete JSON line, newline included. */
export type LogSink = (line: string) => void;

/** Field values a log line may carry. Never a message body or a token. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Structured logger: one JSON object per line, `{ t, event, ...fields }`.
 * Callers pass only identifiers, codes and counts. Message bodies, captions
 * and tokens must never be passed in.
 */
export interface Logger {
  /** Writes one event. */
  log(event: string, fields?: LogFields): void;
}

/** Default sink: stdout. */
export const stdoutSink: LogSink = (line) => {
  process.stdout.write(line);
};

/** Creates a {@link Logger} writing to `sink`, stamping each line with `now()`. */
export function createLogger(sink: LogSink = stdoutSink, now: () => number = Date.now): Logger {
  return {
    log(event, fields = {}) {
      const record: Record<string, unknown> = { t: new Date(now()).toISOString(), event };
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) record[k] = v;
      sink(`${JSON.stringify(record)}\n`);
    },
  };
}
