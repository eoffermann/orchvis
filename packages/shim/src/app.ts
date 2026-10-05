import { stat } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  normalizeRepoKey,
  repoNameFromKey,
  utf8Bytes,
  type MediaRef,
  type Message,
  type PeerInfo,
  type RepoRef,
} from '@orchvis/protocol';
import { BrokerClient, BrokerUnreachableError, explainRejection, type SendPayload } from './broker.js';
import {
  CHANNEL_INSTRUCTIONS,
  ChannelProbe,
  channelExperimentalCapabilities,
  emitChannelEvent,
  messageEvent,
} from './channel.js';
import { loadConfig, type ShimConfig } from './config.js';
import { buildIdentity, detectRepo, rawSessionIdFrom, type ShimIdentity } from './identity.js';
import { Inbox, InboxMirrorWriter, inboxMirrorPath, toEntry } from './inbox.js';
import type { Logger } from './log.js';
import { MediaError, MediaStore, uploadMedia, validateAttachments, type MediaEndpoint } from './media.js';
import {
  ToolError,
  callTool,
  listTools,
  peerInRepo,
  peerView,
  type ShimApi,
} from './tools.js';
import { SERVER_NAME, SHIM_VERSION } from './version.js';

/** Options for {@link startShim}. */
export interface StartShimOptions {
  log: Logger;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Called once the shim has shut down (stdin closed). */
  onExit?: () => void;
}

/** Handle on a running shim. */
export interface RunningShim {
  /** Stops everything and cleans up. Idempotent. */
  shutdown(reason: string): Promise<void>;
}

/**
 * Starts the shim on stdio: completes the MCP handshake first, then collects
 * the identity and connects to the broker in the background. Exits when stdin
 * closes.
 */
export async function startShim(options: StartShimOptions): Promise<RunningShim> {
  const { log } = options;
  const env = options.env ?? process.env;
  const config = loadConfig(env);
  const raw = rawSessionIdFrom(env);
  if (!raw.fromEnv) log.warn('CLAUDE_CODE_SESSION_ID is not set; using a process-lifetime UUID');
  log.info(`config: ${config.problem ? `unusable (${config.problem})` : `broker ${config.wsUrl}`}`);

  const server = new Server(
    { name: SERVER_NAME, version: SHIM_VERSION },
    {
      capabilities: { experimental: channelExperimentalCapabilities(), tools: {} },
      instructions: CHANNEL_INSTRUCTIONS,
    },
  );

  const shim = new ShimCore(server, config, raw, log, options.cwd ?? process.cwd());
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(shim, request.params.name, request.params.arguments),
  );

  let initialized!: () => void;
  const initializedPromise = new Promise<void>((r) => (initialized = r));
  server.oninitialized = () => {
    log.info('MCP handshake complete');
    initialized();
  };

  let done = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (done) return;
    done = true;
    log.info(`shutting down: ${reason}`);
    await shim.dispose();
    await server.close().catch(() => {});
    options.onExit?.();
  };

  process.stdin.on('end', () => void shutdown('stdin ended'));
  process.stdin.on('close', () => void shutdown('stdin closed'));

  log.info('starting MCP server on stdio');
  await server.connect(new StdioServerTransport());

  // Identity (git calls) runs alongside the handshake; the broker waits for both.
  const identityPromise = buildIdentity({ env, cwd: options.cwd ?? process.cwd(), raw });
  void Promise.all([initializedPromise, identityPromise])
    .then(([, identity]) => {
      if (!done) shim.start(identity);
    })
    .catch((err: unknown) => log.warn(`startup failed: ${(err as Error).message}`));

  return { shutdown };
}

/** The shim's state and tool implementations. */
class ShimCore implements ShimApi {
  private broker: BrokerClient | undefined;
  private identity: ShimIdentity | undefined;
  private peers: PeerInfo[] = [];
  private readonly inbox: Inbox;
  private readonly mirror: InboxMirrorWriter;
  private readonly media: MediaStore;
  private readonly probe: ChannelProbe;
  private readonly mediaRefs = new Map<string, MediaRef>();

