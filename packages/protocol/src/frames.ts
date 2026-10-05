import { z } from 'zod';
import { RejectCodeSchema } from './errors.js';
import { SessionIdSchema, SessionNameSchema } from './identity.js';
import { LimitsSchema } from './limits.js';
import {
  ControlStateSchema,
  DeliveryModeSchema,
  EdgeStatsSchema,
  FocusSchema,
  MediaIndexEntrySchema,
  MediaStoreUsageSchema,
  MessageKindSchema,
  MessageSchema,
  PeerInfoSchema,
  PlatformSchema,
  SessionNodeSchema,
  SessionStatusSchema,
  UlidSchema,
} from './model.js';
import { RepoRefSchema } from './repo.js';
import { PROTOCOL_VERSION } from './version.js';

/** WebSocket path shims connect to. */
export const SHIM_WS_PATH = '/ws/shim';

/** WebSocket path the web app connects to. */
export const UI_WS_PATH = '/ws/ui';

/** Maximum attachments on one message. */
export const MAX_ATTACHMENTS = 10;

/** Frame ID: chosen by the sender, unique per connection. */
export const FrameIdSchema = z.string().min(1).max(64);

function frame<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    id: FrameIdSchema,
    /** Sender's clock, milliseconds since epoch. Informational only. */
    ts: z.number(),
    payload,
  });
}

/** Payload of a response frame: the ID of the frame it answers. */
const re = FrameIdSchema;

// ---- Both directions, both endpoints ----

/** Heartbeat request. Either side may send it; the other answers with `pong`. */
export const PingFrame = frame('ping', z.object({}));
/** Heartbeat answer. */
export const PongFrame = frame('pong', z.object({ re }));

/** Successful `send` or `owner_send`. */
export const SentFrame = frame(
  'sent',
  z.object({ re, messageId: UlidSchema, threadId: z.string().min(1), ts: z.number() }),
);

/**
 * A rejected frame. `re` is the rejected frame's ID, or empty when the frame
 * could not be parsed far enough to read one. A rejected `hello` is followed
 * by the broker closing the connection.
 */
export const RejectedFrame = frame(
  'rejected',
  z.object({ re: z.string().max(64), code: RejectCodeSchema, detail: z.string().max(1024) }),
);

// ---- Shim to broker ----

/**
 * First frame on `/ws/shim`. A `hello` for a session ID the broker already
 * knows (a reconnect, or a session resumed with `--resume`, possibly from a
 * different directory) updates that node's cwd, repos and platform in place and
 * reconnects it; it is not a conflict.
 *
 * After `welcome` for a known session ID, the broker redelivers, oldest first,
 * every buffered message to that session that has no `seenAt`. A restarted shim
 * has lost its in-memory inbox; it dedupes by message ID.
 *
 * A session ID previously aliased by `register` resolves to its canonical ID.
 */
export const HelloFrame = frame(
  'hello',
  z.object({
    token: z.string().min(1).max(512),
    sessionId: SessionIdSchema,
    hostname: z.string().min(1).max(255),
    platform: PlatformSchema,
    cwd: z.string().max(1024),
    repos: z.array(RepoRefSchema).max(32),
    /** Name to use until `register`, normally `<directory name>@<hostname>`. */
    defaultName: SessionNameSchema,
    shimVersion: z.string().max(64),
    protocolVersion: z.number().int(),
  }),
);

/**
 * Sets the session's name and focus and adds repos. Answered by `registered`.
 * A taken name is made unique by appending `-2`, `-3`, and so on.
 *
 * Aliasing: a register with the hostname and name of a *disconnected* node X,
 * from a connection whose session ID is Y, keeps X as the canonical ID. The
 * connection is rebound to X, the broker records Y as an alias of X (so a later
 * `hello` with Y resolves to X), and `registered.sessionId` is X. Thread IDs
 * and edges keep X, so no rekeying happens. The web app receives
 * `node {op:'remove', id: Y}` and `node {op:'upsert'}` for X; shims receive
 * `peers`. Aliasing never takes over a connected node.
 */
export const RegisterFrame = frame(
  'register',
  z.object({
    name: SessionNameSchema,
    focus: FocusSchema,
    repos: z.array(RepoRefSchema).max(32),
  }),
);

/**
 * A draft message. `to` is a peer name, a session ID, or `owner`.
 * `attachments` are media IDs returned by `POST /api/media`; the broker
 * attaches its own stored `MediaRef` for each, so a sender cannot alter one.
 * Answered by `sent` or `rejected`.
 */
export const SendFrame = frame(
  'send',
  z.object({
    to: z.string().min(1).max(256),
    kind: MessageKindSchema,
    body: z.string(),
    replyTo: UlidSchema.optional(),
    attachments: z.array(z.string().min(1).max(64)).max(MAX_ATTACHMENTS),
  }),
);

