/**
 * Real-time soak (WP9, plan "Testing strategy: Soak"): 10 simulated sessions
 * for 60 minutes of wall time against a real broker with media churn. Opt-in
 * and never part of `pnpm check`:
 *
 *   ORCHVIS_SOAK=1 pnpm --filter @orchvis/broker soak
 *
 * Optional: ORCHVIS_SOAK_MINUTES (default 60), ORCHVIS_SOAK_SESSIONS (10),
 * ORCHVIS_SOAK_SEED (1). Prints a progress line at least every 30 s and exits
 * non-zero if any check fails. The compressed version that runs in CI is
 * `test/soak.test.ts`.
 *
 * Checks, every 30 s: the media directory stays under its cap (plus at most
 * one upload in flight), no file on disk is missing from the index for two
 * checks in a row (an orphan, as opposed to an upload being written), the
 * broker's structures stay bounded, and heap after forced GC is recorded. At
 * the end: traffic stops, a fresh web client's snapshot must equal the state a
 * long-lived one replayed from deltas, and heap must not have grown more than
 * the tolerance from the first steady-state reading.
 */
const t0 = Date.now();
const log = (line: string) => process.stdout.write(`[soak +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}\n`);

if (process.env['ORCHVIS_SOAK'] !== '1') {
  process.stdout.write('soak: opt-in only. Run with ORCHVIS_SOAK=1 (60 minutes of wall time; ORCHVIS_SOAK_MINUTES to change).\n');
  process.exit(0);
}

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  process.stderr.write('soak: run with node --expose-gc (the package script does this)\n');
  process.exit(2);
}

const minutes = Number(process.env['ORCHVIS_SOAK_MINUTES'] ?? '60');
const sessions = Number(process.env['ORCHVIS_SOAK_SESSIONS'] ?? '10');
const seed = Number(process.env['ORCHVIS_SOAK_SEED'] ?? '1');
const PROGRESS_MS = 30_000;
const CAP = 64 * 1024;
const TTL_MS = 3 * 60_000;
/** Largest generated media file is a few KB; one upload may be on disk before it is indexed. */
const IN_FLIGHT_SLACK = 64 * 1024;
const HEAP_TOLERANCE = 8 * 1024 * 1024;

log(`loading broker and simulator (TypeScript compiled on the fly; a few seconds) ...`);
const { readdirSync, statSync } = await import('node:fs');
const { join } = await import('node:path');
const { getHeapStatistics } = await import('node:v8');
const { startBroker } = await import('../src/index.js');
const { diffUiStates, startShimFleet } = await import('@orchvis/simulator');
const { MirrorUi } = await import('../test/helpers/mirror-ui.js');
log('loaded');

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) {
    failures.push(what);
    log(`CHECK FAILED: ${what}`);
  }
};
const heap = () => {
  gc();
  gc();
  return getHeapStatistics().used_heap_size;
};
const mib = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;

log(`starting broker: media cap ${CAP} B, TTL ${TTL_MS / 1000} s, ring buffer 100`);
const events: Record<string, number> = {};
const broker = await startBroker({
  port: 0,
  config: { limits: { mediaStoreBytes: CAP, mediaTtlMs: TTL_MS, ringBufferPerThread: 100 } },
  logSink: (line) => {
    const event = /"event":"([a-z_]+)"/.exec(line)?.[1] ?? 'unknown';
    events[event] = (events[event] ?? 0) + 1;
  },
});
log(`broker at ${broker.url}, media dir ${broker.mediaDir}`);

const ui = await MirrorUi.connect(broker);
log(`connecting ${sessions} simulated sessions ...`);
const fleet = await startShimFleet({
  url: `${broker.url.replace(/^http/, 'ws')}/ws/shim`,
  token: broker.shimToken,
  sessions,
  hosts: 3,
  repos: 4,
  seed,
  traffic: { rate: 6, mediaRate: 0.3, ownerRatePerHour: 60, statusMeanMs: 60_000, disconnectMeanMs: 10 * 60_000, hostileRate: 0.05 },
});
log(`fleet running for ${minutes} min; progress every ${PROGRESS_MS / 1000} s`);

