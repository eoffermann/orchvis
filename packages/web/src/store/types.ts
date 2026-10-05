import type {
  ControlState,
  EdgeStats,
  Limits,
  MediaIndexEntry,
  MediaKind,
  MediaStoreUsage,
  Message,
  RejectCode,
  SessionNode,
} from '@orchvis/protocol';

/** A message as the store keeps it. Its `seenAt` is updated from `seen` deltas. */
export type StoreMessage = Message;

/**
 * State of the `/ws/ui` connection.
 *
 * - `idle`: not started.
 * - `connecting`: first attempt in progress.
 * - `open`: socket open (the store is `synced` once the snapshot lands).
 * - `reconnecting`: the socket dropped; a retry is scheduled or in progress.
 * - `unauthorized`: the broker refused the Owner cookie; the login screen shows.
 */
export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'unauthorized';

/** What the Owner has selected. Overlays (WP6) open from this. */
export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; threadId: string }
  | { kind: 'media'; threadId: string; mediaKind: MediaKind };

/** Top-bar filters. An empty list means "no filter". */
export interface Filters {
  /** Repo keys to show. */
  repos: readonly string[];
  /** Hostnames to show. */
  hosts: readonly string[];
}

/** The last frame the broker rejected, for a transient notice. */
export interface Rejection {
  /** ID of the rejected outbound frame. */
  re: string;
  /** Rejection code. */
  code: RejectCode;
  /** Broker's explanation; plain text, render as a text node. */
  detail: string;
}

/** Broker-owned data, replaced wholesale by every snapshot. */
export interface FeedData {
  /** Broker build version from the snapshot. */
  brokerVersion: string;
  /** Limits in force, from the snapshot. */
  limits: Limits;
  /** Sessions by session ID. */
  nodes: Readonly<Record<string, SessionNode>>;
  /** Thread statistics by thread ID. */
  edges: Readonly<Record<string, EdgeStats>>;
  /** Buffered messages per thread ID, oldest first. */
  messages: Readonly<Record<string, readonly StoreMessage[]>>;
  /** Thread ID of every buffered message, by message ID. */
  messageThread: Readonly<Record<string, string>>;
  /** Unexpired media by media ID. */
  media: Readonly<Record<string, MediaIndexEntry>>;
  /**
   * Media IDs known to have expired: attachments of buffered messages that a
   * snapshot did not list as media, plus every `media {op:'expire'}` since.
   * Overlays render these as tombstones.
   */
  expiredMedia: Readonly<Record<string, true>>;
  /** Controls in force. */
  control: ControlState;
  /** Media store usage. */
  mediaStore: MediaStoreUsage;
  /** Last rejection, or null. */
  lastRejection: Rejection | null;
}

/** Owner-side view state. It survives reconnects. */
export interface ViewState {
  /** Current selection, or null. */
  selection: Selection | null;
  /** Session ID under the mouse pointer, or null. */
  hoverNodeId: string | null;
  /** Top-bar filters. */
  filters: Filters;
}

/** The whole client state. */
export interface AppState {
  /** Connection state. */
  connection: ConnectionStatus;
  /**
   * True once a snapshot has arrived on the current connection. Deltas that
   * arrive while false are dropped, since the next snapshot supersedes them.
   */
  synced: boolean;
  /** True once any snapshot has been applied since page load. */
  everSynced: boolean;
  /** `broker clock - local clock` measured at the last snapshot, in ms. */
  clockOffsetMs: number;
  /** Current broker-clock estimate, advanced by `tick`. Drives edge decay. */
  now: number;
  /** Broker-owned data. */
  data: FeedData;
  /** View state. */
  view: ViewState;
}