  constructor(
    private readonly server: Server,
    private readonly config: ShimConfig,
    private readonly raw: { id: string; fromEnv: boolean },
    private readonly log: Logger,
    private readonly cwd: string,
  ) {
    this.mirror = new InboxMirrorWriter(inboxMirrorPath(config.home, raw.id), log);
    this.inbox = new Inbox({
      onSeen: (ids) => {
        if (!this.broker?.seen(ids)) log.debug(`seen for ${ids.length} message(s) not sent: broker not connected`);
      },
      onChange: () => this.writeMirror(),
    });
    this.media = new MediaStore(raw.id, log);
    this.probe = new ChannelProbe({
      emit: (event) => emitChannelEvent(this.server, event),
      onPush: () => this.setDelivery('push'),
      onPoll: () => {
        log.info('no confirm_channel within the probe timeout; delivery is poll');
        this.setDelivery('poll');
      },
    });
  }

  /** Connects to the broker once the identity is known. */
  start(identity: ShimIdentity): void {
    this.identity = identity;
    this.media.startSweeping();
    this.writeMirror();
    log(this.log, identity);
    if (this.config.problem || !this.config.wsUrl || !this.config.shimToken) return;
    this.broker = new BrokerClient({
      url: this.config.wsUrl,
      token: this.config.shimToken,
      hello: {
        sessionId: identity.sessionId,
        hostname: identity.hostname,
        platform: identity.platform,
        cwd: identity.cwd,
        repos: identity.repos,
        defaultName: identity.defaultName,
        shimVersion: SHIM_VERSION,
      },
      log: this.log,
      onReady: ({ welcome }) => {
        this.broker?.rememberStatus({ delivery: this.inbox.mode });
        this.startProbe(welcome.limits.channelProbeTimeoutMs);
        this.writeMirror();
      },
      onDeliver: (message) => void this.onDeliver(message),
      onPeers: (peers) => {
        this.peers = peers;
      },
    });
    this.broker.start();
  }

  /** Stops the broker client and cleans up local files. */
  async dispose(): Promise<void> {
    this.probe.dispose();
    this.broker?.stop();
    this.media.disposeSync();
    await this.mirror.remove();
  }

  unreadCount(): number {
    return this.inbox.unreadCount;
  }

  // ---- Delivery ----

  private async onDeliver(message: Message): Promise<void> {
    for (const ref of message.attachments) this.mediaRefs.set(ref.mediaId, ref);
    if (!this.inbox.receive(message)) {
      this.log.debug(`duplicate delivery of ${message.id} ignored`);
      return;
    }
    this.log.info(`delivered ${message.id} from ${message.fromName} (${message.senderKind}, ${message.kind})`);
    try {
      await emitChannelEvent(this.server, messageEvent(message));
      this.inbox.notified(message.id);
    } catch (err) {
      this.log.warn(`channel notification for ${message.id} failed: ${(err as Error).message}`);
    }
  }

  private startProbe(timeoutMs: number): void {
    this.probe.start(timeoutMs).catch((err: unknown) => this.log.warn(`probe emit failed: ${(err as Error).message}`));
    this.log.info(`delivery probe sent; waiting up to ${Math.round(timeoutMs / 1000)} s for confirm_channel`);
  }

  private setDelivery(mode: 'push' | 'poll'): void {
    const changed = this.inbox.mode !== mode;
    this.inbox.setMode(mode);
    if (changed) this.log.info(`delivery mode: ${mode}`);
    try {
      this.broker?.status({ delivery: mode });
    } catch {
      this.broker?.rememberStatus({ delivery: mode });
    }
  }

  private writeMirror(): void {
    if (!this.identity) return;
    void this.mirror.write({
      version: 1,
      sessionId: this.broker?.sessionId ?? this.identity.sessionId,
      rawSessionId: this.raw.id,
      name: this.broker?.name ?? this.identity.defaultName,
      delivery: this.inbox.mode,
      updatedAt: new Date().toISOString(),
      unread: this.inbox.peek().map(toEntry),
    });
  }

  // ---- Helpers ----

  private notStarted(): ToolError {
    const url = this.config.wsUrl ?? this.config.brokerUrl ?? '(none configured)';
    const reason = this.config.problem ?? (this.identity ? 'not started' : 'still starting up');
    return new ToolError(
      'broker_unreachable',
      `could not reach the orchvis broker at ${url} (${reason}). Keep working and retry later.`,
    );
  }

