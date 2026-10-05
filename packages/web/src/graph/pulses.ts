/** Travel time of a pulse from sender to recipient, in ms. */
export const PULSE_DURATION_MS = 600;

/** Concurrent pulses allowed per edge. Extra messages spawn no pulse. */
export const MAX_PULSES_PER_EDGE = 5;

/** Duration of the halo shown on a node for Owner traffic, in ms. */
export const HALO_DURATION_MS = 1_400;

/** One traveling dot. */
export interface Pulse {
  /** Thread the message belongs to. */
  threadId: string;
  /** Sender session ID. */
  from: string;
  /** Recipient session ID. */
  to: string;
  /** Whether the message carried media (drawn in the second color). */
  media: boolean;
  /** Start time on the animation clock, in ms. */
  start: number;
}

/** A pulse with its progress, for drawing. */
export interface ActivePulse extends Pulse {
  /** Progress from sender (0) to recipient (1). */
  t: number;
}

/** Tracks traveling pulses, capped per edge. Clock-agnostic and DOM-free. */
export class PulseSystem {
  private pulses: Pulse[] = [];

  /** Creates a system with the given travel time and per-edge cap. */
  constructor(
    private readonly durationMs: number = PULSE_DURATION_MS,
    private readonly maxPerEdge: number = MAX_PULSES_PER_EDGE,
  ) {}

  /** Starts a pulse unless its edge is at the cap. Returns whether it started. */
  spawn(pulse: Pulse): boolean {
    let count = 0;
    for (const p of this.pulses) {
      if (p.threadId === pulse.threadId && pulse.start - p.start < this.durationMs) count++;
    }
    if (count >= this.maxPerEdge) return false;
    this.pulses.push(pulse);
    return true;
  }

  /** Pulses in flight at `now`, with progress; finished ones are dropped. */
  active(now: number): ActivePulse[] {
    this.pulses = this.pulses.filter((p) => now - p.start < this.durationMs);
    return this.pulses.map((p) => ({ ...p, t: Math.max(0, (now - p.start) / this.durationMs) }));
  }

  /** Number of pulses held (including any not yet pruned). */
  get size(): number {
    return this.pulses.length;
  }
}

/** Tracks Owner-traffic halos per node. */
export class HaloSystem {
  private readonly started = new Map<string, number>();

  /** Creates a system with the given halo duration. */
  constructor(private readonly durationMs: number = HALO_DURATION_MS) {}

  /** Starts (or restarts) the halo on a node. */
  trigger(nodeId: string, now: number): void {
    this.started.set(nodeId, now);
  }

  /** Halo progress per node at `now`, from 0 (start) to 1 (end); ended halos are dropped. */
  active(now: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, start] of this.started) {
      const t = (now - start) / this.durationMs;
      if (t >= 1) this.started.delete(id);
      else out.set(id, Math.max(0, t));
    }
    return out;
  }
}
