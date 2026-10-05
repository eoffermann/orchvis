import {
  DEFAULT_LIMITS,
  MEDIA_SWEEP_INTERVAL_MS,
  OWNER_ADDRESS,
  OWNER_KEY,
  PROTOCOL_VERSION,
  addressKey,
  bumpEdge,
  makeSessionId,
  mediaKindOf,
  sanitizeText,
  sessionAddress,
  threadIdFor,
  threadParticipants,
  utf8Bytes,
  type Address,
  type BrokerToUiFrame,
  type ControlAction,
  type ControlState,
  type EdgeStats,
  type Limits,
  type MediaIndexEntry,
  type MediaKind,
  type MediaRef,
  type MediaStoreUsage,
  type Message,
  type MessageKind,
  type PayloadOf,
  type RejectCode,
  type SessionId,
  type SessionNode,
  type UiToBrokerFrame,
} from '@orchvis/protocol';
import { TimerGroup, type Clock } from './clock.js';
import { sha256Hex, type MediaSample } from './media.js';
import { Rng } from './random.js';
import { allRepos, type Scenario, type SimSessionSpec } from './scenario.js';
import { TrafficEngine, type SendIntent, type StatusIntent, type TrafficOptions, type TrafficSink } from './traffic.js';
import { createUlidFactory } from './ulid.js';

/** Frame types the mock broadcasts as live deltas. */
export type UiDeltaType = 'node' | 'message' | 'seen' | 'media' | 'control_state';

/** A live delta: a broker-to-UI frame without its envelope. */
export type UiDelta = { [T in UiDeltaType]: { type: T; payload: PayloadOf<BrokerToUiFrame, T> } }[UiDeltaType];

/** Payload of a `snapshot` frame. */
export type SnapshotPayload = PayloadOf<BrokerToUiFrame, 'snapshot'>;

/** Version string the mock reports as `brokerVersion`. */
export const MOCK_BROKER_VERSION = 'mock-0.1.0';

/** Options for {@link MockWorld}. */
export interface MockWorldOptions {
  scenario: Scenario;
  clock: Clock;
  /** Seed for every random choice the world makes. Default: the scenario's seed. */
  seed?: number;
  /** Overrides for the limits reported in `snapshot` and enforced by the mock. */
  limits?: Partial<Limits>;
  /** Traffic generator options. `mediaRate` defaults to 0.05 here. */
  traffic?: TrafficOptions;
  /** Probability that a long disconnect (over a minute) retires a session for good. Default 0.3. */
  churnRate?: number;
}

/** Result of an Owner send: the stamped message, or a rejection. */
export type OwnerSendResult =
  | { ok: true; message: Message }
  | { ok: false; code: RejectCode; detail: string };

interface StoredMedia {
  ref: MediaRef;
  kind: MediaKind;
  data: Uint8Array;
}

interface PendingUpload extends StoredMedia {
  uploader: typeof OWNER_KEY | SessionId;
}

interface Slot {
  spec: SimSessionSpec;
  /** Set while the node is retiring: it will be removed and replaced. */
  retiring: boolean;
  /** Unseen delivered message IDs waiting for this session to read them. */
  unseen: string[];
}

/**
 * Broker state for the mock UI feed: nodes, edges, ring buffers, media index,
 * controls and store usage, driven by a {@link TrafficEngine}. Every change is
 * published as a {@link UiDelta}, and {@link MockWorld.snapshot} returns the
 * state those deltas build up, so the two always agree.
 */
export class MockWorld implements TrafficSink {
  /** Limits in force. */
  readonly limits: Limits;
  /** The traffic generator driving this world. */
  readonly engine: TrafficEngine;

  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly timers: TimerGroup;
  private readonly ulid: () => string;
  private readonly churnRate: number;
  private readonly slots: Slot[];
  private readonly nodes = new Map<SessionId, SessionNode>();
  private readonly edges = new Map<string, EdgeStats>();
  private readonly threads = new Map<string, Message[]>();
  private readonly messageIndex = new Map<string, Message>();
  private readonly media = new Map<string, MediaIndexEntry & { data: Uint8Array }>();
  private readonly uploads = new Map<string, PendingUpload>();
  private control: ControlState = { mutedThreads: [], pausedSessions: [], pausedAll: false };
  private usage: MediaStoreUsage;
  private readonly listeners = new Set<(delta: UiDelta) => void>();
  private mediaCounter = 0;
  private started = false;

