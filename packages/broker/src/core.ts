import { randomBytes, timingSafeEqual } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import {
  OWNER_KEY,
  PROTOCOL_VERSION,
  ShimToBrokerFrameSchema,
  UiToBrokerFrameSchema,
  WS_CLOSE,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  sanitizeSessionName,
  sanitizeText,
  sessionAddress,
  threadIdFor,
  toPeerInfo,
  utf8Bytes,
  addressKey,
  threadParticipants,
  MAX_NAME_LENGTH,
  MEDIA_SWEEP_INTERVAL_MS,
  OWNER_ADDRESS,
  type Address,
  type MediaRef,
  type BrokerToShimFrame,
  type BrokerToUiFrame,
  type ControlAction,
  type ControlState,
  type FrameOf,
  type Limits,
  type Message,
  type MessageKind,
  type PeerInfo,
  type PayloadOf,
  type RejectCode,
  type RepoRef,
  type SessionId,
  type SessionNode,
  type ShimToBrokerFrame,
  type UiToBrokerFrame,
} from '@orchvis/protocol';
import type { Clock, TimerHandle } from './clock.js';
import type { Logger } from './log.js';
import { indexEntry, type MediaStore, type MediaUploader, type StoredMedia } from './media.js';
import { RollingRateLimiter } from './rate-limit.js';
import { ThreadStore } from './threads.js';
import { BROKER_VERSION } from './version.js';

/** A transport connection, as the core sees it: text frames out, and close. */
export interface Conn {
  /**
   * Sends one text frame. Returns false, without throwing, when the
   * connection is closing or closed and the frame was not sent.
   */
  send(text: string): boolean;
  /** Closes the connection. */
  close(code: number, reason: string): void;
}

/** Callbacks a transport feeds into the core for one connection. */
export interface ConnHandler {
  /** One received text frame. */
  onFrame(raw: string): void;
  /** The connection closed, for any reason. */
  onClose(): void;
}

/** Sizes of the broker's in-memory structures, from {@link BrokerCore.stats}. */
export interface BrokerStats {
  /** Sessions in the registry, connected or not. */
  nodes: number;
  /** Sessions with an open shim connection. */
  connectedNodes: number;
  /** Session IDs aliased to a canonical one by `register`. */
  aliases: number;
  /**
   * Disconnected sessions past `offlineRetentionMs`: still in the registry
   * until `staleRetentionMs`, but sends to them get `recipient_gone`.
   */
  expiredQueues: number;
  /** Messages waiting in offline queues, across all sessions. */
  queuedMessages: number;
  /** Threads with a ring buffer. */
  threads: number;
  /** Messages held in ring buffers, across all threads. */
  bufferedMessages: number;
  /** Entries in the message-ID index; equals `bufferedMessages` when nothing leaks. */
  indexedMessages: number;
  /** Threads with edge statistics. */
  edges: number;
  /** Open `/ws/shim` connections, welcomed or not. */
  shimLinks: number;
  /** Open `/ws/ui` connections. */
  uiLinks: number;
  /** Upload keys of open shim connections. */
  uploadKeys: number;
  /** Keys tracked by the per-sender, per-thread send limiter. */
  sendLimiterKeys: number;
  /** Keys tracked by the upload limiter. */
  uploadLimiterKeys: number;
  /** Muted threads. */
  mutedThreads: number;
  /** Paused sessions. */
  pausedSessions: number;
  /** Files in the media store, attached or not. */
  mediaFiles: number;
  /** Bytes in the media store, attached or not. */
  mediaBytes: number;
}

type FrameMaker<U extends BrokerToShimFrame | BrokerToUiFrame> = <T extends U['type']>(type: T, payload: PayloadOf<U, T>) => FrameOf<U, T>;

interface ShimLink {
  conn: Conn;
  mk: FrameMaker<BrokerToShimFrame>;
  sessionId: SessionId | undefined;
  /** This connection's `welcome.uploadKey`; binds HTTP uploads to the session. */
  uploadKey: string | undefined;
  closed: boolean;
  helloTimer: TimerHandle | undefined;
}

interface UiLink {
  conn: Conn;
  mk: FrameMaker<BrokerToUiFrame>;
  /** The Owner login session this connection was opened with; logout closes it. */
  ownerSession: string | undefined;
}

interface NodeRecord {
  node: SessionNode;
  helloRepos: RepoRef[];
  extraRepos: RepoRef[];
  link: ShimLink | undefined;
  /** Messages routed while disconnected, oldest first. */
  queue: Message[];
  lastHeard: number;
  /** Fires `offlineRetentionMs` after disconnect: drops the queue and sets {@link NodeRecord.queueExpired}. */
  queueTimer: TimerHandle | undefined;
  /** Fires `staleRetentionMs` after `lastSeen`: purges the node and its threads. */
  purgeTimer: TimerHandle | undefined;
  /** Offline retention ran out: nothing is queued and sends get `recipient_gone`. Cleared on reconnect. */
  queueExpired: boolean;
}

type Target = { kind: 'owner' } | { kind: 'session'; rec: NodeRecord };

/**
 * Longest delay a Node timer honors (2^31 - 1 ms, about 24.8 days). A longer
 * delay fires at once, so the broker re-arms in steps of at most this.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

const GONE_DETAIL = 'that session has been disconnected past its offline retention; nothing is queued for it, but its history is still readable';

/** Whether `threadId` has the participant whose address key is `key`. Never throws on a malformed ID. */
function threadInvolves(threadId: string, key: string): boolean {
  const parts = threadId.split('|');
  return parts.length === 2 && (parts[0] === key || parts[1] === key);
}

