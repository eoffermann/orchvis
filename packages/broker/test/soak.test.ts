/**
 * Compressed soak (WP9): 10 simulator sessions on the real wire protocol,
 * mixed text and media traffic, 60 simulated minutes on injected clocks. A
 * small media TTL and store cap make expiry and eviction churn many times;
 * shims and web clients drop and reconnect along the way.
 *
 * Checked throughout: the media directory never exceeds its cap, and right
 * after every sweep its files are exactly the unexpired index. Checked at
 * every 10-minute checkpoint: the broker's in-memory structures stay bounded
 * (ring buffers at their cap, message index equal to the buffers, one link
 * and one upload key per connection), heap use after forced GC does not trend
 * upward, and a fresh snapshot equals the state replayed from deltas.
 *
 * The real-time version is `packages/broker/scripts/soak.ts` (opt-in,
 * `ORCHVIS_SOAK=1`).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import type { Limits } from '@orchvis/protocol';
import { FakeClock, Rng, SimShim, diffUiStates, generateMedia, generateScenario } from '@orchvis/simulator';
import { ManualClock, startBroker, type BrokerStats, type RunningBroker } from '../src/index.js';
import { uploadOk } from './helpers/media.js';
import { MirrorUi } from './helpers/mirror-ui.js';

// --expose-gc for this file only: V8 flags are process-wide, and a fresh context picks up `gc`.
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const STEP_MS = 5_000;
const RUN_MS = 60 * 60_000;
const CHECKPOINT_MS = 10 * 60_000;
/** Checkpoints before this are warm-up: ring buffers are still filling. */
const WARM_MS = 30 * 60_000;
const SESSIONS = 10;
const LIMITS: Partial<Limits> = {
  mediaTtlMs: 2 * 60_000,
  mediaStoreBytes: 12 * 1024,
  ringBufferPerThread: 40,
};
/**
 * Allowed heap growth from the first steady-state checkpoint to any later one.
 * Bodies average about 4.5 KB and about 850 messages go out per 10 minutes, so
 * a broker that retained every message would grow by over 10 MiB from 30 to
 * 60 minutes (an injected leak measured +12 MiB). GC noise between
 * checkpoints is about 1 MiB; a 180-minute run stayed within 46 ± 0.5 MiB.
 */
const HEAP_TOLERANCE_BYTES = 3 * 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function heapAfterGc(): number {
  gc();
  gc();
  return getHeapStatistics().used_heap_size;
}

function dirUsage(dir: string): { files: string[]; bytes: number } {
  const files = readdirSync(dir).sort();
  let bytes = 0;
  for (const f of files) bytes += statSync(join(dir, f)).size;
  return { files, bytes };
}

interface Checkpoint {
  minute: number;
  heapBytes: number;
  stats: BrokerStats;
  sent: number;
  expired: number;
  evicted: number;
  realMs: number;
}