  /** Builds the world with every scenario session connected. Call {@link MockWorld.start} to begin traffic. */
  constructor(options: MockWorldOptions) {
    this.clock = options.clock;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    const root = new Rng(options.seed ?? options.scenario.seed);
    this.rng = root.fork('world');
    this.ulid = createUlidFactory(this.clock, root.fork('ids'));
    this.timers = new TimerGroup(this.clock);
    this.churnRate = options.churnRate ?? 0.3;
    this.usage = { bytes: 0, capBytes: this.limits.mediaStoreBytes, files: 0 };
    this.slots = options.scenario.sessions.map((spec) => ({ spec, retiring: false, unseen: [] }));
    const now = this.clock.now();
    for (const slot of this.slots) this.nodes.set(slot.spec.sessionId, this.nodeFor(slot.spec, now));
    this.engine = new TrafficEngine(this.clock, root.fork('traffic'), options.scenario.sessions, this, {
      mediaRate: 0.05,
      ...options.traffic,
    });
  }

  private nodeFor(spec: SimSessionSpec, now: number): SessionNode {
    return {
      id: spec.sessionId,
      hostname: spec.hostname,
      platform: spec.platform,
      name: spec.name,
      focus: spec.focus,
      repos: allRepos(spec),
      cwd: spec.cwd,
      status: 'working',
      delivery: spec.persona,
      connected: true,
      lastSeen: now,
    };
  }

  /** Starts traffic, poll-mode seen batches and the media sweep. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.engine.start();
    this.slots.forEach((slot) => this.schedulePoll(slot));
    this.timers.every(MEDIA_SWEEP_INTERVAL_MS, () => this.sweepMedia());
  }

  /** Stops everything. The state stays readable. */
  stop(): void {
    this.engine.stop();
    this.timers.close();
  }

