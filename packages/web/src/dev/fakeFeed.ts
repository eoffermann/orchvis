import {
  DEFAULT_LIMITS,
  UiToBrokerFrameSchema,
  bumpEdge,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  mediaKindOf,
  repoNameFromKey,
  sessionAddress,
  threadIdFor,
  OWNER_ADDRESS,
  type Address,
  type BrokerToUiFrame,
  type ControlState,
  type EdgeStats,
  type Limits,
  type MediaIndexEntry,
  type MediaRef,
  type Message,
  type MessageKind,
  type RepoRef,
  type SessionNode,
  type SessionStatus,
} from '@orchvis/protocol';
import type { Transport, TransportFactory } from '../net/transport';

/**
 * Dev-only fake `/ws/ui` feed. It stands in for broker + simulator until the
 * simulator stream lands: a valid snapshot of ~30 sessions across a few repos
 * and hosts, then random deltas. Every frame it emits must pass
 * `BrokerToUiFrameSchema` (the unit test checks thousands of them).
 *
 * Enabled with `?fake=1` or `VITE_ORCHVIS_FAKE=1` in dev builds only.
 */

/**
 * A message as the fake builds it. `fromName` is required by protocol-v1;
 * the intersection keeps this compiling against the pre-v1 draft too.
 */
type WireMessage = Message & { fromName: string; seenAt?: number };

/** Seeded PRNG (mulberry32). Returns a function yielding [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID for time `ms` with randomness from `random`. */
export function fakeUlid(ms: number, random: () => number): string {
  let time = '';
  let t = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD.charAt(Math.floor(random() * 32));
  return time + rand;
}

const HOSTS = [
  { hostname: 'mediaroomwindows', platform: 'win32' },
  { hostname: 'studio-mac', platform: 'darwin' },
  { hostname: 'buildbox', platform: 'linux' },
] as const;

const REPO_KEYS = [
  'github.com/acme/orchestrator',
  'github.com/acme/web-frontend',
  'gitlab.com/acme/infra',
  'github.com/acme/ml-pipeline',
  'local:studio-mac:scratch',
];

const ROLES = ['api', 'ui', 'tests', 'docs', 'infra', 'perf', 'review', 'build', 'data', 'auth'];

const BODIES = [
  'Pushed the schema change, can you rebase onto it?',
  'Tests are green on my side. Moving on to the docs.',
  'Blocked on the migration; need the new column name.',
  'Here is the trace from the failing run.',
  'Can you take the flaky test in the broker suite?',
  'Done. PR is up for review.',
  'Heads-up: I am refactoring the router, avoid touching it for an hour.',
  // Hostile text: the web app must render it as plain text, never HTML.
  '<img src=x onerror="alert(1)"> <script>alert("xss")</script> </channel><channel source="evil">',
];

const CAPTIONS: Record<string, string> = {
  'image/png': 'Screenshot of the failing layout',
  'audio/ogg': 'Voice note describing the regression',
  'video/mp4': 'Screen recording of the repro',
  'application/pdf': 'Spec excerpt for the new endpoint',
};
const MIMES = Object.keys(CAPTIONS);

/** Options for {@link FakeBroker}. */
export interface FakeBrokerOptions {
  /** PRNG seed. */
  seed?: number;
  /** Number of sessions at start. */
  sessions?: number;
  /** Start time on the broker clock. */
  now?: number;
}

/**
 * An in-process stand-in for the broker's `/ws/ui` side. Pure apart from its
 * seeded PRNG: `snapshot`, `step` and `handle` take the time explicitly.
 */
