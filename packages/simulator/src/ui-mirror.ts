import {
  DEFAULT_LIMITS,
  weightAt,
  type BrokerToUiFrame,
  type ControlState,
  type EdgeStats,
  type Limits,
  type MediaIndexEntry,
  type MediaStoreUsage,
  type Message,
  type SessionNode,
} from '@orchvis/protocol';

/** The web app's view of broker state, as built from a snapshot and deltas. */
export interface UiState {
  now: number;
  limits: Limits;
  nodes: SessionNode[];
  edges: EdgeStats[];
  messages: Message[];
  media: MediaIndexEntry[];
  control: ControlState;
  mediaStore: MediaStoreUsage;
}

/**
 * A minimal client store for `/ws/ui`: apply a `snapshot`, then every delta,
 * and read back the state. It does what the web app's store must do, so it
 * doubles as a reference for it and as the checker in "snapshot equals
 * replayed deltas" tests against the mock feed or a real broker.
 */
export class UiStateMirror {
  private limits: Limits = { ...DEFAULT_LIMITS };
  private now = 0;
  private nodes = new Map<string, SessionNode>();
  private edges = new Map<string, EdgeStats>();
  private threads = new Map<string, Message[]>();
  private byId = new Map<string, Message>();
  private media = new Map<string, MediaIndexEntry>();
  private control: ControlState = { mutedThreads: [], pausedSessions: [], pausedAll: false };
  private mediaStore: MediaStoreUsage = { bytes: 0, capBytes: 1, files: 0 };
  private hasSnapshot = false;

  /** Whether a snapshot has been applied. */
  get ready(): boolean {
    return this.hasSnapshot;
  }

  /** Applies one frame. Frames before the first snapshot, other than heartbeats, throw. */
  apply(frame: BrokerToUiFrame): void {
    if (frame.type === 'ping' || frame.type === 'pong' || frame.type === 'sent' || frame.type === 'rejected') return;
    if (frame.type !== 'snapshot' && !this.hasSnapshot) throw new Error(`${frame.type} before snapshot`);
    this.now = Math.max(this.now, frame.ts);
    switch (frame.type) {
      case 'snapshot': {
        const p = structuredClone(frame.payload);
        this.hasSnapshot = true;
        this.limits = p.limits;
        this.now = p.now;
        this.nodes = new Map(p.nodes.map((n) => [n.id, n]));
        this.edges = new Map(p.edges.map((e) => [e.threadId, e]));
        this.threads = new Map();
        this.byId = new Map();
        for (const m of p.messages) this.addMessage(m);
        this.media = new Map(p.media.map((m) => [m.ref.mediaId, m]));
        this.control = p.control;
        this.mediaStore = p.mediaStore;
        break;
      }
      case 'node':
        if (frame.payload.op === 'upsert') this.nodes.set(frame.payload.node.id, structuredClone(frame.payload.node));
        else this.nodes.delete(frame.payload.id);
        break;
      case 'message':
        this.addMessage(structuredClone(frame.payload.message));
        this.edges.set(frame.payload.edge.threadId, structuredClone(frame.payload.edge));
        break;
      case 'seen':
        for (const id of frame.payload.ids) {
          const m = this.byId.get(id);
          if (m) m.seenAt = frame.payload.seenAt;
        }
        break;
      case 'media':
        if (frame.payload.op === 'add') this.media.set(frame.payload.entry.ref.mediaId, structuredClone(frame.payload.entry));
        else this.media.delete(frame.payload.mediaId);
        this.edges.set(frame.payload.edge.threadId, structuredClone(frame.payload.edge));
        this.mediaStore = { ...frame.payload.mediaStore };
        break;
      case 'control_state':
        this.control = structuredClone(frame.payload);
        break;
    }
  }

  private addMessage(m: Message): void {
    const list = this.threads.get(m.threadId) ?? [];
    list.push(m);
    this.byId.set(m.id, m);
    while (list.length > this.limits.ringBufferPerThread) {
      const old = list.shift();
      if (old) this.byId.delete(old.id);
    }
    this.threads.set(m.threadId, list);
  }

  /** The current state, with lists sorted by ID for comparison. */
  state(): UiState {
    const byKey = <T>(key: (t: T) => string) => (x: T, y: T) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0);
    return structuredClone({
      now: this.now,
      limits: this.limits,
      nodes: [...this.nodes.values()].sort(byKey((n: SessionNode) => n.id)),
      edges: [...this.edges.values()].sort(byKey((e: EdgeStats) => e.threadId)),
      messages: [...this.threads.values()].flat().sort(byKey((m: Message) => m.id)),
      media: [...this.media.values()].sort(byKey((m: MediaIndexEntry) => m.ref.mediaId)),
      control: {
        mutedThreads: [...this.control.mutedThreads].sort(),
        pausedSessions: [...this.control.pausedSessions].sort(),
        pausedAll: this.control.pausedAll,
      },
      mediaStore: this.mediaStore,
    });
  }
}

/** JSON with object keys sorted, so key order never affects a comparison. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Compares two UI states and lists the differences (empty when they agree).
 * Edge weights are compared with `weightAt` at time `now`, within a relative
 * tolerance, since two equal weights may be stated as of different times.
 */
export function diffUiStates(actual: UiState, expected: UiState, now: number, tolerance = 1e-9): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
  const compareList = <T>(label: string, a: T[], b: T[], key: (t: T) => string, eq: (x: T, y: T) => string | undefined) => {
    const mb = new Map(b.map((t) => [key(t), t]));
    const ma = new Map(a.map((t) => [key(t), t]));
    for (const k of ma.keys()) if (!mb.has(k)) out.push(`${label} ${k}: unexpected`);
    for (const k of mb.keys()) if (!ma.has(k)) out.push(`${label} ${k}: missing`);
    for (const [k, x] of ma) {
      const y = mb.get(k);
      if (y === undefined) continue;
      const d = eq(x, y);
      if (d) out.push(`${label} ${k}: ${d}`);
    }
  };
  const plain = <T>(x: T, y: T) => (same(x, y) ? undefined : `${JSON.stringify(x)} != ${JSON.stringify(y)}`);
  compareList('node', actual.nodes, expected.nodes, (n) => n.id, plain);
  compareList('message', actual.messages, expected.messages, (m) => m.id, plain);
  if (!same(actual.messages.map((m) => m.id), expected.messages.map((m) => m.id))) out.push('message order differs');
  compareList('media', actual.media, expected.media, (m) => m.ref.mediaId, plain);
  compareList('edge', actual.edges, expected.edges, (e) => e.threadId, (x, y) => {
    const { weight: wx, updatedAt: ux, ...rx } = x;
    const { weight: wy, updatedAt: uy, ...ry } = y;
    const ax = weightAt({ weight: wx, updatedAt: ux }, now, actual.limits.edgeTauMs);
    const ay = weightAt({ weight: wy, updatedAt: uy }, now, expected.limits.edgeTauMs);
    if (Math.abs(ax - ay) > tolerance * Math.max(1, Math.abs(ay))) return `weight ${ax} != ${ay}`;
    return plain(rx, ry);
  });
  if (!same(actual.control, expected.control)) out.push(`control ${JSON.stringify(actual.control)} != ${JSON.stringify(expected.control)}`);
  if (!same(actual.mediaStore, expected.mediaStore)) out.push(`mediaStore ${JSON.stringify(actual.mediaStore)} != ${JSON.stringify(expected.mediaStore)}`);
  if (!same(actual.limits, expected.limits)) out.push('limits differ');
  return out;
}
