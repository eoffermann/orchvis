import { z } from 'zod';
import { AddressSchema, MAX_FOCUS_LENGTH, SessionIdSchema, SessionNameSchema } from './identity.js';
import { RepoRefSchema } from './repo.js';

/** ULID: 26 Crockford base32 characters. Message IDs are ULIDs assigned by the broker. */
export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'expected a ULID');

/** Operating system of a session's machine. */
export const PlatformSchema = z.enum(['win32', 'darwin', 'linux']);

/** Operating system of a session's machine. */
export type Platform = z.infer<typeof PlatformSchema>;

/** What a session reports it is doing. */
export const SessionStatusSchema = z.enum(['idle', 'working', 'blocked']);

/** What a session reports it is doing. */
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** How a session receives messages: channel push, or inbox polling. */
export const DeliveryModeSchema = z.enum(['push', 'poll']);

/** How a session receives messages: channel push, or inbox polling. */
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

/** A one-line description of a session's work. */
export const FocusSchema = z.string().max(MAX_FOCUS_LENGTH);

/** One Claude Code session as known to the broker. */
export const SessionNodeSchema = z.object({
  id: SessionIdSchema,
  hostname: z.string().min(1).max(255),
  platform: PlatformSchema,
  /** Self-chosen through `register`, unique per broker. */
  name: SessionNameSchema,
  /** One line describing what this session works on. */
  focus: FocusSchema,
  repos: z.array(RepoRefSchema).max(32),
  /**
   * The session's working directory, for display in the node chat header only.
   * No other field on the wire carries a filesystem path.
   */
  cwd: z.string().max(1024),
  status: SessionStatusSchema,
  delivery: DeliveryModeSchema,
  connected: z.boolean(),
  /** Broker clock time the node was last heard from. */
  lastSeen: z.number(),
});

/** One Claude Code session as known to the broker. */
export type SessionNode = z.infer<typeof SessionNodeSchema>;

/**
 * A session as other sessions see it: a {@link SessionNode} without `cwd`,
 * which is shown only to the Owner.
 */
export const PeerInfoSchema = SessionNodeSchema.omit({ cwd: true });

/** A session as other sessions see it. */
export type PeerInfo = z.infer<typeof PeerInfoSchema>;

/** Strips the fields peers do not get from a node. */
export function toPeerInfo(node: SessionNode): PeerInfo {
  const { cwd: _cwd, ...peer } = node;
  return peer;
}

/** Broad media category, used for edge icons and the media browser filter. */
export const MediaKindSchema = z.enum(['image', 'audio', 'video', 'other']);

/** Broad media category. */
export type MediaKind = z.infer<typeof MediaKindSchema>;

/** Media category of a MIME type. */
export function mediaKindOf(mime: string): MediaKind {
  const top = mime.split('/')[0]?.toLowerCase();
  if (top === 'image' || top === 'audio' || top === 'video') return top;
  return 'other';
}

/**
 * A short-lived attachment held in the broker's media store. Media is single
 * use: only the connection that uploaded it may attach it, and only to one
 * message. Any other attach is rejected with `invalid`. So each media ID
 * belongs to exactly one message and one thread.
 */
export const MediaRefSchema = z.object({
  mediaId: z.string().min(1).max(64),
  mime: z.string().min(1).max(255),
  filename: z.string().min(1).max(255),
  bytes: z.number().int().nonnegative(),
  /** Lowercase hex SHA-256 of the file. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Required. States what the media shows or says. */
  caption: z.string().min(1),
  /** Broker clock time at which the file is deleted. */
  expiresAt: z.number(),
});

/** A short-lived attachment held in the broker's media store. */
export type MediaRef = z.infer<typeof MediaRefSchema>;

/** Who sent a message, as stamped by the broker from the connection. */
export const SenderKindSchema = z.enum(['peer', 'owner', 'system']);

/** Who sent a message, as stamped by the broker from the connection. */
export type SenderKind = z.infer<typeof SenderKindSchema>;

/** Purpose of a message. */
export const MessageKindSchema = z.enum(['chat', 'request', 'response', 'notice']);

/** Purpose of a message. */
export type MessageKind = z.infer<typeof MessageKindSchema>;

/**
 * A routed message. Every field except the sender's draft (`to`, `kind`,
 * `body`, `replyTo`, attachment IDs) is set by the broker.
 */
export const MessageSchema = z.object({
  /** ULID assigned by the broker. */
  id: UlidSchema,
  /** Sorted participant pair; see `threadIdFor`. */
  threadId: z.string().min(1),
  from: AddressSchema,
  /**
   * The sender's session name at send time, or `owner`. Stamped by the broker,
   * so it stays readable after the sender disconnects or is removed.
   */
  fromName: z.string().min(1).max(64),
  to: AddressSchema,
  /** Set by the broker from the connection, never by the sender. */
  senderKind: SenderKindSchema,
  kind: MessageKindSchema,
  /** Sanitized by the broker. */
  body: z.string(),
  replyTo: UlidSchema.optional(),
  attachments: z.array(MediaRefSchema),
  /** Broker clock, milliseconds since epoch. */
  ts: z.number(),
  /**
   * Broker clock time the recipient reported it read the message. Absent until
   * then. Messages to the Owner never get one.
   */
  seenAt: z.number().optional(),
});

/** A routed message. */
export type Message = z.infer<typeof MessageSchema>;

/** Unexpired media counts on a thread, by kind. */
export const MediaCountsSchema = z.object({
  image: z.number().int().nonnegative(),
  audio: z.number().int().nonnegative(),
  video: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
});

/** Unexpired media counts on a thread, by kind. */
export type MediaCounts = z.infer<typeof MediaCountsSchema>;

/**
 * Statistics for one thread. `a` and `b` are the participants' address keys in
 * thread ID order. Evaluate the current weight with `weightAt`.
 */
export const EdgeStatsSchema = z.object({
  threadId: z.string().min(1),
  a: z.string().min(1),
  b: z.string().min(1),
  /** Decayed message count as of `updatedAt`. */
  weight: z.number().nonnegative(),
  updatedAt: z.number(),
  lastMessageAt: z.number(),
  /** Messages sent by `a` to `b`. */
  sentByA: z.number().int().nonnegative(),
  /** Messages sent by `b` to `a`. */
  sentByB: z.number().int().nonnegative(),
  media: MediaCountsSchema,
});

/** Statistics for one thread. */
export type EdgeStats = z.infer<typeof EdgeStatsSchema>;

/** One media item as listed for the web app's media browser. */
export const MediaIndexEntrySchema = z.object({
  ref: MediaRefSchema,
  kind: MediaKindSchema,
  threadId: z.string().min(1),
  messageId: UlidSchema,
  from: AddressSchema,
  /** Broker clock time of the message that carried it. */
  ts: z.number(),
});

/** One media item as listed for the web app's media browser. */
export type MediaIndexEntry = z.infer<typeof MediaIndexEntrySchema>;

/** Media store usage, for the top bar. */
export const MediaStoreUsageSchema = z.object({
  bytes: z.number().int().nonnegative(),
  capBytes: z.number().int().positive(),
  files: z.number().int().nonnegative(),
});

/** Media store usage, for the top bar. */
export type MediaStoreUsage = z.infer<typeof MediaStoreUsageSchema>;

/** Owner traffic controls currently in force. Controls never block Owner messages. */
export const ControlStateSchema = z.object({
  mutedThreads: z.array(z.string()),
  pausedSessions: z.array(SessionIdSchema),
  pausedAll: z.boolean(),
});

/** Owner traffic controls currently in force. */
export type ControlState = z.infer<typeof ControlStateSchema>;