class Rejection extends Error {
  constructor(
    readonly code: RejectCode,
    readonly detail: string,
  ) {
    super(detail);
  }
}

function unionRepos(...lists: RepoRef[][]): RepoRef[] {
  const out = new Map<string, RepoRef>();
  for (const list of lists) for (const r of list) out.set(r.key, r);
  return [...out.values()].slice(0, 32);
}

function sanitizeRepo(r: RepoRef): RepoRef {
  const out: RepoRef = { key: sanitizeText(r.key) || 'unknown', name: sanitizeText(r.name) || 'unknown' };
  if (r.branch !== undefined) out.branch = sanitizeText(r.branch);
  return out;
}

/**
 * The broker's state machine, independent of any transport: registry,
 * routing, ring buffers, offline queues, edge statistics, controls, heartbeat
 * and the web app feed. The server feeds it frames; tests may drive it
 * directly with fake {@link Conn}s.
 */
export class BrokerCore {
  private readonly nodes = new Map<SessionId, NodeRecord>();
  /** Session IDs from `hello` that `register` aliased, mapped to their canonical ID. */
  private readonly aliases = new Map<SessionId, SessionId>();
  private readonly threads: ThreadStore;
  private readonly limiter: RollingRateLimiter;
  private readonly uiLinks = new Set<UiLink>();
  private readonly shimLinks = new Set<ShimLink>();
  private readonly control = { mutedThreads: new Set<string>(), pausedSessions: new Set<SessionId>(), pausedAll: false };
  private readonly newId: (seedTime?: number) => string = monotonicFactory();
  private readonly heartbeat: TimerHandle;
  private readonly mediaSweep: TimerHandle;
  /** Upload keys of open, welcomed shim connections. */
  private readonly uploadKeys = new Map<string, ShimLink>();
  private readonly uploadLimiter: RollingRateLimiter;
  private uiCounter = 0;
  private shimCounter = 0;

  /**
   * @param limits - Limits in force; sent to shims and the web app.
   * @param shimToken - Token every `hello` must carry.
   * @param clock - Time source and timers.
   * @param logger - Structured logger. Never given bodies, captions, filenames or tokens.
   * @param media - The media store; the core expires, evicts and attaches its items.
   */
  constructor(
    readonly limits: Limits,
    private readonly shimToken: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
    readonly media: MediaStore,
  ) {
    this.threads = new ThreadStore(limits.ringBufferPerThread, limits.edgeTauMs);
    this.limiter = new RollingRateLimiter(limits.sendRatePerMinute);
    this.uploadLimiter = new RollingRateLimiter(limits.sendRatePerMinute);
    this.heartbeat = clock.setInterval(() => this.heartbeatTick(), limits.heartbeatIntervalMs);
    this.mediaSweep = clock.setInterval(() => this.sweepMedia(), MEDIA_SWEEP_INTERVAL_MS);
  }

  // ---------------------------------------------------------------- public

  /**
   * Sizes of every in-memory structure that grows with traffic, connections
   * or media, for soak and leak tests. Read-only; computing it is O(nodes +
   * threads).
   */
  stats(): BrokerStats {
    let queued = 0;
    let connected = 0;
    let expired = 0;
    for (const r of this.nodes.values()) {
      queued += r.queue.length;
      if (r.link) connected++;
      if (r.queueExpired) expired++;
    }
    const t = this.threads.sizes();
    return {
      nodes: this.nodes.size,
      connectedNodes: connected,
      aliases: this.aliases.size,
      expiredQueues: expired,
      queuedMessages: queued,
      threads: t.threads,
      bufferedMessages: t.buffered,
      indexedMessages: t.indexed,
      edges: t.edges,
      shimLinks: this.shimLinks.size,
      uiLinks: this.uiLinks.size,
      uploadKeys: this.uploadKeys.size,
      sendLimiterKeys: this.limiter.size,
      uploadLimiterKeys: this.uploadLimiter.size,
      mutedThreads: this.control.mutedThreads.size,
      pausedSessions: this.control.pausedSessions.size,
      mediaFiles: this.media.files,
      mediaBytes: this.media.bytes,
    };
  }

  /** Number of sessions in the registry, connected or not. */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /** Current control state. */
  controlState(): ControlState {
    return {
      mutedThreads: [...this.control.mutedThreads].sort(),
      pausedSessions: [...this.control.pausedSessions].sort(),
      pausedAll: this.control.pausedAll,
    };
  }

  /** Builds the `snapshot` payload for a new web app connection. */
  snapshot(): PayloadOf<BrokerToUiFrame, 'snapshot'> {
    return {
      brokerVersion: BROKER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      now: this.clock.now(),
      limits: { ...this.limits },
      nodes: [...this.nodes.values()].map((r) => ({ ...r.node })),
      edges: this.threads.allEdges(),
      messages: this.threads.allMessages().map((m) => ({ ...m })),
      media: this.media.index(),
      control: this.controlState(),
      mediaStore: this.media.usage(),
    };
  }

  // --------------------------------------------------------------- media

  /** The session behind an open shim connection's upload key, or undefined for an unknown or closed one. */
  sessionForUploadKey(key: string): SessionId | undefined {
    const link = this.uploadKeys.get(key);
    return link && !link.closed ? link.sessionId : undefined;
  }

  /**
   * Counts one upload against the uploader's per-minute allowance
   * (`sendRatePerMinute` uploads per session, and for the Owner). Returns
   * false, counting nothing, when the allowance is used up.
   */
  tryUpload(uploader: MediaUploader): boolean {
    const key = uploader.kind === 'owner' ? OWNER_KEY : `s\u0000${this.resolveId(uploader.id)}`;
    return this.uploadLimiter.tryAcquire(key, this.clock.now());
  }