  private requireBroker(): BrokerClient {
    if (!this.broker) throw this.notStarted();
    try {
      this.broker.assertReady();
    } catch (err) {
      throw this.unreachable(err);
    }
    return this.broker;
  }

  private unreachable(err: unknown): Error {
    if (err instanceof BrokerUnreachableError) {
      return new ToolError(
        'broker_unreachable',
        `could not reach the orchvis broker at ${err.url} (${err.reason}). Keep working and retry later.`,
      );
    }
    return err as Error;
  }

  private endpoint(): MediaEndpoint {
    if (!this.config.httpBase || !this.config.shimToken) {
      throw new ToolError('broker_unreachable', `no broker configured (${this.config.problem ?? 'unknown'})`);
    }
    return { httpBase: this.config.httpBase, token: this.config.shimToken };
  }

  private async resolveRepo(spec: string): Promise<RepoRef> {
    const key = normalizeRepoKey(spec);
    if (key) return { key, name: repoNameFromKey(key) };
    const hostname = this.identity?.hostname ?? 'localhost';
    try {
      if ((await stat(spec)).isDirectory()) return (await detectRepo(spec, hostname)).repo;
    } catch {
      // Not a local path.
    }
    if (/^[^\s/:]+(\/[^\s/]+)+$/.test(spec)) {
      const slash = spec.indexOf('/');
      const asKey = `${spec.slice(0, slash).toLowerCase()}${spec.slice(slash).replace(/\.git$/i, '').replace(/\/+$/, '')}`;
      return { key: asKey, name: repoNameFromKey(asKey) };
    }
    throw new ToolError('invalid_arguments', `not a git remote, repo key, or local repo directory: ${spec}`);
  }

  // ---- Tools ----

  async register(args: { name: string; focus: string; repos?: string[] | undefined }): Promise<string> {
    const repos: RepoRef[] = [];
    for (const spec of args.repos ?? []) repos.push(await this.resolveRepo(spec));
    // Not connected yet: the register is still remembered and sent on connect.
    const broker = this.broker;
    if (!broker) throw this.notStarted();
    let answer;
    try {
      answer = await broker.register({ name: args.name, focus: args.focus, repos });
    } catch (err) {
      const e = this.unreachable(err);
      if (e instanceof ToolError) {
        throw new ToolError(e.code, `${e.message} The registration is remembered and will be sent on reconnect.`);
      }
      throw e;
    }
    if ('code' in answer) throw new ToolError('rejected', explainRejection(answer));
    this.writeMirror();
    this.startProbe(broker.limits.channelProbeTimeoutMs);
    return JSON.stringify(
      {
        name: answer.name,
        session_id: answer.sessionId,
        delivery: this.inbox.mode,
        probe: 'sent: when the probe event arrives, call confirm_channel with its nonce',
        peers: answer.peers.map(peerView),
      },
      null,
      2,
    );
  }

  async listPeers(args: { repo?: string | undefined }): Promise<string> {
    this.requireBroker();
    const peers = args.repo ? this.peers.filter((p) => peerInRepo(p, args.repo!)) : this.peers;
    if (peers.length === 0) return args.repo ? `No peers in repo ${args.repo}.` : 'No peers connected.';
    return JSON.stringify(peers.map(peerView), null, 2);
  }