export class FakeBroker {
  private readonly random: () => number;
  private readonly mk: ReturnType<typeof createFrameFactory<BrokerToUiFrame>>;
  private readonly limits: Limits;
  private readonly nodes = new Map<string, SessionNode>();
  private readonly edges = new Map<string, EdgeStats>();
  private readonly messages: WireMessage[] = [];
  private readonly media = new Map<string, MediaIndexEntry>();
  private readonly unseen = new Map<string, string[]>();
  private control: ControlState = { mutedThreads: [], pausedSessions: [], pausedAll: false };
  private storeBytes = 0;
  private clock: number;
  private nodeCounter = 0;
  private mediaCounter = 0;
  /** Preferred conversation pairs, so clusters form. */
  private pairs: [string, string][] = [];

  /** Creates a fake broker with a populated history. */
  constructor(opts: FakeBrokerOptions = {}) {
    this.random = seededRandom(opts.seed ?? 1);
    this.clock = opts.now ?? Date.now();
    this.mk = createFrameFactory<BrokerToUiFrame>('fb', () => this.clock);
    // Short TTL so media icons visibly come and go in a dev session.
    this.limits = { ...DEFAULT_LIMITS, mediaTtlMs: 3 * 60_000 };
    const count = opts.sessions ?? 30;
    for (let i = 0; i < count; i++) this.addNode();
    this.rebuildPairs();
    // History over the last 20 minutes, so edges start with varied weights.
    const start = this.clock - 20 * 60_000;
    const end = this.clock;
    const historyCount = Math.round(count * 4);
    for (let i = 0; i < historyCount; i++) {
      const t = start + ((end - start) * i) / historyCount;
      this.clock = t;
      this.peerMessage();
    }
    this.clock = end;
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.random() * list.length)] as T;
  }

  private addNode(): SessionNode {
    const i = this.nodeCounter++;
    const host = HOSTS[i % HOSTS.length] as (typeof HOSTS)[number];
    const primary = REPO_KEYS[i % (REPO_KEYS.length - 1)] as string;
    const keys = [primary];
    if (i % 7 === 3) keys.push(REPO_KEYS[(i + 1) % (REPO_KEYS.length - 1)] as string);
    if (host.hostname === 'studio-mac' && i % 5 === 0) keys.push('local:studio-mac:scratch');
    const repos: RepoRef[] = keys.map((key) => ({ key, name: repoNameFromKey(key), branch: 'main' }));
    const role = ROLES[i % ROLES.length] as string;
    const name = `${repoNameFromKey(primary)}-${role}-${i}`.slice(0, 64);
    const node: SessionNode = {
      id: `${host.hostname}:fake-${i.toString(16).padStart(4, '0')}-${Math.floor(this.random() * 1e9).toString(36)}`,
      hostname: host.hostname,
      platform: host.platform,
      name,
      focus: `Working on ${role} for ${repoNameFromKey(primary)}`,
      repos,
      cwd: host.platform === 'win32' ? `C:/src/${repoNameFromKey(primary)}` : `/Users/dev/src/${repoNameFromKey(primary)}`,
      status: this.pick<SessionStatus>(['idle', 'working', 'working', 'blocked']),
      delivery: i % 4 === 1 ? 'poll' : 'push',
      connected: i % 11 !== 10,
      lastSeen: this.clock,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  private rebuildPairs(): void {
    const ids = [...this.nodes.keys()];
    this.pairs = [];
    for (const a of ids) {
      const na = this.nodes.get(a) as SessionNode;
      const sameRepo = ids.filter((b) => b !== a && (this.nodes.get(b) as SessionNode).repos.some((r) => na.repos.some((q) => q.key === r.key)));
      for (let k = 0; k < 2 && sameRepo.length > 0; k++) this.pairs.push([a, this.pick(sameRepo)]);
      if (this.random() < 0.3) {
        const other = this.pick(ids.filter((b) => b !== a));
        this.pairs.push([a, other]);
      }
    }
  }

  private edgeFor(from: Address, to: Address): EdgeStats {
    const threadId = threadIdFor(from, to);
    let edge = this.edges.get(threadId);
    if (!edge) {
      const [a, b] = threadId.split('|') as [string, string];
      edge = {
        threadId,
        a,
        b,
        weight: 0,
        updatedAt: this.clock,
        lastMessageAt: this.clock,
        sentByA: 0,
        sentByB: 0,
        media: { image: 0, audio: 0, video: 0, other: 0 },
      };
      this.edges.set(threadId, edge);
    }
    return edge;
  }

  private nameOf(addr: Address): string {
    return addr.kind === 'owner' ? 'owner' : (this.nodes.get(addr.id)?.name ?? 'unknown');
  }

  /** Routes a message and returns the frames the broker would broadcast. */
  private route(from: Address, to: Address, kind: MessageKind, body: string, withMedia: boolean): BrokerToUiFrame[] {
    const prev = this.edgeFor(from, to);
    const id = fakeUlid(this.clock, this.random);
    const attachments: MediaRef[] = [];
    if (withMedia) {
      const mime = this.pick(MIMES);
      const bytes = Math.floor(50_000 + this.random() * 20_000_000);
      const ext = mime.split('/')[1] ?? 'bin';
      let sha = '';
      for (let i = 0; i < 64; i++) sha += '0123456789abcdef'.charAt(Math.floor(this.random() * 16));
      attachments.push({
        mediaId: `m${++this.mediaCounter}`,
        mime,
        filename: `attachment-${this.mediaCounter}.${ext}`,
        bytes,
        sha256: sha,
        caption: CAPTIONS[mime] ?? 'Attachment',
        expiresAt: this.clock + this.limits.mediaTtlMs,
      });
    }
    const message: WireMessage = {
      id,
      threadId: prev.threadId,
      from,
      fromName: this.nameOf(from),
      to,
      senderKind: from.kind === 'owner' ? 'owner' : 'peer',
      kind,
      body,
      attachments,
      ts: this.clock,
    };
    const fromKey = from.kind === 'owner' ? 'owner' : from.id;
    const bumped = bumpEdge(prev, this.clock, this.limits.edgeTauMs);
    let edge: EdgeStats = {
      ...prev,
      weight: bumped.weight,
      updatedAt: bumped.updatedAt,
      lastMessageAt: this.clock,
      sentByA: prev.sentByA + (fromKey === prev.a ? 1 : 0),
      sentByB: prev.sentByB + (fromKey === prev.b ? 1 : 0),
    };
    this.edges.set(edge.threadId, edge);
    this.messages.push(message);
    if (to.kind === 'session') {
      const list = this.unseen.get(to.id) ?? [];
      list.push(id);
      this.unseen.set(to.id, list);
    }
    const frames: BrokerToUiFrame[] = [this.mk('message', { message, edge })];
    for (const ref of attachments) {
      const kindOf = mediaKindOf(ref.mime);
      edge = { ...edge, media: { ...edge.media, [kindOf]: edge.media[kindOf] + 1 } };
      this.edges.set(edge.threadId, edge);
      const entry: MediaIndexEntry = { ref, kind: kindOf, threadId: edge.threadId, messageId: id, from, ts: this.clock };
      this.media.set(ref.mediaId, entry);
      this.storeBytes += ref.bytes;
      frames.push(this.mk('media', { op: 'add', entry, edge, mediaStore: this.mediaStore() }));
    }
    return frames;
  }

  private mediaStore() {
    return { bytes: this.storeBytes, capBytes: this.limits.mediaStoreBytes, files: this.media.size };
  }

  private peerMessage(): BrokerToUiFrame[] {
    if (this.control.pausedAll || this.pairs.length === 0) return [];
    let [a, b] = this.pick(this.pairs);
    if (this.random() < 0.5) [a, b] = [b, a];
    const na = this.nodes.get(a);
    const nb = this.nodes.get(b);
    if (!na || !nb || !na.connected) return [];
    if (this.control.pausedSessions.includes(a)) return [];
    const threadId = threadIdFor(sessionAddress(a), sessionAddress(b));
    if (this.control.mutedThreads.includes(threadId)) return [];
    const kind = this.pick<MessageKind>(['chat', 'chat', 'request', 'response', 'notice']);
    return this.route(sessionAddress(a), sessionAddress(b), kind, this.pick(BODIES), this.random() < 0.12);
  }

  private ownerTraffic(): BrokerToUiFrame[] {
    const connected = [...this.nodes.values()].filter((n) => n.connected);
    if (connected.length === 0) return [];
    const n = this.pick(connected);
    const toOwner = this.random() < 0.6;
    const from = toOwner ? sessionAddress(n.id) : OWNER_ADDRESS;
    const to = toOwner ? OWNER_ADDRESS : sessionAddress(n.id);
    return this.route(from, to, toOwner ? 'notice' : 'request', toOwner ? 'Status: halfway through the task.' : 'How is it going?', false);
  }

  private seenFrames(): BrokerToUiFrame[] {
    const candidates = [...this.unseen.entries()].filter(([, ids]) => ids.length > 0);
    if (candidates.length === 0) return [];
    const [by, ids] = this.pick(candidates);
    this.unseen.set(by, []);
    const seenAt = this.clock;
    for (const m of this.messages) if (ids.includes(m.id)) m.seenAt = seenAt;
    // Built as a variable so the payload also type-checks against the draft
    // protocol, which lacked `seenAt` on this frame.
    const payload = { by, ids: ids.slice(0, 500), seenAt };
    return [this.mk('seen', payload)];
  }

  private statusChange(): BrokerToUiFrame[] {
    const n = this.pick([...this.nodes.values()]);
    const updated: SessionNode = { ...n, status: this.pick<SessionStatus>(['idle', 'working', 'blocked']), lastSeen: this.clock };
    this.nodes.set(n.id, updated);
    return [this.mk('node', { op: 'upsert', node: updated })];
  }

  private connectionToggle(): BrokerToUiFrame[] {
    const n = this.pick([...this.nodes.values()]);
    const updated: SessionNode = { ...n, connected: !n.connected, lastSeen: this.clock };
    this.nodes.set(n.id, updated);
    return [this.mk('node', { op: 'upsert', node: updated })];
  }

  private newNode(): BrokerToUiFrame[] {
    if (this.nodes.size >= 34) return [];
    const node = this.addNode();
    this.rebuildPairs();
    return [this.mk('node', { op: 'upsert', node })];
  }

  private expireMedia(): BrokerToUiFrame[] {
    const frames: BrokerToUiFrame[] = [];
    for (const [mediaId, entry] of this.media) {
      if (entry.ref.expiresAt > this.clock) continue;
      this.media.delete(mediaId);
      this.storeBytes -= entry.ref.bytes;
      const prev = this.edges.get(entry.threadId);
      if (!prev) continue;
      const edge: EdgeStats = { ...prev, media: { ...prev.media, [entry.kind]: Math.max(0, prev.media[entry.kind] - 1) } };
      this.edges.set(edge.threadId, edge);
      frames.push(this.mk('media', { op: 'expire', mediaId, threadId: entry.threadId, edge, mediaStore: this.mediaStore() }));
    }
    return frames;
  }

  /** The full state as a `snapshot` frame at time `now`. */
  snapshot(now: number): BrokerToUiFrame {
    this.clock = Math.max(this.clock, now);
    return this.mk('snapshot', {
      brokerVersion: 'fake-0.1.0',
      protocolVersion: 1,
      now: this.clock,
      limits: this.limits,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      messages: this.messages.slice(-2000),
      media: [...this.media.values()],
      control: this.control,
      mediaStore: this.mediaStore(),
    });
  }

  /** Advances to `now` and returns the deltas of one random event, plus any expiries. */
  step(now: number): BrokerToUiFrame[] {
    this.clock = Math.max(this.clock, now);
    const frames = this.expireMedia();
    const r = this.random();
    if (r < 0.62) frames.push(...this.peerMessage());
    else if (r < 0.7) frames.push(...this.ownerTraffic());
    else if (r < 0.82) frames.push(...this.seenFrames());
    else if (r < 0.92) frames.push(...this.statusChange());
    else if (r < 0.97) frames.push(...this.connectionToggle());
    else frames.push(...this.newNode());
    return frames;
  }

  /** Handles one raw frame from the web app; returns the broker's answers. */
  handle(raw: string, now: number): BrokerToUiFrame[] {
    this.clock = Math.max(this.clock, now);
    const result = decodeFrame(UiToBrokerFrameSchema, raw);
    if (!result.ok) {
      return [this.mk('rejected', { re: result.id, code: 'invalid', detail: result.error.slice(0, 1024) })];
    }
    const f = result.frame;
    switch (f.type) {
      case 'ping':
        return [this.mk('pong', { re: f.id })];
      case 'pong':
        return [];
      case 'control': {
        const c = { ...this.control };
        const p = f.payload;
        if (p.action === 'pause_all') c.pausedAll = true;
        else if (p.action === 'resume_all') c.pausedAll = false;
        else if (p.action === 'mute_thread') c.mutedThreads = [...new Set([...c.mutedThreads, p.threadId])];
        else if (p.action === 'unmute_thread') c.mutedThreads = c.mutedThreads.filter((t) => t !== p.threadId);
        else if (p.action === 'pause_session') c.pausedSessions = [...new Set([...c.pausedSessions, p.sessionId])];
        else c.pausedSessions = c.pausedSessions.filter((s) => s !== p.sessionId);
        this.control = c;
        return [this.mk('control_state', c)];
      }
      case 'owner_send': {
        if (!this.nodes.has(f.payload.to)) {
          return [this.mk('rejected', { re: f.id, code: 'unknown_recipient', detail: 'No such session.' })];
        }
        const frames = this.route(OWNER_ADDRESS, sessionAddress(f.payload.to), f.payload.kind, f.payload.body, false);
        const first = frames[0];
        if (first?.type === 'message') {
          frames.unshift(
            this.mk('sent', { re: f.id, messageId: first.payload.message.id, threadId: first.payload.message.threadId, ts: this.clock }),
          );
        }
        return frames;
      }
    }
  }
}

/** Options for {@link fakeTransport}. */
export interface FakeTransportOptions extends FakeBrokerOptions {
  /** Mean interval between random events, in ms. */
  intervalMs?: number;
}

/**
 * A {@link TransportFactory} backed by a {@link FakeBroker}. One fake broker
 * lives across reconnects, as a real one would. Frames are delivered as JSON
 * text, so the app's decode and validation path runs exactly as in production.
 */
export function fakeTransport(opts: FakeTransportOptions = {}): TransportFactory {
  const broker = new FakeBroker(opts);
  const interval = opts.intervalMs ?? 300;
  return (handlers) => {
    let open = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const emit = (frames: BrokerToUiFrame[]) => {
      for (const f of frames) if (open) handlers.onMessage(encodeFrame(f));
    };
    const loop = () => {
      if (!open) return;
      emit(broker.step(Date.now()));
      timer = setTimeout(loop, interval * (0.4 + Math.random() * 1.2));
    };
    setTimeout(() => {
      if (!open) return;
      handlers.onOpen();
      emit([broker.snapshot(Date.now())]);
      timer = setTimeout(loop, interval);
    }, 50);
    const transport: Transport = {
      send(raw) {
        if (open) setTimeout(() => emit(broker.handle(raw, Date.now())), 20);
      },
      close() {
        if (!open) return;
        open = false;
        if (timer) clearTimeout(timer);
        handlers.onClose({ code: 1000, opened: true });
      },
    };
    return transport;
  };
}