  /** Adds a fully written upload to the store, then evicts the oldest files while the store is over its cap. */
  mediaStored(entry: StoredMedia): void {
    this.media.add(entry);
    this.logger.log('media_uploaded', {
      mediaId: entry.ref.mediaId,
      uploader: entry.uploader.kind === 'owner' ? OWNER_KEY : entry.uploader.id,
      bytes: entry.ref.bytes,
      mime: entry.ref.mime,
      storeBytes: this.media.bytes,
      storeFiles: this.media.files,
    });
    this.evictOverCap(entry.ref.mediaId);
  }

  /**
   * Whether a session may download a media item: only a participant in the
   * thread it was attached to. Unattached media is readable by the Owner only.
   */
  sessionMayRead(sessionId: SessionId, entry: StoredMedia): boolean {
    if (!entry.attachment) return false;
    const me = addressKey(sessionAddress(this.resolveId(sessionId)));
    return threadParticipants(entry.attachment.threadId).some((p) => addressKey(p) === me);
  }

  /** Expires every item whose TTL has run out, then evicts over the cap. Runs every {@link MEDIA_SWEEP_INTERVAL_MS}. */
  sweepMedia(): void {
    for (const e of this.media.expiredAt(this.clock.now())) this.dropMedia(e, 'ttl');
    this.evictOverCap(undefined);
  }

  private evictOverCap(keep: string | undefined): void {
    for (const e of this.media.evictionVictims(keep)) this.dropMedia(e, 'evicted');
  }

  /** Removes an item and its file; for attached items, decrements the edge and tells the web app. */
  private dropMedia(entry: StoredMedia, reason: 'ttl' | 'evicted'): void {
    if (!this.media.remove(entry.ref.mediaId)) return;
    this.logger.log(reason === 'ttl' ? 'media_expired' : 'media_evicted', {
      mediaId: entry.ref.mediaId,
      bytes: entry.ref.bytes,
      attached: entry.attachment !== undefined,
      storeBytes: this.media.bytes,
      storeFiles: this.media.files,
    });
    const at = entry.attachment;
    if (!at) return;
    const edge = this.threads.adjustMedia(at.threadId, entry.kind, -1);
    if (!edge) return;
    this.broadcastUi('media', { op: 'expire', mediaId: entry.ref.mediaId, threadId: at.threadId, edge, mediaStore: this.media.usage() });
  }

  /**
   * Checks a send's attachment IDs without changing anything: each must
   * exist, be unexpired, have been uploaded by `uploader`, and not be
   * attached yet, and none may repeat. Throws `invalid` otherwise.
   */
  private checkAttachments(uploader: MediaUploader, ids: string[]): StoredMedia[] {
    const now = this.clock.now();
    const seen = new Set<string>();
    const out: StoredMedia[] = [];
    for (const id of ids) {
      const e = this.media.get(id);
      const mine =
        e !== undefined &&
        (uploader.kind === 'owner'
          ? e.uploader.kind === 'owner'
          : e.uploader.kind === 'session' && this.resolveId(e.uploader.id) === this.resolveId(uploader.id));
      if (!e || !mine || seen.has(id) || e.attachment || e.ref.expiresAt <= now) {
        throw new Rejection('invalid', 'unknown, expired, foreign or already attached media id');
      }
      seen.add(id);
      out.push(e);
    }
    return out;
  }

  /** Marks checked attachments as used by `message`, and announces each after the `message` delta. */
  private commitAttachments(message: Message, items: StoredMedia[]): void {
    for (const e of items) {
      e.attachment = { threadId: message.threadId, messageId: message.id, from: { ...message.from }, ts: message.ts };
      const edge = this.threads.adjustMedia(message.threadId, e.kind, 1);
      const entry = indexEntry(e);
      if (!edge || !entry) continue;
      this.logger.log('media_attached', { mediaId: e.ref.mediaId, messageId: message.id, threadId: message.threadId });
      this.broadcastUi('media', { op: 'add', entry, edge, mediaStore: this.media.usage() });
    }
  }

  /** Accepts a new `/ws/shim` connection. The first frame must be `hello`. */
  openShim(conn: Conn): ConnHandler {
    const link: ShimLink = {
      conn,
      mk: createFrameFactory<BrokerToShimFrame>(`b${++this.shimCounter}-`, () => this.clock.now()),
      sessionId: undefined,
      uploadKey: undefined,
      closed: false,
      helloTimer: undefined,
    };
    this.shimLinks.add(link);
    link.helloTimer = this.clock.setTimeout(() => {
      if (!link.sessionId && !link.closed) {
        this.logger.log('shim_hello_timeout');
        this.closeLink(link, WS_CLOSE.helloRejected, 'no hello');
      }
    }, this.limits.disconnectAfterMs);
    return {
      onFrame: (raw) => this.onShimFrame(link, raw),
      onClose: () => this.onShimClose(link),
    };
  }

  /**
   * Accepts a new, already authorized `/ws/ui` connection and sends it the
   * snapshot. Media past its TTL is swept first, so existing connections get
   * its `expire` and the snapshot never lists it.
   *
   * @param ownerSession - The Owner login session behind the connection; {@link BrokerCore.endOwnerSession} closes it.
   */
  openUi(conn: Conn, ownerSession?: string): ConnHandler {
    this.sweepMedia();
    const link: UiLink = {
      conn,
      mk: createFrameFactory<BrokerToUiFrame>(`u${++this.uiCounter}-`, () => this.clock.now()),
      ownerSession,
    };
    this.uiLinks.add(link);
    this.logger.log('ui_connected', { uiClients: this.uiLinks.size });
    this.sendUi(link, 'snapshot', this.snapshot());
    return {
      onFrame: (raw) => this.onUiFrame(link, raw),
      onClose: () => {
        if (this.uiLinks.delete(link)) this.logger.log('ui_disconnected', { uiClients: this.uiLinks.size });
      },
    };
  }