  async sendMessage(args: {
    to: string;
    body: string;
    kind?: 'chat' | 'request' | 'response' | 'notice' | undefined;
    reply_to?: string | undefined;
    attachments?: Array<{ path: string; caption: string }> | undefined;
  }): Promise<string> {
    const broker = this.requireBroker();
    const limits = broker.limits;
    if (utf8Bytes(args.body) > limits.maxBodyBytes) {
      throw new ToolError('too_large', `the body is over the ${limits.maxBodyBytes}-byte limit; shorten it or attach a file`);
    }
    const mediaIds: string[] = [];
    if (args.attachments?.length) {
      try {
        const files = await validateAttachments(args.attachments, limits, this.cwd);
        const endpoint = this.endpoint();
        for (const file of files) {
          const ref = await uploadMedia(endpoint, file);
          mediaIds.push(ref.mediaId);
          this.log.info(`uploaded attachment as ${ref.mediaId} (${ref.bytes} bytes)`);
        }
      } catch (err) {
        if (err instanceof MediaError) throw new ToolError(err.code, err.message);
        throw err;
      }
    }
    let answer;
    try {
      const payload: SendPayload = {
        to: args.to,
        kind: args.kind ?? 'chat',
        body: args.body,
        attachments: mediaIds,
        ...(args.reply_to ? { replyTo: args.reply_to } : {}),
      };
      answer = await broker.request('send', payload, ['sent']);
    } catch (err) {
      throw this.unreachable(err);
    }
    if (answer.type === 'rejected') throw new ToolError('rejected', explainRejection(answer.payload));
    this.inbox.markThreadSeen(answer.payload.threadId);
    return `Sent. message_id=${answer.payload.messageId} thread_id=${answer.payload.threadId}`;
  }

  async checkInbox(args: { limit?: number | undefined }): Promise<string> {
    const messages = this.inbox.take(args.limit);
    if (messages.length === 0) return 'No unread messages.';
    return JSON.stringify(messages.map(toEntry), null, 2);
  }

  async getThread(args: { peer: string; limit?: number | undefined }): Promise<string> {
    const broker = this.requireBroker();
    let answer;
    try {
      answer = await broker.request('thread_request', { peer: args.peer, limit: args.limit ?? 50 }, ['thread']);
    } catch (err) {
      throw this.unreachable(err);
    }
    if (answer.type === 'rejected') throw new ToolError('rejected', explainRejection(answer.payload));
    for (const m of answer.payload.messages) for (const ref of m.attachments) this.mediaRefs.set(ref.mediaId, ref);
    if (answer.payload.messages.length === 0) return `No messages with ${args.peer} in the broker's buffer.`;
    return JSON.stringify(
      { thread_id: answer.payload.threadId, messages: answer.payload.messages.map(toEntry) },
      null,
      2,
    );
  }

  async fetchMedia(args: { media_id: string }): Promise<string> {
    const ref = this.mediaRefs.get(args.media_id);
    if (!ref) {
      throw new ToolError(
        'unknown_media',
        `media_id ${args.media_id} is not in any message this session received; call get_thread first if it is older`,
      );
    }
    const broker = this.requireBroker();
    try {
      const fetched = await this.media.fetch(this.endpoint(), ref, broker.limits.mediaTtlMs);
      return JSON.stringify(
        {
          path: fetched.path,
          mime: ref.mime,
          caption: ref.caption,
          filename: ref.filename,
          bytes: ref.bytes,
          local_copy_deleted_at: new Date(fetched.localExpiresAt).toISOString(),
          note: 'Copy the file elsewhere if you need it after that time.',
        },
        null,
        2,
      );
    } catch (err) {
      if (err instanceof MediaError) throw new ToolError(err.code, err.message);
      throw err;
    }
  }

  async setStatus(args: { status: 'idle' | 'working' | 'blocked'; focus?: string | undefined }): Promise<string> {
    const broker = this.requireBroker();
    try {
      broker.status({ status: args.status, ...(args.focus !== undefined ? { focus: args.focus } : {}) });
    } catch (err) {
      throw this.unreachable(err);
    }
    return `Status set to ${args.status}${args.focus !== undefined ? ' with new focus' : ''}.`;
  }

  async confirmChannel(args: { nonce: string }): Promise<string> {
    const result = this.probe.confirm(args.nonce);
    if (result === 'no_probe') throw new ToolError('no_probe', 'no delivery probe is pending');
    if (result === 'mismatch') throw new ToolError('nonce_mismatch', 'that nonce does not match the latest probe');
    return 'Channel confirmed: push delivery is on. Messages will arrive as channel events.';
  }
}

function log(logger: Logger, identity: ShimIdentity): void {
  logger.info(
    `identity: ${identity.sessionId} (${identity.platform}), default name ${identity.defaultName}, repo ${identity.repos[0]?.key ?? '-'}`,
  );
}
