import { timingSafeEqual } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import {
  OWNER_KEY,
  PROTOCOL_VERSION,
  ShimToBrokerFrameSchema,
  UiToBrokerFrameSchema,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  sanitizeSessionName,
  sanitizeText,
  sessionAddress,
  threadIdFor,
  toPeerInfo,
  utf8Bytes,
  MAX_NAME_LENGTH,
  OWNER_ADDRESS,
  type Address,
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
import { RollingRateLimiter } from './rate-limit.js';
import { ThreadStore } from './threads.js';
import { BROKER_VERSION } from './version.js';

/** WebSocket close codes the broker uses. */
export const CloseCodes = Object.freeze({
  /** First frame was not a valid hello. */
  invalidHello: 4400,
  /** Wrong shim token. */
  unauthorized: 4401,
  /** A newer connection took over this session. */
  replaced: 4409,
  /** No traffic within `disconnectAfterMs`. */
  timeout: 4408,
  /** Broker shutting down. */
  shutdown: 1001,
});

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

type FrameMaker<U extends BrokerToShimFrame | BrokerToUiFrame> = <T extends U['type']>(type: T, payload: PayloadOf<U, T>) => FrameOf<U, T>;

interface ShimLink {
  conn: Conn;
  mk: FrameMaker<BrokerToShimFrame>;
  sessionId: SessionId | undefined;
  closed: boolean;
  helloTimer: TimerHandle | undefined;
}

interface UiLink {
  conn: Conn;
  mk: FrameMaker<BrokerToUiFrame>;
}

interface NodeRecord {
  node: SessionNode;
  helloRepos: RepoRef[];
  extraRepos: RepoRef[];
  link: ShimLink | undefined;
  /** Messages routed while disconnected, oldest first. */
  queue: Message[];
  lastHeard: number;
  removeTimer: TimerHandle | undefined;
}

type Target = { kind: 'owner' } | { kind: 'session'; rec: NodeRecord } | { kind: 'gone'; id: SessionId };

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
  /** Removed session IDs, for `recipient_gone`. */
  private readonly goneIds = new Set<SessionId>();
  /** Lowercased names of removed sessions, mapped to their ID. */
  private readonly goneNames = new Map<string, SessionId>();
  private readonly threads: ThreadStore;
  private readonly limiter: RollingRateLimiter;
  private readonly uiLinks = new Set<UiLink>();
  private readonly shimLinks = new Set<ShimLink>();
  private readonly control = { mutedThreads: new Set<string>(), pausedSessions: new Set<SessionId>(), pausedAll: false };
  private readonly newId: (seedTime?: number) => string = monotonicFactory();
  private readonly heartbeat: TimerHandle;
  private uiCounter = 0;
  private shimCounter = 0;

  /**
   * @param limits - Limits in force; sent to shims and the web app.
   * @param shimToken - Token every `hello` must carry.
   * @param clock - Time source and timers.
   * @param logger - Structured logger. Never given bodies or tokens.
   */
  constructor(
    readonly limits: Limits,
    private readonly shimToken: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.threads = new ThreadStore(limits.ringBufferPerThread, limits.edgeTauMs);
    this.limiter = new RollingRateLimiter(limits.sendRatePerMinute);
    this.heartbeat = clock.setInterval(() => this.heartbeatTick(), limits.heartbeatIntervalMs);
  }

  // ---------------------------------------------------------------- public

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
      media: [],
      control: this.controlState(),
      mediaStore: { bytes: 0, capBytes: this.limits.mediaStoreBytes, files: 0 },
    };
  }

  /** Accepts a new `/ws/shim` connection. The first frame must be `hello`. */
  openShim(conn: Conn): ConnHandler {
    const link: ShimLink = {
      conn,
      mk: createFrameFactory<BrokerToShimFrame>(`b${++this.shimCounter}-`, () => this.clock.now()),
      sessionId: undefined,
      closed: false,
      helloTimer: undefined,
    };
    this.shimLinks.add(link);
    link.helloTimer = this.clock.setTimeout(() => {
      if (!link.sessionId && !link.closed) {
        this.logger.log('shim_hello_timeout');
        this.closeLink(link, CloseCodes.invalidHello, 'no hello');
      }
    }, this.limits.disconnectAfterMs);
    return {
      onFrame: (raw) => this.onShimFrame(link, raw),
      onClose: () => this.onShimClose(link),
    };
  }

  /** Accepts a new, already authorized `/ws/ui` connection and sends it the snapshot. */
  openUi(conn: Conn): ConnHandler {
    const link: UiLink = { conn, mk: createFrameFactory<BrokerToUiFrame>(`u${++this.uiCounter}-`, () => this.clock.now()) };
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

  /** Stops timers and closes every connection. */
  dispose(): void {
    this.clock.clearInterval(this.heartbeat);
    for (const rec of this.nodes.values()) if (rec.removeTimer) this.clock.clearTimeout(rec.removeTimer);
    for (const link of [...this.shimLinks]) this.closeLink(link, CloseCodes.shutdown, 'broker shutting down');
    for (const link of [...this.uiLinks]) link.conn.close(CloseCodes.shutdown, 'broker shutting down');
    this.uiLinks.clear();
  }

  // ------------------------------------------------------------ shim side

  private onShimFrame(link: ShimLink, raw: string): void {
    if (link.closed) return;
    const decoded = decodeFrame(ShimToBrokerFrameSchema, raw);
    if (!link.sessionId) {
      if (!decoded.ok) {
        this.rejectShim(link, decoded.id, 'invalid', decoded.error, 'unknown');
        this.closeLink(link, CloseCodes.invalidHello, 'invalid hello');
        return;
      }
      if (decoded.frame.type !== 'hello') {
        this.rejectShim(link, decoded.frame.id, 'invalid', 'the first frame must be hello', decoded.frame.type);
        this.closeLink(link, CloseCodes.invalidHello, 'invalid hello');
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
      this.closeLink(link, CloseCodes.unauthorized, 'unauthorized');
      return;
    }
    if (p.protocolVersion !== PROTOCOL_VERSION) {
      this.rejectShim(link, frame.id, 'invalid', `protocol version ${p.protocolVersion} not supported`, 'hello');
      this.closeLink(link, CloseCodes.invalidHello, 'protocol version');
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
        this.closeLink(old, CloseCodes.replaced, 'replaced by a newer connection');
      }
      if (rec.removeTimer) this.clock.clearTimeout(rec.removeTimer);
      rec.removeTimer = undefined;
      rec.helloRepos = helloRepos;
      rec.node.cwd = sanitizeText(p.cwd);
      rec.node.platform = p.platform;
      rec.node.hostname = hostname;
      rec.node.repos = unionRepos(helloRepos, rec.extraRepos);
    } else {
      this.goneIds.delete(id);
      this.aliases.delete(id);
      const name = this.uniqueName(sanitizeSessionName(p.defaultName), undefined);
      this.goneNames.delete(name.toLowerCase());
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
        removeTimer: undefined,
      };
      this.nodes.set(id, rec);
    }
    rec.link = link;
    rec.lastHeard = now;
    rec.node.connected = true;
    rec.node.lastSeen = now;
    link.sessionId = id;
    this.logger.log('shim_connected', { sessionId: id, name: rec.node.name, reconnect: known, aliasOf: id !== p.sessionId ? p.sessionId : undefined });
    this.sendShim(link, 'welcome', {
      re: frame.id,
      sessionId: id,
      name: rec.node.name,
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
      if (target.removeTimer) this.clock.clearTimeout(target.removeTimer);
      target.removeTimer = undefined;
      this.nodes.delete(y);
      this.aliases.set(y, x);
      for (const [k, v] of this.aliases) if (v === y) this.aliases.set(k, x);
      if (this.control.pausedSessions.delete(y)) {
        this.control.pausedSessions.add(x);
        this.broadcastControl();
      }
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
      this.nodeChanged(target);
      return;
    }
    const name = this.uniqueName(p.name, rec);
    this.goneNames.delete(name.toLowerCase());
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
    this.checkDraft(p.body, p.attachments);
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
    const message = this.buildMessage(from, rec.node.name, to, 'peer', p.kind, p.body, p.replyTo, threadId, now);
    this.route(message);
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
    if (!target) throw new Rejection('unknown_recipient', 'no session with that name or ID');
    else if (target.kind === 'owner') peer = OWNER_ADDRESS;
    else if (target.kind === 'gone') peer = sessionAddress(target.id);
    else peer = sessionAddress(target.rec.node.id);
    if (peer.kind === 'session' && peer.id === rec.node.id) throw new Rejection('invalid', 'there is no thread with yourself');
    const threadId = threadIdFor(sessionAddress(rec.node.id), peer);
    this.sendShim(link, 'thread', { re: frame.id, threadId, messages: this.threads.history(threadId, frame.payload.limit) });
  }

  private onShimClose(link: ShimLink): void {
    if (link.closed) return;
    link.closed = true;
    this.shimLinks.delete(link);
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
    this.checkDraft(p.body, p.attachments);
    const id = this.resolveId(p.to);
    const rec = this.nodes.get(id);
    if (!rec) {
      if (this.goneIds.has(id)) throw new Rejection('recipient_gone', 'that session was removed after its offline retention ran out');
      throw new Rejection('unknown_recipient', 'no session with that ID');
    }
    const to = sessionAddress(rec.node.id);
    const threadId = threadIdFor(OWNER_ADDRESS, to);
    const now = this.clock.now();
    const message = this.buildMessage(OWNER_ADDRESS, OWNER_KEY, to, 'owner', p.kind, p.body, p.replyTo, threadId, now);
    this.route(message);
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

  private checkDraft(body: string, attachments: string[]): void {
    if (utf8Bytes(body) > this.limits.maxBodyBytes) {
      throw new Rejection('too_large', `body is over ${this.limits.maxBodyBytes} bytes`);
    }
    // WP3: media is single use. Only the uploading connection may attach a media ID, and only once.
    if (attachments.length > 0) throw new Rejection('invalid', 'unknown media id');
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

  /** Resolves `to`: a live name, then a session ID (through aliases), then `owner`, then a removed session. */
  private resolveTarget(to: string): Target | undefined {
    const lower = to.toLowerCase();
    for (const rec of this.nodes.values()) if (rec.node.name.toLowerCase() === lower) return { kind: 'session', rec };
    const id = this.resolveId(to);
    const rec = this.nodes.get(id);
    if (rec) return { kind: 'session', rec };
    if (lower === OWNER_KEY) return { kind: 'owner' };
    if (this.goneIds.has(id)) return { kind: 'gone', id };
    const goneByName = this.goneNames.get(lower);
    if (goneByName) return { kind: 'gone', id: goneByName };
    return undefined;
  }

  private targetAddress(target: Target | undefined, raw: string): Address {
    if (!target) throw new Rejection('unknown_recipient', `no session with that name or ID (${raw.length} chars)`);
    if (target.kind === 'gone') throw new Rejection('recipient_gone', 'that session was removed after its offline retention ran out');
    if (target.kind === 'owner') return OWNER_ADDRESS;
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
  ): Message {
    const message: Message = {
      id: this.newId(now),
      threadId,
      from,
      fromName,
      to,
      senderKind,
      kind,
      body: sanitizeText(body),
      attachments: [],
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
    if (rec.removeTimer) this.clock.clearTimeout(rec.removeTimer);
    rec.removeTimer = this.clock.setTimeout(() => this.removeNode(rec), this.limits.offlineRetentionMs);
    this.nodeChanged(rec);
  }

  private removeNode(rec: NodeRecord): void {
    const id = rec.node.id;
    if (this.nodes.get(id) !== rec || rec.link) return;
    this.nodes.delete(id);
    this.goneIds.add(id);
    this.goneNames.set(rec.node.name.toLowerCase(), id);
    this.logger.log('node_removed', { sessionId: id, droppedQueued: rec.queue.length });
    rec.queue = [];
    this.broadcastUi('node', { op: 'remove', id });
    if (this.control.pausedSessions.delete(id)) this.broadcastControl();
    this.broadcastPeers();
  }

  private heartbeatTick(): void {
    const now = this.clock.now();
    this.limiter.sweep(now);
    for (const rec of [...this.nodes.values()]) {
      const link = rec.link;
      if (!link) continue;
      if (now - rec.lastHeard >= this.limits.disconnectAfterMs) {
        this.logger.log('heartbeat_timeout', { sessionId: rec.node.id, silentMs: now - rec.lastHeard });
        this.markDisconnected(rec, 'heartbeat timeout');
        this.closeLink(link, CloseCodes.timeout, 'heartbeat timeout');
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
