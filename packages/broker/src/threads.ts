import { bumpEdge, threadParticipants, addressKey, type EdgeStats, type MediaKind, type Message } from '@orchvis/protocol';

/** Result of {@link ThreadStore.append}. */
export interface AppendResult {
  /** The thread's statistics after the message. */
  edge: EdgeStats;
  /** Messages pushed out of the ring buffer by this append, oldest first. */
  evicted: Message[];
}

/**
 * Per-thread ring buffers of messages plus per-thread edge statistics. Holds
 * an index by message ID for `seen` lookups. Pure state: no I/O, no timers.
 */
export class ThreadStore {
  private readonly buffers = new Map<string, Message[]>();
  private readonly byId = new Map<string, Message>();
  private readonly edges = new Map<string, EdgeStats>();

  /**
   * @param capacity - Messages kept per thread (`ringBufferPerThread`).
   * @param tauMs - Edge weight time constant (`edgeTauMs`).
   */
  constructor(
    private readonly capacity: number,
    private readonly tauMs: number,
  ) {}

  /**
   * Appends a message to its thread, evicting the oldest beyond capacity, and
   * bumps the thread's edge at the message's `ts`.
   */
  append(message: Message): AppendResult {
    const { threadId } = message;
    const buffer = this.buffers.get(threadId) ?? [];
    buffer.push(message);
    this.buffers.set(threadId, buffer);
    this.byId.set(message.id, message);
    const evicted = buffer.length > this.capacity ? buffer.splice(0, buffer.length - this.capacity) : [];
    for (const m of evicted) this.byId.delete(m.id);

    const [a, b] = threadParticipants(threadId).map(addressKey) as [string, string];
    const prev: EdgeStats = this.edges.get(threadId) ?? {
      threadId,
      a,
      b,
      weight: 0,
      updatedAt: message.ts,
      lastMessageAt: message.ts,
      sentByA: 0,
      sentByB: 0,
      media: { image: 0, audio: 0, video: 0, other: 0 },
    };
    const bumped = bumpEdge({ weight: prev.weight, updatedAt: prev.updatedAt }, message.ts, this.tauMs);
    const fromA = addressKey(message.from) === a;
    const edge: EdgeStats = {
      ...prev,
      weight: bumped.weight,
      updatedAt: bumped.updatedAt,
      lastMessageAt: Math.max(prev.lastMessageAt, message.ts),
      sentByA: prev.sentByA + (fromA ? 1 : 0),
      sentByB: prev.sentByB + (fromA ? 0 : 1),
      media: { ...prev.media },
    };
    this.edges.set(threadId, edge);
    return { edge, evicted };
  }

  /** A buffered message by ID. */
  get(id: string): Message | undefined {
    return this.byId.get(id);
  }

  /** The last `limit` messages of a thread (all when omitted), oldest first. */
  history(threadId: string, limit?: number): Message[] {
    const buffer = this.buffers.get(threadId) ?? [];
    return limit === undefined ? [...buffer] : buffer.slice(Math.max(0, buffer.length - limit));
  }

  /** Every buffered message across all threads, oldest first (ULID order). */
  allMessages(): Message[] {
    return [...this.byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }

  /** Every edge, as stored (weights as of each edge's `updatedAt`). */
  allEdges(): EdgeStats[] {
    return [...this.edges.values()].map((e) => ({ ...e, media: { ...e.media } }));
  }

  /** Statistics for one thread. */
  edge(threadId: string): EdgeStats | undefined {
    return this.edges.get(threadId);
  }

  /**
   * Changes a thread's unexpired media count for one kind by `delta`, never
   * below zero. Returns a copy of the edge after the change, or undefined when
   * the thread has no edge yet.
   */
  adjustMedia(threadId: string, kind: MediaKind, delta: number): EdgeStats | undefined {
    const edge = this.edges.get(threadId);
    if (!edge) return undefined;
    edge.media = { ...edge.media, [kind]: Math.max(0, edge.media[kind] + delta) };
    return { ...edge, media: { ...edge.media } };
  }
}
