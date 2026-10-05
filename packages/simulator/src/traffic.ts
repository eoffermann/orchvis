import type { DeliveryMode, MediaKind, MessageKind, SessionStatus } from '@orchvis/protocol';
import { TimerGroup, type Clock } from './clock.js';
import { generateMedia, type MediaSample } from './media.js';
import type { Rng } from './random.js';
import { allRepos, SAMPLE_FOCI, type SimSessionSpec } from './scenario.js';
import { generateBody, generateOwnerReply } from './text.js';

/** A message the traffic generator wants sent. Sessions are scenario indexes. */
export interface SendIntent {
  from: number;
  to: number | 'owner';
  kind: MessageKind;
  body: string;
  replyTo?: string;
  /** Files to upload and attach. Empty unless media is enabled. */
  media: MediaSample[];
}

/** A status change the traffic generator wants made. */
export interface StatusIntent {
  status?: SessionStatus;
  focus?: string;
  delivery?: DeliveryMode;
}

/**
 * Where traffic goes. The shim fleet maps intents to frames on real
 * connections; the mock UI feed applies them to its own broker state.
 */
export interface TrafficSink {
  /** Sends a message. Returns the message ID when known, so scripts can reply to it. */
  send(intent: SendIntent): string | undefined | Promise<string | undefined>;
  /** Changes a session's status, focus or delivery mode. */
  status(index: number, change: StatusIntent): void;
  /** Drops a session's connection for about `downMs`. */
  disconnect(index: number, downMs: number): void;
}

/** Options for {@link TrafficEngine}. */
export interface TrafficOptions {
  /** Average messages per minute on an active pair in its normal phase. Default 0.6. */
  rate?: number;
  /** Number of session pairs that talk. Default twice the session count, capped by the pairs available. */
  activePairs?: number;
  /** Messages per hour each session sends to the Owner unprompted. Default 0.5. */
  ownerRatePerHour?: number;
  /** Probability that a message carries media. 0 disables media. Default 0. */
  mediaRate?: number;
  /** Mean gap between a session's status changes, in ms. Default 4 minutes. 0 disables. */
  statusMeanMs?: number;
  /** Mean gap between a session's disconnects, in ms. Default 25 minutes. 0 disables. */
  disconnectMeanMs?: number;
  /** Probability that a request is answered. Default 0.9. */
  replyRate?: number;
  /** Probability of a hostile body. Default 0.01. */
  hostileRate?: number;
}

/** A pair of sessions that talk, and its current phase. */
interface Pair {
  a: number;
  b: number;
  /** Rate multiplier for this pair, so some edges are hot and some cool. */
  heat: number;
  phase: 'normal' | 'burst' | 'quiet';
  nextMessage?: ReturnType<TimerGroup['after']>;
}

/** Counters kept by {@link TrafficEngine}. */
export interface TrafficStats {
  sends: number;
  replies: number;
  statusChanges: number;
  disconnects: number;
  mediaFiles: number;
}

/**
 * Random traffic over a scenario: a Poisson process per active pair with
 * bursts and quiet spells (so edges fade), request/response pairs linked by
 * `replyTo`, unprompted messages to the Owner, status changes, occasional
 * disconnects and, when enabled, media. Deterministic for a given RNG and clock.
 */
export class TrafficEngine {
  /** The active pairs, as `[a, b]` scenario indexes. */
  readonly pairs: ReadonlyArray<readonly [number, number]>;
  /** Running counters. */
  readonly stats: TrafficStats = { sends: 0, replies: 0, statusChanges: 0, disconnects: 0, mediaFiles: 0 };

  private readonly timers: TimerGroup;
  private readonly pairState: Pair[];
  private readonly opts: Required<TrafficOptions>;
  private started = false;

  /** Creates an engine. Nothing happens until {@link TrafficEngine.start}. */
  constructor(
    clock: Clock,
    private readonly rng: Rng,
    private readonly sessions: readonly SimSessionSpec[],
    private readonly sink: TrafficSink,
    options: TrafficOptions = {},
  ) {
    this.timers = new TimerGroup(clock);
    const n = sessions.length;
    const maxPairs = (n * (n - 1)) / 2;
    this.opts = {
      rate: options.rate ?? 0.6,
      activePairs: Math.min(options.activePairs ?? n * 2, maxPairs),
      ownerRatePerHour: options.ownerRatePerHour ?? 0.5,
      mediaRate: options.mediaRate ?? 0,
      statusMeanMs: options.statusMeanMs ?? 4 * 60_000,
      disconnectMeanMs: options.disconnectMeanMs ?? 25 * 60_000,
      replyRate: options.replyRate ?? 0.9,
      hostileRate: options.hostileRate ?? 0.01,
    };
    this.pairState = this.choosePairs();
    this.pairs = this.pairState.map((p) => [p.a, p.b] as const);
  }