  /** Closes every `/ws/ui` connection opened with this Owner login session, with `WS_CLOSE.unauthorized`. */
  endOwnerSession(ownerSession: string): void {
    for (const link of [...this.uiLinks]) {
      if (link.ownerSession !== ownerSession) continue;
      this.uiLinks.delete(link);
      link.conn.close(WS_CLOSE.unauthorized, 'logged out');
    }
  }

  /** Stops timers and closes every connection. */
  dispose(): void {
    this.clock.clearInterval(this.heartbeat);
    this.clock.clearInterval(this.mediaSweep);
    for (const rec of this.nodes.values()) this.cancelRetention(rec);
    for (const link of [...this.shimLinks]) this.closeLink(link, WS_CLOSE.shuttingDown, 'broker shutting down');
    for (const link of [...this.uiLinks]) link.conn.close(WS_CLOSE.shuttingDown, 'broker shutting down');
    this.uiLinks.clear();
  }

  // ------------------------------------------------------------ shim side

  private onShimFrame(link: ShimLink, raw: string): void {
    if (link.closed) return;
    const decoded = decodeFrame(ShimToBrokerFrameSchema, raw);
    if (!link.sessionId) {
      if (!decoded.ok) {
        this.rejectShim(link, decoded.id, 'invalid', decoded.error, 'unknown');
        this.closeLink(link, WS_CLOSE.helloRejected, 'invalid hello');
        return;
      }
      if (decoded.frame.type !== 'hello') {
        this.rejectShim(link, decoded.frame.id, 'invalid', 'the first frame must be hello', decoded.frame.type);
        this.closeLink(link, WS_CLOSE.helloRejected, 'invalid hello');
        return;
      }
      this.onHello(link, decoded.frame);
      return;
    }
    const rec = this.nodes.get(link.sessionId);
    if (!rec || rec.link !== link) return;
    rec.lastHeard = this.clock.now();
    if (!decoded.ok) {
      this.rejectShim(link, decoded.id, 'invalid', decoded.error, 'unknown');
      return;
    }
    const frame = decoded.frame;
    try {
      switch (frame.type) {
        case 'hello':
          throw new Rejection('invalid', 'hello was already received on this connection');
        case 'register':
          this.onRegister(link, rec, frame);
          break;
        case 'send':
          this.onSend(link, rec, frame);
          break;
        case 'seen':
          this.onSeen(rec, frame.payload.ids);
          break;
        case 'status':
          this.onStatus(rec, frame.payload);
          break;
        case 'thread_request':
          this.onThreadRequest(link, rec, frame);
          break;
        case 'ping':
          this.sendShim(link, 'pong', { re: frame.id });
          break;
        case 'pong':
          break;
      }
    } catch (err) {
      if (err instanceof Rejection) this.rejectShim(link, frame.id, err.code, err.detail, frame.type);
      else throw err;
    }
  }

  private onHello(link: ShimLink, frame: FrameOf<ShimToBrokerFrame, 'hello'>): void {
    const p = frame.payload;
    if (!timingSafeEqualStr(p.token, this.shimToken)) {
      this.rejectShim(link, frame.id, 'unauthorized', 'shim token not accepted', 'hello');
      this.closeLink(link, WS_CLOSE.helloRejected, 'unauthorized');
      return;
    }
    if (p.protocolVersion !== PROTOCOL_VERSION) {
      this.rejectShim(link, frame.id, 'invalid', `protocol version ${p.protocolVersion} not supported`, 'hello');
      this.closeLink(link, WS_CLOSE.helloRejected, 'protocol version');
      return;
    }
    if (link.helloTimer) this.clock.clearTimeout(link.helloTimer);
    const now = this.clock.now();
    const id = this.resolveId(p.sessionId);
    const helloRepos = p.repos.map(sanitizeRepo);
    const hostname = sanitizeText(p.hostname) || 'unknown';
    let rec = this.nodes.get(id);
    const known = rec !== undefined;
    if (rec) {
      if (rec.link && rec.link !== link) {
        const old = rec.link;
        rec.link = undefined;
        this.closeLink(old, WS_CLOSE.replaced, 'replaced by a newer connection');
      }
      this.cancelRetention(rec);
      rec.helloRepos = helloRepos;
      rec.node.cwd = sanitizeText(p.cwd);
      rec.node.platform = p.platform;
      rec.node.hostname = hostname;
      rec.node.repos = unionRepos(helloRepos, rec.extraRepos);
    } else {
      this.aliases.delete(id);
      const name = this.uniqueName(sanitizeSessionName(p.defaultName), undefined);
      rec = {
        node: {
          id,
          hostname,
          platform: p.platform,
          name,
          focus: '',
          repos: helloRepos,
          cwd: sanitizeText(p.cwd),
          status: 'idle',
          delivery: 'poll',
          connected: true,
          lastSeen: now,
        },
        helloRepos,
        extraRepos: [],
        link,
        queue: [],
        lastHeard: now,
        queueTimer: undefined,
        purgeTimer: undefined,
        queueExpired: false,
      };
      this.nodes.set(id, rec);
    }
    rec.link = link;
    rec.lastHeard = now;
    rec.node.connected = true;
    rec.node.lastSeen = now;
    link.sessionId = id;
    const uploadKey = randomBytes(24).toString('base64url');
    link.uploadKey = uploadKey;
    this.uploadKeys.set(uploadKey, link);
    this.logger.log('shim_connected', { sessionId: id, name: rec.node.name, reconnect: known, aliasOf: id !== p.sessionId ? p.sessionId : undefined });
    this.sendShim(link, 'welcome', {
      re: frame.id,
      sessionId: id,
      name: rec.node.name,
      uploadKey,
      limits: { ...this.limits },
      peers: this.peersFor(id),
      brokerVersion: BROKER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    });
    if (known) this.redeliver(rec);
    this.nodeChanged(rec);
  }