const heaps: { at: number; bytes: number }[] = [];
let suspects = new Set<string>();
let maxDir = 0;

function progress(): void {
  const entries = broker.mediaEntries();
  const indexed = new Set(entries.map((e) => e.mediaId));
  const files = readdirSync(broker.mediaDir);
  let dirBytes = 0;
  for (const f of files) {
    try {
      dirBytes += statSync(join(broker.mediaDir, f)).size;
    } catch {
      // Removed between listing and stat.
    }
  }
  maxDir = Math.max(maxDir, dirBytes);
  check(dirBytes <= CAP + IN_FLIGHT_SLACK, `media dir ${dirBytes} B over cap ${CAP} B + in-flight slack`);
  const unindexed = new Set(files.filter((f) => !indexed.has(f)));
  const orphans = [...unindexed].filter((f) => suspects.has(f));
  check(orphans.length === 0, `orphaned media files: ${orphans.join(', ')}`);
  suspects = unindexed;
  const s = broker.stats();
  check(s.indexedMessages === s.bufferedMessages, `message index ${s.indexedMessages} != buffered ${s.bufferedMessages}`);
  check(s.bufferedMessages <= s.threads * 100, `buffered ${s.bufferedMessages} over ${s.threads} threads x 100`);
  check(s.uploadKeys <= s.shimLinks && s.shimLinks <= sessions, `links ${s.shimLinks}, upload keys ${s.uploadKeys}`);
  check(s.uiLinks === 1, `ui links ${s.uiLinks}`);
  const h = heap();
  heaps.push({ at: Date.now() - t0, bytes: h });
  const f = fleet.stats();
  log(
    `heap ${mib(h)}, rss ${mib(process.memoryUsage().rss)}; sent ${f.sendsOk}, delivered ${f.delivered}, uploads ${f.uploads}; ` +
      `buffered ${s.bufferedMessages} in ${s.threads} threads; media ${s.mediaFiles} files ${dirBytes}/${CAP} B; ` +
      `expired ${events['media_expired'] ?? 0}, evicted ${events['media_evicted'] ?? 0}; connected ${s.connectedNodes}/${s.nodes}; ` +
      `failures ${failures.length}`,
  );
}

const timer = setInterval(progress, PROGRESS_MS);
await new Promise((r) => setTimeout(r, minutes * 60_000));
clearInterval(timer);
progress();

log('stopping traffic and letting the feed settle ...');
fleet.engine?.stop();
await new Promise((r) => setTimeout(r, 3_000));
await ui.sync();
const fresh = await MirrorUi.connect(broker);
const diff = diffUiStates(ui.mirror.state(), fresh.mirror.state(), fresh.mirror.state().now);
check(diff.length === 0, `snapshot differs from replayed deltas: ${diff.slice(0, 5).join('; ')}`);
check(ui.invalid.length === 0, `invalid UI frames: ${ui.invalid.length}`);
check(fleet.stats().invalidInbound === 0, `invalid shim frames: ${fleet.stats().invalidInbound}`);

// The first half is warm-up: ring buffers (100 per thread) take about half an hour to fill at this rate.
const steady = heaps.filter((h) => h.at >= (minutes * 60_000) / 2);
if (steady.length >= 2) {
  const base = steady[0]?.bytes ?? 0;
  const worst = Math.max(...steady.map((h) => h.bytes - base));
  log(`heap growth from ${Math.round((steady[0]?.at ?? 0) / 1000)} s: worst ${mib(worst)} (tolerance ${mib(HEAP_TOLERANCE)})`);
  check(worst <= HEAP_TOLERANCE, `heap grew ${mib(worst)}`);
}
log(`max media dir ${maxDir} B; expired ${events['media_expired'] ?? 0}, evicted ${events['media_evicted'] ?? 0}`);

await fresh.close();
await ui.close();
fleet.close();
await broker.close();
if (failures.length) {
  log(`FAILED: ${failures.length} check(s)`);
  process.exit(1);
}
log('PASSED');