/** IDs of delivered messages the session has now read. */
export const ShimSeenFrame = frame('seen', z.object({ ids: z.array(UlidSchema).min(1).max(500) }));

/** A change of status, focus, or delivery mode. At least one field is present. */
export const StatusFrame = frame(
  'status',
  z
    .object({
      status: SessionStatusSchema.optional(),
      focus: FocusSchema.optional(),
      delivery: DeliveryModeSchema.optional(),
    })
    .refine((p) => p.status !== undefined || p.focus !== undefined || p.delivery !== undefined, {
      message: 'status needs at least one field',
    }),
);

/** Asks for recent history with one peer (name, session ID, or `owner`). Answered by `thread`. */
export const ThreadRequestFrame = frame(
  'thread_request',
  z.object({ peer: z.string().min(1).max(256), limit: z.number().int().positive().max(500).optional() }),
);

/** Every frame a shim may send. */
export const ShimToBrokerFrameSchema = z.discriminatedUnion('type', [
  HelloFrame,
  RegisterFrame,
  SendFrame,
  ShimSeenFrame,
  StatusFrame,
  ThreadRequestFrame,
  PingFrame,
  PongFrame,
]);

/** Every frame a shim may send. */
export type ShimToBrokerFrame = z.infer<typeof ShimToBrokerFrameSchema>;

// ---- Broker to shim ----

/** Answer to `hello`: the assigned name, the limits in force, and the current peers. */
export const WelcomeFrame = frame(
  'welcome',
  z.object({
    re,
    sessionId: SessionIdSchema,
    name: SessionNameSchema,
    limits: LimitsSchema,
    peers: z.array(PeerInfoSchema),
    brokerVersion: z.string().max(64),
    protocolVersion: z.number().int(),
  }),
);

/**
 * Answer to `register`: the name actually assigned, the session's canonical ID
 * (different from the one in `hello` when the register aliased a disconnected
 * node), and the current peers.
 */
export const RegisteredFrame = frame(
  'registered',
  z.object({ re, sessionId: SessionIdSchema, name: SessionNameSchema, peers: z.array(PeerInfoSchema) }),
);

/** One inbound message. */
export const DeliverFrame = frame('deliver', z.object({ message: MessageSchema }));

/** Answer to `thread_request`: buffered history, oldest first. */
export const ThreadFrame = frame(
  'thread',
  z.object({ re, threadId: z.string().min(1), messages: z.array(MessageSchema) }),
);

/** The full peer list (every node except the recipient), sent whenever it changes. */
export const PeersFrame = frame('peers', z.object({ peers: z.array(PeerInfoSchema) }));

/** Every frame the broker may send to a shim. */
export const BrokerToShimFrameSchema = z.discriminatedUnion('type', [
  WelcomeFrame,
  RegisteredFrame,
  SentFrame,
  RejectedFrame,
  DeliverFrame,
  ThreadFrame,
  PeersFrame,
  PingFrame,
  PongFrame,
]);

/** Every frame the broker may send to a shim. */
export type BrokerToShimFrame = z.infer<typeof BrokerToShimFrameSchema>;

// ---- Web app to broker ----

/**
 * An Owner message to one session. The broker stamps `senderKind: 'owner'`
 * because it arrived on the authenticated Owner connection. Answered by
 * `sent` or `rejected`.
 */
export const OwnerSendFrame = frame(
  'owner_send',
  z.object({
    to: SessionIdSchema,
    kind: MessageKindSchema,
    body: z.string(),
    replyTo: UlidSchema.optional(),
    attachments: z.array(z.string().min(1).max(64)).max(MAX_ATTACHMENTS),
  }),
);

/** An Owner traffic control. Controls never block Owner messages. */
export const ControlActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('mute_thread'), threadId: z.string().min(1) }),
  z.object({ action: z.literal('unmute_thread'), threadId: z.string().min(1) }),
  z.object({ action: z.literal('pause_session'), sessionId: SessionIdSchema }),
  z.object({ action: z.literal('resume_session'), sessionId: SessionIdSchema }),
  z.object({ action: z.literal('pause_all') }),
  z.object({ action: z.literal('resume_all') }),
]);

/** An Owner traffic control. */
export type ControlAction = z.infer<typeof ControlActionSchema>;

/** Applies a control. The broker broadcasts the result as `control_state`. */
export const ControlFrame = frame('control', ControlActionSchema);

/** Every frame the web app may send. */
export const UiToBrokerFrameSchema = z.discriminatedUnion('type', [OwnerSendFrame, ControlFrame, PingFrame, PongFrame]);

/** Every frame the web app may send. */
export type UiToBrokerFrame = z.infer<typeof UiToBrokerFrameSchema>;

// ---- Broker to web app ----