describe('compressed soak: 10 sessions, 60 simulated minutes, media churn', () => {
  let broker: RunningBroker | undefined;
  const shims: SimShim[] = [];
  const uis: MirrorUi[] = [];

  afterAll(async () => {
    for (const s of shims) s.close();
    for (const u of uis) await u.close().catch(() => {});
    await broker?.close();
  });

  it('keeps the media dir under its cap with no orphans, memory bounded and flat, and the feed consistent', async () => {
    const started = performance.now();
    const brokerClock = new ManualClock();
    const shimClock = new FakeClock(brokerClock.now());
    const events: Record<string, number> = {};
    broker = await startBroker({
      port: 0,
      config: { limits: LIMITS },
      clock: brokerClock,
      // Count events instead of keeping lines, so the log does not grow the heap under test.
      logSink: (line) => {
        const event = /"event":"([a-z_]+)"/.exec(line)?.[1] ?? 'unknown';
        events[event] = (events[event] ?? 0) + 1;
      },
    });
    const b = broker;
    const cap = LIMITS.mediaStoreBytes as number;
    const ringCap = LIMITS.ringBufferPerThread as number;

    const scenario = generateScenario({ sessions: SESSIONS, hosts: 3, repos: 4, seed: 2026 });
    const rng = new Rng(99);
    for (const spec of scenario.sessions) {
      shims.push(
        new SimShim({
          url: `${b.url.replace(/^http/, 'ws')}/ws/shim`,
          token: b.shimToken,
          identity: { ...spec },
          persona: spec.persona,
          clock: shimClock,
          rng: rng.fork(`shim-${spec.index}`),
          // Keep the shims' own memory small and constant (unread frames, dedupe IDs): they share the heap
          // being measured, and at their defaults both grow with every delivery for the whole run.
          bufferLimit: 8,
          deliveredIdLimit: 200,
        }),
      );
    }
    await Promise.all(shims.map((s) => s.start()));
    await Promise.all(shims.map((s, i) => s.register(scenario.sessions[i]?.name as string, 'soak')));

    const ui = await MirrorUi.connect(b);
    uis.push(ui);

    /** Messages acknowledged per thread, to check the ring buffers against. */
    const perThread = new Map<string, number>();
    let sent = 0;
    let rejected = 0;
    const count = (threadId: string) => {
      perThread.set(threadId, (perThread.get(threadId) ?? 0) + 1);
      sent++;
    };
    // Bodies are rebuilt from the wire on the broker side, so their full size counts there.
    const body = () => `${rng.hex(8)} ${'lorem ipsum dolor '.repeat(rng.int(100, 400))}`;
    const peerOf = (i: number) => {
      const r = rng.int(0, 2);
      return r === 2 ? 'owner' : (shims[(i + 1 + r) % SESSIONS]?.name as string);
    };

    const checkpoints: Checkpoint[] = [];
    let sweepsChecked = 0;
    let maxDirBytes = 0;

    for (let t = STEP_MS; t <= RUN_MS; t += STEP_MS) {
      brokerClock.advance(STEP_MS);
      shimClock.advance(STEP_MS);
      const minute = Math.floor(t / 60_000);
      const mediaPhase = minute % 10 < 5;

      // Right after each sweep (every 30 s), the files on disk are exactly the unexpired index.
      if (t % 30_000 === 0) {
        const entries = b.mediaEntries();
        expect(entries.every((e) => e.expiresAt > brokerClock.now())).toBe(true);
        expect(dirUsage(b.mediaDir).files).toEqual(entries.map((e) => e.mediaId).sort());
        sweepsChecked++;
      }

      // Connection churn: a shim drops every 7 minutes and reconnects on its own backoff.
      if (t % (7 * 60_000) === 0) shims[(t / (7 * 60_000)) % SESSIONS]?.dropConnection();

      const ready = shims.map((s, i) => [s, i] as const).filter(([s]) => s.isReady);

      // Media, one at a time so a concurrent upload cannot evict another before it is attached.
      if (mediaPhase && ready.length) {
        const [s, i] = ready[rng.int(0, ready.length - 1)] as (typeof ready)[number];
        const ref = await s.uploadMedia(generateMedia(rng));
        const r = await s.send({ to: peerOf(i), body: `media ${ref.filename}`, attachments: [ref.mediaId] });
        if (r.ok) count(r.threadId);
        else rejected++;
        if (t % 30_000 === 0) {
          const ownerRef = await uploadOk(b, { cookie: ui.cookie }, { data: generateMedia(rng, 'image').data, mime: 'image/png', filename: 'owner.png' });
          const target = ready[rng.int(0, ready.length - 1)]?.[0] as SimShim;
          const answer = await ui.request('owner_send', { to: target.sessionId, kind: 'chat', body: 'see this', attachments: [ownerRef.mediaId] });
          if (answer.type === 'sent') count(answer.payload.threadId);
          else rejected++;
        }
      }

      // Text: six sends from random ready shims, plus an Owner message every other step.
      const sends: Promise<void>[] = [];
      for (let k = 0; k < 6 && ready.length; k++) {
        const [s, i] = ready[rng.int(0, ready.length - 1)] as (typeof ready)[number];
        sends.push(
          s.send({ to: peerOf(i), body: body() }).then((r) => {
            if (r.ok) count(r.threadId);
            else rejected++;
          }),
        );
      }
      if (t % (2 * STEP_MS) === 0 && ready.length) {
        const target = ready[rng.int(0, ready.length - 1)]?.[0] as SimShim;
        sends.push(
          ui.request('owner_send', { to: target.sessionId, kind: 'request', body: body(), attachments: [] }).then((answer) => {
            if (answer.type === 'sent') count(answer.payload.threadId);
            else rejected++;
          }),
        );
      }
      await Promise.all(sends);
      // Every ready shim pings, so the broker hears from it at this clock reading before the next heartbeat check.
      await Promise.all(ready.map(([s]) => s.ping()));
      await ui.sync();

      const usage = dirUsage(b.mediaDir);
      maxDirBytes = Math.max(maxDirBytes, usage.bytes);
      expect(usage.bytes).toBeLessThanOrEqual(cap);

      if (t % CHECKPOINT_MS === 0) {
        // Let the churned shim finish reconnecting so connection counts are comparable.
        const deadline = Date.now() + 10_000;
        while (!shims.every((s) => s.isReady) && Date.now() < deadline) {
          shimClock.advance(500);
          await sleep(10);
        }
        expect(shims.every((s) => s.isReady)).toBe(true);
        await ui.sync();

        const stats = b.stats();
        const cp: Checkpoint = {
          minute,
          heapBytes: heapAfterGc(),
          stats,
          sent,
          expired: events['media_expired'] ?? 0,
          evicted: events['media_evicted'] ?? 0,
          realMs: Math.round(performance.now() - started),
        };
        checkpoints.push(cp);
        process.stderr.write(
          `[soak] ${minute} min: heap ${(cp.heapBytes / 1048576).toFixed(1)} MiB, sent ${sent}, buffered ${stats.bufferedMessages}, ` +
            `threads ${stats.threads}, media ${stats.mediaFiles} files/${stats.mediaBytes} B, expired ${cp.expired}, evicted ${cp.evicted}, ` +
            `real ${cp.realMs} ms\n`,
        );

        // Bounded structures: one entry per connection, the message index equal to the ring buffers,
        // and every thread's buffer at min(messages sent, cap).
        let expectBuffered = 0;
        for (const n of perThread.values()) expectBuffered += Math.min(n, ringCap);
        expect(stats).toMatchObject({
          nodes: SESSIONS,
          connectedNodes: SESSIONS,
          aliases: 0,
          expiredQueues: 0,
          shimLinks: SESSIONS,
          uploadKeys: SESSIONS,
          uiLinks: 1,
          threads: perThread.size,
          edges: perThread.size,
          bufferedMessages: expectBuffered,
          indexedMessages: expectBuffered,
          mutedThreads: 0,
          pausedSessions: 0,
        });
        expect(stats.mediaBytes).toBeLessThanOrEqual(cap);
        expect(stats.queuedMessages).toBeLessThanOrEqual(ringCap);
        // At most one limiter key per sender and thread used within the last minute.
        expect(stats.sendLimiterKeys).toBeLessThanOrEqual((SESSIONS + 1) * 3);
        expect(stats.uploadLimiterKeys).toBeLessThanOrEqual(SESSIONS + 1);

        // A web client connecting now gets a snapshot equal to the state the long-lived one replayed.
        const fresh = await MirrorUi.connect(b);
        const now = fresh.mirror.state().now;
        expect(diffUiStates(ui.mirror.state(), fresh.mirror.state(), now)).toEqual([]);
        await fresh.close();
        await ui.sync();
      }
    }

    // ---- end-of-run assertions ----
    const steady = checkpoints.filter((c) => c.minute * 60_000 >= WARM_MS);
    expect(steady.length).toBe(4);
    // Ring buffers full: every thread is past its cap by now, and the totals did not move once they were.
    expect([...perThread.values()].every((n) => n > ringCap)).toBe(true);
    expect(new Set(steady.map((c) => c.stats.bufferedMessages)).size).toBe(1);
    expect(new Set(steady.map((c) => c.stats.threads)).size).toBe(1);
    // Churn happened many times.
    expect(events['media_expired'] ?? 0).toBeGreaterThanOrEqual(12);
    expect(events['media_evicted'] ?? 0).toBeGreaterThan(200);
    expect(events['shim_disconnected'] ?? 0).toBeGreaterThanOrEqual(8);
    expect(sweepsChecked).toBe(RUN_MS / 30_000);
    expect(rejected).toBe(0);
    expect(ui.invalid).toEqual([]);
    expect(shims.reduce((n, s) => n + s.stats.invalidInbound.length, 0)).toBe(0);
    // Heap: no upward trend across steady-state checkpoints beyond the tolerance.
    const base = steady[0]?.heapBytes as number;
    const growth = steady.map((c) => c.heapBytes - base);
    process.stderr.write(
      `[soak] done: ${sent} messages, max dir ${maxDirBytes} B of ${cap} B, heap growth vs ${WARM_MS / 60_000} min: ` +
        `${growth.map((g) => `${(g / 1048576).toFixed(2)} MiB`).join(', ')} (tolerance ${HEAP_TOLERANCE_BYTES / 1048576} MiB)\n`,
    );
    for (const g of growth) expect(g).toBeLessThan(HEAP_TOLERANCE_BYTES);
  }, 120_000);
});