  private onRegister(link: ShimLink, rec: NodeRecord, frame: FrameOf<ShimToBrokerFrame, 'register'>): void {
    const p = frame.payload;
    const lower = p.name.toLowerCase();
    const focus = sanitizeText(p.focus);
    const repos = p.repos.map(sanitizeRepo);
    const now = this.clock.now();
    const target = [...this.nodes.values()].find(
      (r) =>
        r !== rec &&
        !r.link &&
        !r.node.connected &&
        r.node.name.toLowerCase() === lower &&
        r.node.hostname.toLowerCase() === rec.node.hostname.toLowerCase(),
    );
    if (target) {
      // Alias: the old, disconnected ID X stays canonical; this connection's ID Y becomes an alias of X.
      const x = target.node.id;
      const y = rec.node.id;
      this.cancelRetention(target);
      // Y's node is removed below, and a node remove is a purge: Y's threads go with it (normally there are none yet).
      const purged = this.purgeThreads(y);
      this.nodes.delete(y);
      this.aliases.set(y, x);
      for (const [k, v] of this.aliases) if (v === y) this.aliases.set(k, x);
      const pauseMoved = this.control.pausedSessions.delete(y);
      if (pauseMoved) this.control.pausedSessions.add(x);
      target.link = link;
      link.sessionId = x;
      target.lastHeard = now;
      target.helloRepos = rec.helloRepos;
      target.extraRepos = unionRepos(target.extraRepos, repos);
      target.node = {
        ...target.node,
        hostname: rec.node.hostname,
        platform: rec.node.platform,
        cwd: rec.node.cwd,
        name: p.name,
        focus,
        repos: unionRepos(rec.helloRepos, target.extraRepos),
        status: rec.node.status,
        delivery: rec.node.delivery,
        connected: true,
        lastSeen: now,
      };
      this.logger.log('session_aliased', { alias: y, canonical: x, name: p.name });
      this.sendShim(link, 'registered', { re: frame.id, sessionId: x, name: target.node.name, peers: this.peersFor(x) });
      this.redeliver(target);
      this.broadcastUi('node', { op: 'remove', id: y });
      if (pauseMoved || purged.controlsChanged) this.broadcastControl();
      this.nodeChanged(target);
      return;
    }
    const name = this.uniqueName(p.name, rec);
    rec.extraRepos = unionRepos(rec.extraRepos, repos);
    rec.node.name = name;
    rec.node.focus = focus;
    rec.node.repos = unionRepos(rec.helloRepos, rec.extraRepos);
    rec.node.lastSeen = now;
    this.logger.log('session_registered', { sessionId: rec.node.id, name });
    this.sendShim(link, 'registered', { re: frame.id, sessionId: rec.node.id, name, peers: this.peersFor(rec.node.id) });
    this.nodeChanged(rec);
  }

  private onSend(link: ShimLink, rec: NodeRecord, frame: FrameOf<ShimToBrokerFrame, 'send'>): void {
    const p = frame.payload;
    this.checkBody(p.body);
    const media = this.checkAttachments({ kind: 'session', id: rec.node.id }, p.attachments);
    const target = this.resolveTarget(p.to);
    const to = this.targetAddress(target, p.to);
    const from = sessionAddress(rec.node.id);
    if (to.kind === 'session' && to.id === rec.node.id) throw new Rejection('invalid', 'cannot send a message to yourself');
    const threadId = threadIdFor(from, to);
    // Controls never block a message to or from the Owner: a paused session can still reply to the Owner.
    if (to.kind !== 'owner') {
      if (this.control.pausedAll) throw new Rejection('paused', 'all peer traffic is paused');
      if (this.control.pausedSessions.has(rec.node.id)) throw new Rejection('paused', 'this session is paused');
      if (this.control.mutedThreads.has(threadId)) throw new Rejection('muted', 'this thread is muted');
    }
    const now = this.clock.now();
    if (!this.limiter.tryAcquire(`${rec.node.id}\u0000${threadId}`, now)) {
      throw new Rejection('rate_limited', `over ${this.limits.sendRatePerMinute} messages per minute on this thread`);
    }
    const message = this.buildMessage(from, rec.node.name, to, 'peer', p.kind, p.body, p.replyTo, threadId, now, media);
    this.route(message);
    this.commitAttachments(message, media);
    this.sendShim(link, 'sent', { re: frame.id, messageId: message.id, threadId, ts: message.ts });
  }

  private onSeen(rec: NodeRecord, ids: string[]): void {
    const now = this.clock.now();
    const accepted: string[] = [];
    for (const id of ids) {
      const m = this.threads.get(id);
      if (m && m.to.kind === 'session' && m.to.id === rec.node.id && m.seenAt === undefined) {
        m.seenAt = now;
        accepted.push(id);
      }
    }
    rec.queue = rec.queue.filter((m) => m.seenAt === undefined);
    if (accepted.length) this.broadcastUi('seen', { by: rec.node.id, ids: accepted, seenAt: now });
  }