  /** Subscribes to deltas. Returns an unsubscribe function. */
  subscribe(listener: (delta: UiDelta) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(delta: UiDelta): void {
    for (const l of this.listeners) l(delta);
  }

  /** The current state, as a `snapshot` payload. */
  snapshot(): SnapshotPayload {
    const messages = [...this.threads.values()].flat().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return structuredClone({
      brokerVersion: MOCK_BROKER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      now: this.clock.now(),
      limits: this.limits,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      messages,
      media: [...this.media.values()].map(({ data: _data, ...entry }) => entry),
      control: this.control,
      mediaStore: this.usage,
    });
  }

  /** Current session ID of each scenario slot. */
  sessionIds(): SessionId[] {
    return this.slots.map((s) => s.spec.sessionId);
  }

  /** Bytes and MIME type of a stored or uploaded media item, for `GET /api/media/:id`. */
  mediaData(mediaId: string): { mime: string; filename: string; data: Uint8Array } | undefined {
    const m = this.media.get(mediaId) ?? this.uploads.get(mediaId);
    if (!m) return undefined;
    return { mime: m.ref.mime, filename: m.ref.filename, data: m.data };
  }

  private slotOf(id: SessionId): number {
    return this.slots.findIndex((s) => s.spec.sessionId === id);
  }

  private upsertNode(node: SessionNode): void {
    this.nodes.set(node.id, node);
    this.publish({ type: 'node', payload: { op: 'upsert', node: structuredClone(node) } });
  }

  // ---- TrafficSink ----

  /** {@inheritDoc TrafficSink.send} */
  send(intent: SendIntent): string | undefined {
    const slot = this.slots[intent.from];
    if (!slot) return undefined;
    const fromNode = this.nodes.get(slot.spec.sessionId);
    if (!fromNode || !fromNode.connected) return undefined;
    let to: Address;
    if (intent.to === 'owner') {
      to = OWNER_ADDRESS;
    } else {
      const target = this.slots[intent.to];
      if (!target || !this.nodes.has(target.spec.sessionId) || target.spec.sessionId === fromNode.id) return undefined;
      to = sessionAddress(target.spec.sessionId);
    }
    const from = sessionAddress(fromNode.id);
    const threadId = threadIdFor(from, to);
    if (to.kind === 'session') {
      // Controls block peer traffic only; threads with the Owner are never blocked.
      if (this.control.pausedAll || this.control.pausedSessions.includes(fromNode.id)) return undefined;
      if (this.control.mutedThreads.includes(threadId)) return undefined;
    }
    const attachments = intent.media.map((sample) => this.storeSample(sample, fromNode.id));
    const message = this.route(from, fromNode.name, to, 'peer', intent.kind, intent.body, intent.replyTo, attachments);
    return message.id;
  }

  /** {@inheritDoc TrafficSink.status} */
  status(index: number, change: StatusIntent): void {
    const slot = this.slots[index];
    const node = slot && this.nodes.get(slot.spec.sessionId);
    if (!node || !node.connected) return;
    const next: SessionNode = { ...node, lastSeen: this.clock.now() };
    if (change.status !== undefined) next.status = change.status;
    if (change.focus !== undefined) next.focus = change.focus;
    if (change.delivery !== undefined) next.delivery = change.delivery;
    this.upsertNode(next);
  }

  /** {@inheritDoc TrafficSink.disconnect} */
  disconnect(index: number, downMs: number): void {
    const slot = this.slots[index];
    const node = slot && this.nodes.get(slot.spec.sessionId);
    if (!slot || !node || !node.connected) return;
    const now = this.clock.now();
    this.upsertNode({ ...node, connected: false, lastSeen: now });
    if (downMs > 60_000 && this.rng.chance(this.churnRate)) {
      // Gone for good: removed once offline retention runs out, then a fresh session takes the slot.
      slot.retiring = true;
      this.timers.after(this.limits.offlineRetentionMs, () => this.retire(index));
      return;
    }
    this.timers.after(downMs, () => {
      const current = this.nodes.get(node.id);
      if (!current || current.connected) return;
      this.upsertNode({ ...current, connected: true, lastSeen: this.clock.now() });
      if (slot.spec.persona === 'push') this.timers.after(this.rng.range(500, 3_000), () => this.flushSeen(slot));
    });
  }

  private retire(index: number): void {
    const slot = this.slots[index];
    if (!slot) return;
    const oldId = slot.spec.sessionId;
    this.nodes.delete(oldId);
    slot.unseen = [];
    this.publish({ type: 'node', payload: { op: 'remove', id: oldId } });
    this.timers.after(this.rng.range(10_000, 60_000), () => {
      const claudeSessionId = this.rng.uuid();
      const taken = new Set([...this.nodes.values()].map((n) => n.name.toLowerCase()));
      const base = slot.spec.name.replace(/-r\d+$/, '');
      let name = `${base}-r2`;
      for (let n = 3; taken.has(name.toLowerCase()); n++) name = `${base}-r${n}`;
      slot.spec = { ...slot.spec, claudeSessionId, sessionId: makeSessionId(slot.spec.hostname, claudeSessionId), name };
      slot.retiring = false;
      this.upsertNode(this.nodeFor(slot.spec, this.clock.now()));
    });
  }

  // ---- Owner actions ----

  /**
   * Handles an Owner message to one session: checks the recipient, size and
   * attachments, then routes it like the broker would. The recipient answers
   * after a short delay. Controls never block it.
   */
  ownerSend(payload: PayloadOf<UiToBrokerFrame, 'owner_send'>): OwnerSendResult {
    const node = this.nodes.get(payload.to);
    if (!node) return { ok: false, code: 'unknown_recipient', detail: `no session ${payload.to}` };
    if (utf8Bytes(payload.body) > this.limits.maxBodyBytes) return { ok: false, code: 'too_large', detail: 'body over the size limit' };
    if (new Set(payload.attachments).size !== payload.attachments.length) {
      return { ok: false, code: 'invalid', detail: 'duplicate attachment' };
    }
    for (const id of payload.attachments) {
      const up = this.uploads.get(id);
      if (!up || up.uploader !== OWNER_KEY) return { ok: false, code: 'invalid', detail: `media ${id} is unknown, used or not yours` };
    }
    const attachments = payload.attachments.map((id) => {
      const up = this.uploads.get(id) as PendingUpload;
      this.uploads.delete(id);
      return up;
    });
    const message = this.route(OWNER_ADDRESS, OWNER_KEY, sessionAddress(node.id), 'owner', payload.kind, payload.body, payload.replyTo, attachments);
    return { ok: true, message };
  }

  /** Stores an Owner upload until it is attached (single use) or its TTL runs out. */
  ownerUpload(file: { filename: string; mime: string; data: Uint8Array }, caption: string): MediaRef {
    const sample: MediaSample = {
      kind: mediaKindOf(file.mime),
      mime: file.mime,
      filename: file.filename,
      data: file.data,
      sha256: sha256Hex(file.data),
      caption,
    };
    const stored = this.storeSample(sample, OWNER_KEY);
    return stored.ref;
  }

  /** Applies an Owner control and broadcasts the resulting `control_state`. */
  applyControl(action: ControlAction): void {
    const c = this.control;
    const without = (list: string[], v: string) => list.filter((x) => x !== v);
    switch (action.action) {
      case 'mute_thread':
        if (!c.mutedThreads.includes(action.threadId)) c.mutedThreads = [...c.mutedThreads, action.threadId];
        break;
      case 'unmute_thread':
        c.mutedThreads = without(c.mutedThreads, action.threadId);
        break;
      case 'pause_session':
        if (!c.pausedSessions.includes(action.sessionId)) c.pausedSessions = [...c.pausedSessions, action.sessionId];
        break;
      case 'resume_session':
        c.pausedSessions = without(c.pausedSessions, action.sessionId);
        break;
      case 'pause_all':
        c.pausedAll = true;
        break;
      case 'resume_all':
        c.pausedAll = false;
        break;
    }
    this.publish({ type: 'control_state', payload: structuredClone(c) });
  }

  // ---- Routing ----

  private storeSample(sample: MediaSample, uploader: typeof OWNER_KEY | SessionId): PendingUpload {
    const mediaId = `med_${(++this.mediaCounter).toString(36)}_${this.rng.hex(8)}`;
    const ref: MediaRef = {
      mediaId,
      mime: sample.mime,
      filename: sanitizeText(sample.filename),
      bytes: sample.data.byteLength,
      sha256: sample.sha256,
      caption: sanitizeText(sample.caption),
      expiresAt: this.clock.now() + this.limits.mediaTtlMs,
    };
    const up: PendingUpload = { ref, kind: mediaKindOf(sample.mime), data: sample.data, uploader };
    this.uploads.set(mediaId, up);
    // Unattached uploads vanish at their TTL.
    this.timers.after(this.limits.mediaTtlMs, () => this.uploads.delete(mediaId));
    return up;
  }

  private route(
    from: Address,
    fromName: string,
    to: Address,
    senderKind: Message['senderKind'],
    kind: MessageKind,
    body: string,
    replyTo: string | undefined,
    attachments: StoredMedia[],
  ): Message {
    const now = this.clock.now();
    const threadId = threadIdFor(from, to);
    const message: Message = {
      id: this.ulid(),
      threadId,
      from,
      fromName,
      to,
      senderKind,
      kind,
      body: sanitizeText(body),
      attachments: attachments.map((a) => a.ref),
      ts: now,
    };
    if (replyTo !== undefined) message.replyTo = replyTo;
    for (const a of attachments) this.uploads.delete(a.ref.mediaId);

    const buffer = this.threads.get(threadId) ?? [];
    buffer.push(message);
    this.messageIndex.set(message.id, message);
    while (buffer.length > this.limits.ringBufferPerThread) {
      const evicted = buffer.shift();
      if (evicted) this.messageIndex.delete(evicted.id);
    }
    this.threads.set(threadId, buffer);

    const [pa, pb] = threadParticipants(threadId);
    const keyA = addressKey(pa);
    const prev = this.edges.get(threadId) ?? {
      threadId,
      a: keyA,
      b: addressKey(pb),
      weight: 0,
      updatedAt: now,
      lastMessageAt: now,
      sentByA: 0,
      sentByB: 0,
      media: { image: 0, audio: 0, video: 0, other: 0 },
    };
    const bumped = bumpEdge(prev, now, this.limits.edgeTauMs);
    const fromA = addressKey(from) === keyA;
    const edge: EdgeStats = {
      ...prev,
      weight: bumped.weight,
      updatedAt: bumped.updatedAt,
      lastMessageAt: now,
      sentByA: prev.sentByA + (fromA ? 1 : 0),
      sentByB: prev.sentByB + (fromA ? 0 : 1),
      media: { ...prev.media },
    };
    this.edges.set(threadId, edge);
    this.publish({ type: 'message', payload: { message: structuredClone(message), edge: structuredClone(edge) } });

    for (const a of attachments) {
      const entry: MediaIndexEntry = { ref: a.ref, kind: a.kind, threadId, messageId: message.id, from, ts: now };
      this.media.set(a.ref.mediaId, { ...entry, data: a.data });
      const e = this.edges.get(threadId) as EdgeStats;
      const next = { ...e, media: { ...e.media, [a.kind]: e.media[a.kind] + 1 } };
      this.edges.set(threadId, next);
      this.usage = { ...this.usage, bytes: this.usage.bytes + a.ref.bytes, files: this.usage.files + 1 };
      this.publish({ type: 'media', payload: { op: 'add', entry: structuredClone(entry), edge: structuredClone(next), mediaStore: { ...this.usage } } });
    }
    if (attachments.length > 0) this.evictOverCap();

    if (to.kind === 'session') {
      const toSlot = this.slotOf(to.id);
      const slot = this.slots[toSlot];
      if (slot) {
        slot.unseen.push(message.id);
        if (slot.spec.persona === 'push') this.timers.after(this.rng.range(500, 4_000), () => this.flushSeen(slot));
        const fromSlot = from.kind === 'owner' ? 'owner' : this.slotOf(from.id);
        if (fromSlot !== -1) this.engine.onDelivered(toSlot, fromSlot, message.id, kind);
      }
    }
    return message;
  }

  private schedulePoll(slot: Slot): void {
    this.timers.after(this.rng.range(20_000, 90_000), () => {
      if (slot.spec.persona === 'poll') this.flushSeen(slot);
      this.schedulePoll(slot);
    });
  }

  /** The session in `slot` reads everything delivered to it, if it is connected. */
  private flushSeen(slot: Slot): void {
    const node = this.nodes.get(slot.spec.sessionId);
    if (!node || !node.connected || slot.unseen.length === 0) return;
    const now = this.clock.now();
    const ids = slot.unseen.filter((id) => this.messageIndex.has(id));
    slot.unseen = [];
    if (ids.length === 0) return;
    for (const id of ids) (this.messageIndex.get(id) as Message).seenAt = now;
    for (let i = 0; i < ids.length; i += 500) {
      this.publish({ type: 'seen', payload: { by: node.id, ids: ids.slice(i, i + 500), seenAt: now } });
    }
  }

  // ---- Media expiry ----

  private expire(mediaId: string): void {
    const item = this.media.get(mediaId);
    if (!item) return;
    this.media.delete(mediaId);
    const e = this.edges.get(item.threadId) as EdgeStats;
    const next = { ...e, media: { ...e.media, [item.kind]: Math.max(0, e.media[item.kind] - 1) } };
    this.edges.set(item.threadId, next);
    this.usage = { ...this.usage, bytes: this.usage.bytes - item.ref.bytes, files: this.usage.files - 1 };
    this.publish({
      type: 'media',
      payload: { op: 'expire', mediaId, threadId: item.threadId, edge: structuredClone(next), mediaStore: { ...this.usage } },
    });
  }

  private sweepMedia(): void {
    const now = this.clock.now();
    const due = [...this.media.values()].filter((m) => m.ref.expiresAt <= now).sort((x, y) => x.ref.expiresAt - y.ref.expiresAt);
    for (const m of due) this.expire(m.ref.mediaId);
  }

  private evictOverCap(): void {
    while (this.usage.bytes > this.usage.capBytes && this.media.size > 0) {
      const oldest = this.media.keys().next().value as string;
      this.expire(oldest);
    }
  }
}
