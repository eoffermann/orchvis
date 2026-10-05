import type { BrokerToShimFrame, FrameOf, MediaRef } from '@orchvis/protocol';
import { realClock, type Clock } from './clock.js';
import { Rng } from './random.js';
import { generateScenario, type Scenario, type ScenarioOptions } from './scenario.js';
import { SimShim, type BackoffOptions, type SendResult } from './sim-shim.js';
import { TrafficEngine, type SendIntent, type StatusIntent, type TrafficOptions, type TrafficSink } from './traffic.js';

/** Options for {@link startShimFleet}. */
export interface ShimFleetOptions extends ScenarioOptions {
  /** Broker WebSocket URL, e.g. `ws://broker-host:7801/ws/shim`. */
  url: string;
  /** Shim token. */
  token: string;
  /** A ready-made scenario, instead of generating one. */
  scenario?: Scenario;
  clock?: Clock;
  /** Traffic options. `mediaRate` above 0 uploads media to `POST /api/media`; leave it 0 until the broker supports media. */
  traffic?: TrafficOptions;
  backoff?: BackoffOptions;
  /** Start random traffic once every shim has registered. Default true. */
  autoTraffic?: boolean;
  /** Receives log lines from shims and the fleet. */
  log?: (line: string) => void;
}

/** Counters for a fleet. */
export interface ShimFleetStats {
  sendsOk: number;
  sendsRejected: Record<string, number>;
  delivered: number;
  uploads: number;
  uploadFailures: number;
  invalidInbound: number;
  reconnects: number;
}

/** A running fleet of fake shims. */
export interface ShimFleet {
  scenario: Scenario;
  shims: SimShim[];
  /** Null when `autoTraffic` is false. */
  engine: TrafficEngine | null;
  /** Fleet-wide counters, computed on read. */
  stats(): ShimFleetStats;
  /** The sink the traffic engine drives; scripted scenarios can use it too. */
  sink: TrafficSink;
  close(): void;
}

/**
 * Connects one {@link SimShim} per scenario session to a real broker,
 * registers each, and drives random traffic through them: messages addressed
 * by name or session ID, replies to requests and Owner messages, status
 * changes, disconnects with reconnect, and (when enabled) media uploads.
 */
export async function startShimFleet(options: ShimFleetOptions): Promise<ShimFleet> {
  const clock = options.clock ?? realClock;
  const scenario = options.scenario ?? generateScenario(options);
  const root = new Rng(scenario.seed);
  const log = options.log ?? (() => {});
  const counters = { sendsOk: 0, sendsRejected: {} as Record<string, number>, uploads: 0, uploadFailures: 0 };

  const shims = scenario.sessions.map((spec) => {
    const shimOptions: ConstructorParameters<typeof SimShim>[0] = {
      url: options.url,
      token: options.token,
      identity: {
        hostname: spec.hostname,
        sessionId: spec.sessionId,
        platform: spec.platform,
        cwd: spec.cwd,
        repos: spec.repos,
        defaultName: spec.defaultName,
      },
      persona: spec.persona,
      clock,
      rng: root.fork(`shim-${spec.index}`),
      log,
    };
    if (options.backoff) shimOptions.backoff = options.backoff;
    return new SimShim(shimOptions);
  });

  let engine: TrafficEngine | null = null;

  const sink: TrafficSink = {
    async send(intent: SendIntent): Promise<string | undefined> {
      const shim = shims[intent.from];
      if (!shim) return undefined;
      let to = 'owner';
      if (intent.to !== 'owner') {
        const target = shims[intent.to];
        if (!target) return undefined;
        // Address by name most of the time, as sessions do; sometimes by session ID.
        to = target.name && root.chance(0.7) ? target.name : target.sessionId;
      }
      const attachments: string[] = [];
      for (const sample of intent.media) {
        try {
          const ref: MediaRef = await shim.uploadMedia(sample);
          attachments.push(ref.mediaId);
          counters.uploads++;
        } catch (err) {
          counters.uploadFailures++;
          log(`upload failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const draft: Parameters<SimShim['send']>[0] = { to, kind: intent.kind, body: intent.body, attachments };
      if (intent.replyTo !== undefined) draft.replyTo = intent.replyTo;
      const result: SendResult = await shim.send(draft);
      if (result.ok) {
        counters.sendsOk++;
        return result.messageId;
      }
      counters.sendsRejected[result.code] = (counters.sendsRejected[result.code] ?? 0) + 1;
      return undefined;
    },
    status(index: number, change: StatusIntent): void {
      shims[index]?.setStatus(change);
    },
    disconnect(index: number, downMs: number): void {
      shims[index]?.disconnectFor(downMs);
    },
  };

  shims.forEach((shim, index) => {
    shim.on('deliver', (frame: FrameOf<BrokerToShimFrame, 'deliver'>) => {
      const m = frame.payload.message;
      if (!engine) return;
      if (m.from.kind === 'owner') {
        engine.onDelivered(index, 'owner', m.id, m.kind);
        return;
      }
      const fromId = m.from.id;
      const fromIndex = shims.findIndex((s) => s.sessionId === fromId);
      if (fromIndex !== -1) engine.onDelivered(index, fromIndex, m.id, m.kind);
    });
  });

  log(`connecting ${shims.length} shims to ${options.url}`);
  await Promise.all(shims.map((s) => s.start()));
  log(`all ${shims.length} shims welcomed; registering`);
  await Promise.all(
    shims.map((s, i) => {
      const spec = scenario.sessions[i];
      return spec ? s.register(spec.name, spec.focus, spec.extraRepos) : undefined;
    }),
  );
  log('all shims registered');

  if (options.autoTraffic !== false) {
    engine = new TrafficEngine(clock, root.fork('traffic'), scenario.sessions, sink, options.traffic ?? {});
    engine.start();
  }

  return {
    scenario,
    shims,
    engine,
    sink,
    stats: () => ({
      sendsOk: counters.sendsOk,
      sendsRejected: { ...counters.sendsRejected },
      delivered: shims.reduce((n, s) => n + s.stats.delivered, 0),
      uploads: counters.uploads,
      uploadFailures: counters.uploadFailures,
      invalidInbound: shims.reduce((n, s) => n + s.stats.invalidInbound.length, 0),
      reconnects: shims.reduce((n, s) => n + Math.max(0, s.stats.connects - 1), 0),
    }),
    close: () => {
      engine?.stop();
      for (const s of shims) s.close();
    },
  };
}