  private onStatus(rec: NodeRecord, p: PayloadOf<ShimToBrokerFrame, 'status'>): void {
    if (p.status !== undefined) rec.node.status = p.status;
    if (p.focus !== undefined) rec.node.focus = sanitizeText(p.focus);
    if (p.delivery !== undefined) rec.node.delivery = p.delivery;
    rec.node.lastSeen = this.clock.now();
    this.nodeChanged(rec);
  }

  private onThreadRequest(link: ShimLink, rec: NodeRecord, frame: FrameOf<ShimToBrokerFrame, 'thread_request'>): void {
    const target = this.resolveTarget(frame.payload.peer);
    let peer: Address;
    // A session past its offline retention still has readable history, until it is purged.
    if (!target) throw new Rejection('unknown_recipient', 'no session with that name or ID');
    else if (target.kind === 'owner') peer = OWNER_ADDRESS;
    else peer = sessionAddress(target.rec.node.id);
    if (peer.kind === 'session' && peer.id === rec.node.id) throw new Rejection('invalid', 'there is no thread with yourself');
    const threadId = threadIdFor(sessionAddress(rec.node.id), peer);
    this.sendShim(link, 'thread', { re: frame.id, threadId, messages: this.threads.history(threadId, frame.payload.limit) });
  }

  private onShimClose(link: ShimLink): void {
    if (link.closed) return;
    link.closed = true;
    this.shimLinks.delete(link);
    if (link.uploadKey) this.uploadKeys.delete(link.uploadKey);
    if (link.helloTimer) this.clock.clearTimeout(link.helloTimer);
    if (!link.sessionId) return;
    const rec = this.nodes.get(link.sessionId);
    if (rec && rec.link === link) this.markDisconnected(rec, 'socket closed');
  }

  // -------------------------------------------------------------- UI side

  private onUiFrame(link: UiLink, raw: string): void {
    const decoded = decodeFrame(UiToBrokerFrameSchema, raw);
    if (!decoded.ok) {
      this.rejectUi(link, decoded.id, 'invalid', decoded.error, 'unknown');
      return;
    }
    const frame = decoded.frame;
    try {
      switch (frame.type) {
        case 'owner_send':
          this.onOwnerSend(link, frame);
          break;
        case 'control':
          this.applyControl(frame.payload);
          break;
        case 'ping':
          this.sendUi(link, 'pong', { re: frame.id });
          break;
        case 'pong':
          break;
      }
    } catch (err) {
      if (err instanceof Rejection) this.rejectUi(link, frame.id, err.code, err.detail, frame.type);
      else throw err;
    }
  }

  private onOwnerSend(link: UiLink, frame: FrameOf<UiToBrokerFrame, 'owner_send'>): void {
    const p = frame.payload;
    this.checkBody(p.body);
    const media = this.checkAttachments({ kind: 'owner' }, p.attachments);
    const id = this.resolveId(p.to);
    const rec = this.nodes.get(id);
    if (!rec) throw new Rejection('unknown_recipient', 'no session with that ID');
    if (rec.queueExpired) throw new Rejection('recipient_gone', GONE_DETAIL);
    const to = sessionAddress(rec.node.id);
    const threadId = threadIdFor(OWNER_ADDRESS, to);
    const now = this.clock.now();
    const message = this.buildMessage(OWNER_ADDRESS, OWNER_KEY, to, 'owner', p.kind, p.body, p.replyTo, threadId, now, media);
    this.route(message);
    this.commitAttachments(message, media);
    this.sendUi(link, 'sent', { re: frame.id, messageId: message.id, threadId, ts: message.ts });
  }

  private applyControl(action: ControlAction): void {
    switch (action.action) {
      case 'mute_thread':
        this.control.mutedThreads.add(action.threadId);
        break;
      case 'unmute_thread':
        this.control.mutedThreads.delete(action.threadId);
        break;
      case 'pause_session':
        this.control.pausedSessions.add(this.resolveId(action.sessionId));
        break;
      case 'resume_session':
        this.control.pausedSessions.delete(this.resolveId(action.sessionId));
        break;
      case 'pause_all':
        this.control.pausedAll = true;
        break;
      case 'resume_all':
        this.control.pausedAll = false;
        break;
    }
    this.logger.log('control', { action: action.action });
    this.broadcastControl();
  }

  // -------------------------------------------------------------- routing

  private checkBody(body: string): void {
    if (utf8Bytes(body) > this.limits.maxBodyBytes) {
      throw new Rejection('too_large', `body is over ${this.limits.maxBodyBytes} bytes`);
    }
  }

  private resolveId(id: SessionId): SessionId {
    let current = id;
    for (let i = 0; i < 16; i++) {
      const next = this.aliases.get(current);
      if (next === undefined) break;
      current = next;
    }
    return current;
  }

  /**
   * Resolves `to`: a registered name, then a session ID (through aliases),
   * then `owner`. Registered sessions include disconnected ones until they
   * are purged; a purged session resolves to nothing.
   */
  private resolveTarget(to: string): Target | undefined {
    const lower = to.toLowerCase();
    for (const rec of this.nodes.values()) if (rec.node.name.toLowerCase() === lower) return { kind: 'session', rec };
    const rec = this.nodes.get(this.resolveId(to));
    if (rec) return { kind: 'session', rec };
    if (lower === OWNER_KEY) return { kind: 'owner' };
    return undefined;
  }

  /** The address to send to, or a rejection: unknown (or purged) recipient, or one past its offline retention. */
  private targetAddress(target: Target | undefined, raw: string): Address {
    if (!target) throw new Rejection('unknown_recipient', `no session with that name or ID (${raw.length} chars)`);
    if (target.kind === 'owner') return OWNER_ADDRESS;
    if (target.rec.queueExpired) throw new Rejection('recipient_gone', GONE_DETAIL);
    return sessionAddress(target.rec.node.id);
  }

