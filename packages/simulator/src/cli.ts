#!/usr/bin/env node
/**
 * `orchvis-sim`: drives a real broker with fake shims, or serves the mock
 * `/ws/ui` feed for the web app.
 *
 *   pnpm --filter @orchvis/simulator sim -- --broker ws://host:7801 --token <shimToken>
 *   pnpm --filter @orchvis/simulator sim -- --mock-ui --port 7811
 *
 * @packageDocumentation
 */
import { parseArgs } from 'node:util';
import { startShimFleet } from './fleet.js';
import { startMockUiFeed } from './mock-ui-feed.js';

const started = Date.now();

/** Writes one flushed progress line with seconds since start. */
function log(line: string): void {
  const t = ((Date.now() - started) / 1000).toFixed(1).padStart(7);
  process.stdout.write(`[${t}s] ${line}\n`);
}

/** Writes one error line to stderr. */
function warn(line: string): void {
  const t = ((Date.now() - started) / 1000).toFixed(1).padStart(7);
  process.stderr.write(`[${t}s] ${line}\n`);
}

const USAGE = `orchvis-sim: fake orchvis traffic

Modes (pick one):
  --broker <url> --token <shimToken>   drive fake shims against a real broker (ws://host:7801)
  --mock-ui [--port <n>]               serve the mock /ws/ui feed (default port 7811)

Options:
  --sessions <n>    sessions (default 30 for --mock-ui, 10 for --broker)
  --hosts <n>       host machines, mixed win32 and darwin (default 4)
  --repos <n>       repositories (default 6)
  --rate <r>        messages per minute on an active pair (default 0.6)
  --media           attach generated media (always on in --mock-ui; off by default for --broker)
  --media-rate <p>  probability a message carries media (default 0.05 when media is on; 0 disables)
  --media-ttl <s>   mock only: media lifetime in seconds (default 2700)
  --host <addr>     mock only: bind address (default 127.0.0.1)
  --owner-token <t> mock only: Owner token the login page must enter (default mock)
  --open            mock only: skip login; /ws/ui accepts any client
  --seed <n>        PRNG seed (default 1)
  --duration <s>    stop after this many seconds (default: run until Ctrl+C)
  --help            this text
`;

function num(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} needs a number, got ${value}`);
  return n;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  const { values } = parseArgs({
    args: argv,
    options: {
      broker: { type: 'string' },
      token: { type: 'string' },
      'mock-ui': { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      'owner-token': { type: 'string' },
      open: { type: 'boolean' },
      sessions: { type: 'string' },
      hosts: { type: 'string' },
      repos: { type: 'string' },
      rate: { type: 'string' },
      media: { type: 'boolean' },
      'media-rate': { type: 'string' },
      'media-ttl': { type: 'string' },
      seed: { type: 'string' },
      duration: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help || (!values['mock-ui'] && !values.broker)) {
    process.stdout.write(USAGE);
    process.exitCode = values.help ? 0 : 2;
    return;
  }
  const seed = num(values.seed, 'seed') ?? 1;
  const hosts = num(values.hosts, 'hosts') ?? 4;
  const repos = num(values.repos, 'repos') ?? 6;
  const rate = num(values.rate, 'rate') ?? 0.6;
  const duration = num(values.duration, 'duration');
  const mediaRateArg = num(values['media-rate'], 'media-rate');
  let stop: () => Promise<void> | void;
  let counters: () => string;

  if (values['mock-ui']) {
    const port = num(values.port, 'port') ?? 7811;
    if (port === 7801) throw new Error('port 7801 is the broker default; pick another for the mock feed');
    const sessions = num(values.sessions, 'sessions') ?? 30;
    const ttl = num(values['media-ttl'], 'media-ttl');
    log(`starting mock /ws/ui feed: ${sessions} sessions, ${hosts} hosts, ${repos} repos, seed ${seed}`);
    const feed = await startMockUiFeed({
      port,
      host: values.host ?? '127.0.0.1',
      nodes: sessions,
      hosts,
      repos,
      seed,
      ...(values.open ? {} : { ownerToken: values['owner-token'] ?? 'mock' }),
      traffic: { rate, mediaRate: mediaRateArg ?? 0.05 },
      ...(ttl !== undefined ? { limits: { mediaTtlMs: Math.round(ttl * 1000) } } : {}),
      onProblem: (p) => warn(`problem: ${p}`),
      onClient: (event, open) => log(`web client ${event}ed (${open} open)`),
    });
    log(`mock feed ready. Open the web app against: ${feed.url}`);
    log(`HTTP (healthz, login, media): ${feed.httpUrl}`);
    log(values.open ? 'login: off (--open)' : `login: Owner token is "${values['owner-token'] ?? 'mock'}"`);
    counters = () => {
      const s = feed.stats;
      const snap = feed.world.snapshot();
      const t = feed.world.engine.stats;
      return (
        `clients ${s.openConnections} | nodes ${snap.nodes.length} edges ${snap.edges.length} ` +
        `messages ${snap.messages.length} media ${snap.media.length} | generated sends ${t.sends} replies ${t.replies} ` +
        `status ${t.statusChanges} disconnects ${t.disconnects} | frames out ${s.framesSent} in ${s.framesReceived} invalid ${s.invalidOutbound}`
      );
    };
    stop = () => feed.close();
  } else {
    if (!values.token) throw new Error('--broker needs --token <shimToken>');
    const sessions = num(values.sessions, 'sessions') ?? 10;
    const mediaRate = values.media || mediaRateArg !== undefined ? (mediaRateArg ?? 0.05) : 0;
    const url = values.broker as string;
    log(`connecting ${sessions} fake shims to ${url} (seed ${seed}, media ${mediaRate > 0 ? `on, rate ${mediaRate}` : 'off'})`);
    const fleet = await startShimFleet({
      url,
      token: values.token,
      sessions,
      hosts,
      repos,
      seed,
      traffic: { rate, mediaRate },
      log: (line) => {
        if (/connected to|reconnecting|invalid|error|failed|rejected/.test(line)) log(line);
      },
    });
    const web = new URL(fleet.shims[0]?.url ?? url);
    web.protocol = web.protocol === 'wss:' ? 'https:' : 'http:';
    web.pathname = '/';
    log(`${sessions} shims registered; traffic running. Open the web app: ${web.toString()}`);
    counters = () => {
      const s = fleet.stats();
      const rejected = Object.entries(s.sendsRejected).map(([k, v]) => `${k}=${v}`).join(',') || '0';
      const connected = fleet.shims.filter((x) => x.isReady).length;
      return (
        `connected ${connected}/${fleet.shims.length} | sent ${s.sendsOk} rejected ${rejected} delivered ${s.delivered} ` +
        `uploads ${s.uploads} (failed ${s.uploadFailures}) reconnects ${s.reconnects} invalid frames ${s.invalidInbound}`
      );
    };
    stop = () => fleet.close();
  }

  const ticker = setInterval(() => log(counters()), 10_000);
  let stopping = false;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(ticker);
    log(`stopping (${reason}). Final: ${counters()}`);
    await stop();
    log('stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('interrupted'));
  process.on('SIGTERM', () => void shutdown('terminated'));
  if (duration !== undefined) {
    log(`will stop after ${duration} s`);
    setTimeout(() => void shutdown('duration reached'), duration * 1000);
  }
}

main().catch((err: unknown) => {
  warn(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