  /** Picks active pairs, preferring sessions that share a repo. */
  private choosePairs(): Pair[] {
    const n = this.sessions.length;
    const repoKeys = this.sessions.map((s) => new Set(allRepos(s).map((r) => r.key)));
    const shares = (i: number, j: number) => [...(repoKeys[i] ?? [])].some((k) => repoKeys[j]?.has(k));
    const chosen = new Set<string>();
    const pairs: Pair[] = [];
    const add = (a: number, b: number) => {
      const [x, y] = a < b ? [a, b] : [b, a];
      const key = `${x}|${y}`;
      if (x === y || chosen.has(key)) return false;
      chosen.add(key);
      pairs.push({ a: x, b: y, heat: this.rng.range(0.3, 2), phase: 'normal' });
      return true;
    };
    // Every session gets at least one partner when possible, so no node is isolated.
    for (let i = 0; i < n && pairs.length < this.opts.activePairs; i++) {
      const same = [...Array(n).keys()].filter((j) => j !== i && shares(i, j));
      const pool = same.length > 0 ? same : [...Array(n).keys()].filter((j) => j !== i);
      if (pool.length > 0) add(i, this.rng.pick(pool));
    }
    for (let guard = 0; pairs.length < this.opts.activePairs && guard < this.opts.activePairs * 50; guard++) {
      const a = this.rng.int(0, n - 1);
      const preferSame = this.rng.chance(0.7);
      const pool = [...Array(n).keys()].filter((j) => j !== a && (!preferSame || shares(a, j)));
      if (pool.length > 0) add(a, this.rng.pick(pool));
    }
    return pairs;
  }

  /** Starts generating traffic. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const pair of this.pairState) {
      this.schedulePairMessage(pair);
      this.schedulePhaseChange(pair);
    }
    this.sessions.forEach((_, i) => {
      this.scheduleOwnerMessage(i);
      this.scheduleStatus(i);
      this.scheduleDisconnect(i);
    });
  }

  /** Stops all generation and pending replies. */
  stop(): void {
    this.timers.close();
  }

  private currentRatePerMs(pair: Pair): number {
    const base = (this.opts.rate * pair.heat) / 60_000;
    if (pair.phase === 'quiet') return 0;
    if (pair.phase === 'burst') return base * 8;
    return base;
  }

  private schedulePairMessage(pair: Pair): void {
    this.timers.cancel(pair.nextMessage);
    pair.nextMessage = undefined;
    const rate = this.currentRatePerMs(pair);
    if (rate <= 0) return;
    pair.nextMessage = this.timers.after(this.rng.exponential(1 / rate), () => {
      pair.nextMessage = undefined;
      const forward = this.rng.chance(0.5);
      const from = forward ? pair.a : pair.b;
      const to = forward ? pair.b : pair.a;
      const kind = this.rng.weighted<MessageKind>([['chat', 45], ['request', 35], ['notice', 10]]);
      this.emit({ from, to, kind, body: generateBody(this.rng, kind, { hostileRate: this.opts.hostileRate }), media: this.maybeMedia() });
      this.schedulePairMessage(pair);
    });
  }

  private schedulePhaseChange(pair: Pair): void {
    const duration =
      pair.phase === 'burst' ? this.rng.range(30_000, 120_000) : pair.phase === 'quiet' ? this.rng.range(4 * 60_000, 15 * 60_000) : this.rng.exponential(4 * 60_000);
    this.timers.after(duration, () => {
      pair.phase = pair.phase !== 'normal' ? 'normal' : this.rng.weighted([['burst', 25], ['quiet', 35], ['normal', 40]] as const);
      this.schedulePairMessage(pair);
      this.schedulePhaseChange(pair);
    });
  }

  private scheduleOwnerMessage(index: number): void {
    if (this.opts.ownerRatePerHour <= 0) return;
    this.timers.after(this.rng.exponential(3_600_000 / this.opts.ownerRatePerHour), () => {
      const kind = this.rng.weighted<MessageKind>([['chat', 6], ['notice', 3], ['request', 1]]);
      this.emit({ from: index, to: 'owner', kind, body: generateBody(this.rng, kind, { hostileRate: 0 }), media: this.maybeMedia() });
      this.scheduleOwnerMessage(index);
    });
  }

  private scheduleStatus(index: number): void {
    if (this.opts.statusMeanMs <= 0) return;
    this.timers.after(this.rng.exponential(this.opts.statusMeanMs), () => {
      const change: StatusIntent = {
        status: this.rng.weighted<SessionStatus>([['working', 6], ['idle', 3], ['blocked', 1]]),
      };
      if (this.rng.chance(0.15)) change.focus = this.rng.pick(SAMPLE_FOCI);
      this.stats.statusChanges++;
      this.sink.status(index, change);
      this.scheduleStatus(index);
    });
  }

  private scheduleDisconnect(index: number): void {
    if (this.opts.disconnectMeanMs <= 0) return;
    this.timers.after(this.rng.exponential(this.opts.disconnectMeanMs), () => {
      const downMs = this.rng.chance(0.8) ? this.rng.range(3_000, 60_000) : this.rng.range(60_000, 5 * 60_000);
      this.stats.disconnects++;
      this.sink.disconnect(index, downMs);
      this.scheduleDisconnect(index);
    });
  }