  private buildMessage(
    from: Address,
    fromName: string,
    to: Address,
    senderKind: Message['senderKind'],
    kind: MessageKind,
    body: string,
    replyTo: string | undefined,
    threadId: string,
    now: number,
    media: StoredMedia[],
  ): Message {
    const attachments: MediaRef[] = media.map((e) => ({ ...e.ref }));
    const message: Message = {
      id: this.newId(now),
      threadId,
      from,
      fromName,
      to,
      senderKind,
      kind,
      body: sanitizeText(body),
      attachments,
      ts: now,
    };
    if (replyTo !== undefined) message.replyTo = replyTo;
    return message;
  }

  private route(message: Message): void {
    const { edge, evicted } = this.threads.append(message);
    if (evicted.length) this.logger.log('ring_evicted', { threadId: message.threadId, count: evicted.length });
    if (message.to.kind === 'session') {
      const rec = this.nodes.get(message.to.id);
      // A socket that is closing drops the frame; queue it so it is not lost to ring eviction.
      if (rec && !(rec.link && this.sendShim(rec.link, 'deliver', { message }))) rec.queue.push(message);
    }
    this.broadcastUi('message', { message, edge });
  }

  /** Sends a reconnected session its queued messages plus every buffered unseen message to it, oldest first. */
  private redeliver(rec: NodeRecord): void {
    if (!rec.link) return;
    const pending = new Map<string, Message>();
    for (const m of rec.queue) if (m.seenAt === undefined) pending.set(m.id, m);
    for (const m of this.threads.allMessages()) {
      if (m.to.kind === 'session' && m.to.id === rec.node.id && m.seenAt === undefined) pending.set(m.id, m);
    }
    rec.queue = [];
    const ordered = [...pending.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const message of ordered) this.sendShim(rec.link, 'deliver', { message });
    if (ordered.length) this.logger.log('redelivered', { sessionId: rec.node.id, count: ordered.length });
  }

  // ----------------------------------------------------- registry helpers