/** Full state, sent to each new `/ws/ui` connection before any delta. */
export const SnapshotFrame = frame(
  'snapshot',
  z.object({
    brokerVersion: z.string().max(64),
    protocolVersion: z.number().int(),
    /** Broker clock when the snapshot was taken. */
    now: z.number(),
    limits: LimitsSchema,
    nodes: z.array(SessionNodeSchema),
    edges: z.array(EdgeStatsSchema),
    /** Every buffered message, oldest first. */
    messages: z.array(MessageSchema),
    /** Every unexpired media item. */
    media: z.array(MediaIndexEntrySchema),
    control: ControlStateSchema,
    mediaStore: MediaStoreUsageSchema,
  }),
);

/** A node was added or changed, or removed after its offline retention ran out. */
export const NodeFrame = frame(
  'node',
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('upsert'), node: SessionNodeSchema }),
    z.object({ op: z.literal('remove'), id: SessionIdSchema }),
  ]),
);

/** A message was routed, with its thread's statistics after it. */
export const MessageFrame = frame('message', z.object({ message: MessageSchema, edge: EdgeStatsSchema }));

/** A session read messages. Each listed message's `seenAt` becomes `seenAt`. */
export const UiSeenFrame = frame(
  'seen',
  z.object({ by: SessionIdSchema, ids: z.array(UlidSchema).min(1), seenAt: z.number() }),
);

/** A media item was added or expired, with the store usage after it. */
export const MediaFrame = frame(
  'media',
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('add'), entry: MediaIndexEntrySchema, edge: EdgeStatsSchema, mediaStore: MediaStoreUsageSchema }),
    z.object({
      op: z.literal('expire'),
      mediaId: z.string().min(1),
      threadId: z.string().min(1),
      edge: EdgeStatsSchema,
      mediaStore: MediaStoreUsageSchema,
    }),
  ]),
);

/** The controls in force changed. */
export const ControlStateFrame = frame('control_state', ControlStateSchema);

/** Every frame the broker may send to the web app. */
export const BrokerToUiFrameSchema = z.discriminatedUnion('type', [
  SnapshotFrame,
  NodeFrame,
  MessageFrame,
  UiSeenFrame,
  MediaFrame,
  ControlStateFrame,
  SentFrame,
  RejectedFrame,
  PingFrame,
  PongFrame,
]);

/** Every frame the broker may send to the web app. */
export type BrokerToUiFrame = z.infer<typeof BrokerToUiFrameSchema>;

// ---- Encoding and decoding ----

/** Any frame in any direction. */
export type AnyFrame = ShimToBrokerFrame | BrokerToShimFrame | UiToBrokerFrame | BrokerToUiFrame;

/** The frame of union `U` whose type is `T`. */
export type FrameOf<U extends AnyFrame, T extends U['type']> = Extract<U, { type: T }>;

/** The payload of the frame of union `U` whose type is `T`. */
export type PayloadOf<U extends AnyFrame, T extends U['type']> = FrameOf<U, T>['payload'];

/**
 * Returns a function that builds frames of union `U`, numbering frame IDs
 * `${prefix}1`, `${prefix}2`, and so on. Use one factory per connection.
 *
 * @example
 * const mk = createFrameFactory<ShimToBrokerFrame>('s');
 * ws.send(encodeFrame(mk('ping', {})));
 */
export function createFrameFactory<U extends AnyFrame>(prefix = '', clock: () => number = Date.now) {
  let counter = 0;
  return <T extends U['type']>(type: T, payload: PayloadOf<U, T>): FrameOf<U, T> =>
    ({ v: PROTOCOL_VERSION, type, id: `${prefix}${++counter}`, ts: clock(), payload }) as unknown as FrameOf<U, T>;
}

/** Serializes a frame as a JSON text frame. */
export function encodeFrame(frame: AnyFrame): string {
  return JSON.stringify(frame);
}

/** Result of {@link decodeFrame}. */
export type DecodeResult<F> =
  | { ok: true; frame: F }
  | {
      ok: false;
      /** Human-readable reason, safe to log: it never includes the frame's body. */
      error: string;
      /** The frame's ID when it could be read, for `rejected.re`. */
      id: string;
    };

/**
 * Parses and validates one JSON text frame against a direction's union schema.
 * Never throws.
 */
export function decodeFrame<S extends z.ZodType>(schema: S, raw: string): DecodeResult<z.infer<S>> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'frame is not valid JSON', id: '' };
  }
  const idResult = FrameIdSchema.safeParse((data as { id?: unknown } | null)?.id);
  const id = idResult.success ? idResult.data : '';
  const version = (data as { v?: unknown } | null)?.v;
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, error: `unsupported protocol version ${String(version)}`, id };
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, error: issues.join('; '), id };
  }
  return { ok: true, frame: parsed.data };
}