  private maybeMedia(): MediaSample[] {
    if (this.opts.mediaRate <= 0 || !this.rng.chance(this.opts.mediaRate)) return [];
    const count = this.rng.chance(0.1) ? 2 : 1;
    const out: MediaSample[] = [];
    for (let i = 0; i < count; i++) out.push(generateMedia(this.rng));
    this.stats.mediaFiles += out.length;
    return out;
  }

  private emit(intent: SendIntent): void {
    this.stats.sends++;
    void this.sink.send(intent);
  }

  /**
   * Tells the engine a message reached session `to`. A peer request is
   * answered with probability `replyRate`; an Owner message is always
   * answered. Replies come after a delay, longer for `poll` sessions.
   */
  onDelivered(to: number, from: number | 'owner', messageId: string, kind: MessageKind): void {
    if (from === 'owner') {
      const delay = this.replyDelay(to, 2_000, 10_000);
      this.timers.after(delay, () => {
        this.stats.replies++;
        this.emit({ from: to, to: 'owner', kind: kind === 'request' ? 'response' : 'chat', body: generateOwnerReply(this.rng), replyTo: messageId, media: [] });
      });
      return;
    }
    if (kind !== 'request' || !this.rng.chance(this.opts.replyRate)) return;
    const delay = this.replyDelay(to, 3_000, 40_000);
    this.timers.after(delay, () => {
      this.stats.replies++;
      this.emit({ from: to, to: from, kind: 'response', body: generateBody(this.rng, 'response', { hostileRate: 0 }), replyTo: messageId, media: this.maybeMedia() });
    });
  }

  private replyDelay(index: number, min: number, max: number): number {
    const poll = this.sessions[index]?.persona === 'poll';
    return this.rng.range(min, max) + (poll ? this.rng.range(10_000, 60_000) : 0);
  }
}

/** One action in a scripted scenario. Sessions are scenario indexes. */
export type ScriptAction =
  | {
      type: 'send';
      from: number;
      to: number | 'owner';
      kind?: MessageKind;
      body?: string;
      /** Media kinds to generate and attach. */
      media?: MediaKind[];
      /** Index of an earlier `send` step in the script whose message this replies to. */
      replyToStep?: number;
    }
  | { type: 'status'; session: number; change: StatusIntent }
  | { type: 'disconnect'; session: number; downMs: number };

/** A timed step: `at` is milliseconds after the script starts. */
export interface ScriptStep {
  at: number;
  action: ScriptAction;
}

/** A running script. */
export interface ScriptRun {
  /** Resolves once every step has run and every send has settled. */
  done: Promise<void>;
  /** Message IDs by step index, filled as sends settle. */
  messageIds: Map<number, string>;
  /** Cancels steps not yet run. */
  stop(): void;
}

/**
 * Runs a scripted scenario: each step fires at its time on `clock` and goes to
 * `sink`. Steps with `replyToStep` wait for the earlier send's message ID.
 */
export function runScript(clock: Clock, rng: Rng, sink: TrafficSink, steps: readonly ScriptStep[]): ScriptRun {
  const timers = new TimerGroup(clock);
  const messageIds = new Map<number, string>();
  const settled = new Map<number, Promise<string | undefined>>();
  const all: Promise<unknown>[] = [];
  steps.forEach((step, index) => {
    let resolveStep!: () => void;
    all.push(new Promise<void>((r) => (resolveStep = r)));
    timers.after(step.at, () => {
      const a = step.action;
      if (a.type === 'status') {
        sink.status(a.session, a.change);
        resolveStep();
      } else if (a.type === 'disconnect') {
        sink.disconnect(a.session, a.downMs);
        resolveStep();
      } else {
        const kind = a.kind ?? (a.replyToStep !== undefined ? 'response' : 'chat');
        const intent: SendIntent = {
          from: a.from,
          to: a.to,
          kind,
          body: a.body ?? generateBody(rng, kind, { hostileRate: 0 }),
          media: (a.media ?? []).map((k) => generateMedia(rng, k)),
        };
        // Send synchronously whenever possible, so a fake clock stamps the step's own time.
        const record = (id: string | undefined) => {
          if (id !== undefined) messageIds.set(index, id);
          return id;
        };
        const sendNow = (): string | undefined | Promise<string | undefined> => {
          const result = sink.send(intent);
          return result instanceof Promise ? result.then(record) : record(result);
        };
        let result: string | undefined | Promise<string | undefined>;
        if (a.replyToStep === undefined) {
          result = sendNow();
        } else if (messageIds.has(a.replyToStep)) {
          intent.replyTo = messageIds.get(a.replyToStep) as string;
          result = sendNow();
        } else {
          result = Promise.resolve(settled.get(a.replyToStep)).then((replyTo) => {
            if (replyTo !== undefined) intent.replyTo = replyTo;
            return sendNow();
          });
        }
        const p = Promise.resolve(result);
        settled.set(index, p);
        void p.finally(resolveStep);
      }
    });
  });
  return { done: Promise.all(all).then(() => undefined), messageIds, stop: () => timers.close() };
}