  private uniqueName(base: string, self: NodeRecord | undefined): string {
    const taken = (name: string) => {
      const lower = name.toLowerCase();
      for (const r of this.nodes.values()) if (r !== self && r.node.name.toLowerCase() === lower) return true;
      return false;
    };
    if (!taken(base)) return base;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const candidate = `${base.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
      if (!taken(candidate)) return candidate;
    }
  }

  private peersFor(id: SessionId): PeerInfo[] {
    const out: PeerInfo[] = [];
    for (const r of this.nodes.values()) if (r.node.id !== id) out.push(toPeerInfo({ ...r.node }));
    return out;
  }

  private nodeChanged(rec: NodeRecord): void {
    this.broadcastUi('node', { op: 'upsert', node: { ...rec.node } });
    this.broadcastPeers();
  }

  private broadcastPeers(): void {
    for (const r of this.nodes.values()) if (r.link) this.sendShim(r.link, 'peers', { peers: this.peersFor(r.node.id) });
  }

  private broadcastControl(): void {
    this.broadcastUi('control_state', this.controlState());
  }

  private markDisconnected(rec: NodeRecord, reason: string): void {
    rec.link = undefined;
    rec.node.connected = false;
    rec.node.lastSeen = rec.lastHeard;
    this.logger.log('shim_disconnected', { sessionId: rec.node.id, reason });
    this.cancelRetention(rec);
    const now = this.clock.now();
    this.armTimer(rec, 'queueTimer', now + this.limits.offlineRetentionMs, () => this.expireQueue(rec));
    this.armTimer(rec, 'purgeTimer', rec.node.lastSeen + this.limits.staleRetentionMs, () => this.purgeNode(rec));
    this.nodeChanged(rec);
  }

  /**
   * Runs `fn` once the clock reaches `deadline`, holding the timer in
   * `rec[slot]`. Delays over {@link MAX_TIMER_DELAY_MS} are covered in steps,
   * so a huge configured retention never overflows into firing at once.
   */
  private armTimer(rec: NodeRecord, slot: 'queueTimer' | 'purgeTimer', deadline: number, fn: () => void): void {
    const remaining = Math.max(0, deadline - this.clock.now());
    if (remaining > MAX_TIMER_DELAY_MS) {
      rec[slot] = this.clock.setTimeout(() => this.armTimer(rec, slot, deadline, fn), MAX_TIMER_DELAY_MS);
    } else {
      rec[slot] = this.clock.setTimeout(() => {
        rec[slot] = undefined;
        fn();
      }, remaining);
    }
  }

  /** Cancels both retention timers and restores normal delivery. Called on reconnect, aliasing and disposal. */
  private cancelRetention(rec: NodeRecord): void {
    if (rec.queueTimer) this.clock.clearTimeout(rec.queueTimer);
    if (rec.purgeTimer) this.clock.clearTimeout(rec.purgeTimer);
    rec.queueTimer = undefined;
    rec.purgeTimer = undefined;
    rec.queueExpired = false;
  }

  /**
   * Offline retention ran out: drops the queue and rejects further sends with
   * `recipient_gone`. The node stays in the registry, the graph and `peers`,
   * and its history stays readable, until {@link BrokerCore.purgeNode}.
   */
  private expireQueue(rec: NodeRecord): void {
    if (this.nodes.get(rec.node.id) !== rec || rec.link) return;
    this.logger.log('queue_expired', { sessionId: rec.node.id, droppedQueued: rec.queue.length });
    rec.queue = [];
    rec.queueExpired = true;
  }

  /**
   * Stale retention ran out: forgets the node and everything keyed by it.
   *
   * Announced as, in order: a `media` expire for each attached item on its
   * threads (which carries the store usage), the `node` remove (which drops
   * the threads, messages and edges on the client), a `control_state` if a
   * control named the node or one of its threads, then `peers` to shims.
   */
  private purgeNode(rec: NodeRecord): void {
    const id = rec.node.id;
    if (this.nodes.get(id) !== rec || rec.link) return;
    this.cancelRetention(rec);
    const purged = this.purgeThreads(id);
    this.nodes.delete(id);
    const owns = (uploaderId: SessionId) => this.resolveId(uploaderId) === id;
    let uploads = 0;
    for (const e of this.media.all()) {
      if (!e.attachment && e.uploader.kind === 'session' && owns(e.uploader.id) && this.media.remove(e.ref.mediaId)) uploads++;
    }
    for (const [alias, canonical] of [...this.aliases]) if (alias === id || canonical === id) this.aliases.delete(alias);
    this.uploadLimiter.deleteWhere((key) => key === `s\u0000${id}`);
    const unpaused = this.control.pausedSessions.delete(id);
    this.logger.log('node_purged', {
      sessionId: id,
      threads: purged.threads,
      messages: purged.messages,
      media: purged.media,
      uploads,
      droppedQueued: rec.queue.length,
    });
    rec.queue = [];
    this.broadcastUi('node', { op: 'remove', id });
    if (unpaused || purged.controlsChanged) this.broadcastControl();
    this.broadcastPeers();
  }

  /**
   * Deletes every thread `id` took part in: attached media (files, index
   * entries, each announced as a `media` expire), ring buffers and their
   * messages (with their seen state), edges, send-limiter entries, queued
   * copies in other sessions' offline queues, and mutes. Broadcasts only the
   * media expires; the caller announces the rest with the `node` remove.
   */
  private purgeThreads(id: SessionId): { threads: number; messages: number; media: number; controlsChanged: boolean } {
    const key = addressKey(sessionAddress(id));
    const doomed = new Set(this.threads.threadIds().filter((t) => threadInvolves(t, key)));
    let media = 0;
    for (const e of this.media.all()) {
      const at = e.attachment;
      if (!at || !doomed.has(at.threadId) || !this.media.remove(e.ref.mediaId)) continue;
      media++;
      const edge = this.threads.adjustMedia(at.threadId, e.kind, -1);
      if (edge) this.broadcastUi('media', { op: 'expire', mediaId: e.ref.mediaId, threadId: at.threadId, edge, mediaStore: this.media.usage() });
    }
    let messages = 0;
    for (const t of doomed) messages += this.threads.deleteThread(t).length;
    this.limiter.deleteWhere((k) => doomed.has(k.slice(k.indexOf('\u0000') + 1)));
    for (const r of this.nodes.values()) if (r.queue.length) r.queue = r.queue.filter((m) => !doomed.has(m.threadId));
    let controlsChanged = false;
    for (const t of [...this.control.mutedThreads]) {
      if (threadInvolves(t, key)) controlsChanged = this.control.mutedThreads.delete(t) || controlsChanged;
    }
    return { threads: doomed.size, messages, media, controlsChanged };
  }

  private heartbeatTick(): void {
    const now = this.clock.now();
    this.limiter.sweep(now);
    this.uploadLimiter.sweep(now);
    for (const rec of [...this.nodes.values()]) {
      const link = rec.link;
      if (!link) continue;
      if (now - rec.lastHeard >= this.limits.disconnectAfterMs) {
        this.logger.log('heartbeat_timeout', { sessionId: rec.node.id, silentMs: now - rec.lastHeard });
        this.markDisconnected(rec, 'heartbeat timeout');
        this.closeLink(link, WS_CLOSE.heartbeatTimeout, 'heartbeat timeout');
      } else {
        this.sendShim(link, 'ping', {});
      }
    }
  }

  // ------------------------------------------------------------ transport

  private closeLink(link: ShimLink, code: number, reason: string): void {
    if (link.closed) return;
    link.closed = true;
    this.shimLinks.delete(link);
    if (link.uploadKey) this.uploadKeys.delete(link.uploadKey);
    if (link.helloTimer) this.clock.clearTimeout(link.helloTimer);
    link.conn.close(code, reason);
  }

  private sendShim<T extends BrokerToShimFrame['type']>(link: ShimLink, type: T, payload: PayloadOf<BrokerToShimFrame, T>): boolean {
    if (link.closed) return false;
    return link.conn.send(encodeFrame(link.mk(type, payload)));
  }

  private sendUi<T extends BrokerToUiFrame['type']>(link: UiLink, type: T, payload: PayloadOf<BrokerToUiFrame, T>): void {
    link.conn.send(encodeFrame(link.mk(type, payload)));
  }

  private broadcastUi<T extends BrokerToUiFrame['type']>(type: T, payload: PayloadOf<BrokerToUiFrame, T>): void {
    for (const link of this.uiLinks) this.sendUi<T>(link, type, payload as never);
  }

  private rejectShim(link: ShimLink, re: string, code: RejectCode, detail: string, frameType: string): void {
    this.logger.log('rejected', { endpoint: 'shim', sessionId: link.sessionId, frame: frameType, code, detail });
    this.sendShim(link, 'rejected', { re: re.slice(0, 64), code, detail: detail.slice(0, 1024) });
  }

  private rejectUi(link: UiLink, re: string, code: RejectCode, detail: string, frameType: string): void {
    this.logger.log('rejected', { endpoint: 'ui', frame: frameType, code, detail });
    this.sendUi(link, 'rejected', { re: re.slice(0, 64), code, detail: detail.slice(0, 1024) });
  }
}

/** Constant-time comparison of two secrets. Different lengths compare unequal. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
