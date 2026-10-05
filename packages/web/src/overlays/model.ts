import {
  OWNER_ADDRESS,
  OWNER_KEY,
  sessionAddress,
  threadIdFor,
  type EdgeStats,
  type MediaIndexEntry,
  type MediaKind,
  type MediaRef,
  type SessionNode,
} from '@orchvis/protocol';
import type { FeedData, StoreMessage } from '../store/types';

/** Thread ID of the Owner's conversation with one session. */
export function ownerThreadId(sessionId: string): string {
  return threadIdFor(OWNER_ADDRESS, sessionAddress(sessionId));
}

/** The two participant keys of a thread ID, or null when malformed. */
export function threadKeys(threadId: string): [string, string] | null {
  const parts = threadId.split('|');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return [parts[0], parts[1]];
}

/**
 * Display name for an address key: `Owner`, the node's current name, the
 * name the broker stamped on a message from it, or the raw key.
 */
export function nameForKey(key: string, data: Pick<FeedData, 'nodes'>, messages: readonly StoreMessage[] = []): string {
  if (key === OWNER_KEY) return 'Owner';
  const node = data.nodes[key];
  if (node) return node.name;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as StoreMessage;
    if (m.from.kind === 'session' && m.from.id === key) return m.fromName;
  }
  return key;
}

/** One entry in a node's side list of peer threads. */
export interface PeerThread {
  /** Thread ID. */
  threadId: string;
  /** The other participant's address key. */
  peerKey: string;
  /** The other participant's display name. */
  peerName: string;
  /** Broker time of the last message. */
  lastMessageAt: number;
  /** Messages in both directions. */
  total: number;
}

/**
 * A session's threads with other sessions (not the Owner), most recently
 * active first.
 */
export function peerThreadsOf(sessionId: string, data: Pick<FeedData, 'nodes' | 'edges' | 'messages'>): PeerThread[] {
  const out: PeerThread[] = [];
  for (const e of Object.values(data.edges) as EdgeStats[]) {
    if (e.a !== sessionId && e.b !== sessionId) continue;
    const peerKey = e.a === sessionId ? e.b : e.a;
    if (peerKey === OWNER_KEY || peerKey === sessionId) continue;
    out.push({
      threadId: e.threadId,
      peerKey,
      peerName: nameForKey(peerKey, data, data.messages[e.threadId] ?? []),
      lastMessageAt: e.lastMessageAt,
      total: e.sentByA + e.sentByB,
    });
  }
  return out.sort((x, y) => y.lastMessageAt - x.lastMessageAt || x.threadId.localeCompare(y.threadId));
}

/** Unexpired media on one thread of one kind, oldest first. */
export function mediaItemsFor(data: Pick<FeedData, 'media'>, threadId: string, kind: MediaKind, now: number): MediaIndexEntry[] {
  return (Object.values(data.media) as MediaIndexEntry[])
    .filter((m) => m.threadId === threadId && m.kind === kind && m.ref.expiresAt > now)
    .sort((x, y) => x.ts - y.ts || x.ref.mediaId.localeCompare(y.ref.mediaId));
}

/**
 * Whether an attachment has expired: the broker said so, or its `expiresAt`
 * has passed on the broker clock.
 */
export function isMediaExpired(ref: MediaRef, data: Pick<FeedData, 'expiredMedia'>, now: number): boolean {
  return ref.mediaId in data.expiredMedia || ref.expiresAt <= now;
}

/** Human label of a node's status and delivery mode. */
export function describeNode(node: SessionNode): { status: string; delivery: string } {
  const status = node.connected ? node.status : 'disconnected';
  return { status, delivery: node.delivery === 'poll' ? 'poll (inbox)' : 'push (channel)' };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local wall-clock time `HH:MM:SS` of a broker timestamp. */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Remaining time until expiry, e.g. `44m 05s`, `9s`, or `expired`. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'expired';
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/**
 * How long ago something happened, coarsely: `just now`, `12m ago`, `5h ago`,
 * `3d ago`. Used for disconnected sessions, which stay for days.
 */
export function formatAgo(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Human file size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Pixels from the bottom within which a list counts as "at the bottom". */
export const FOLLOW_THRESHOLD_PX = 48;

/** Scroll metrics of a list element. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Whether a scroll position is close enough to the bottom to keep following new messages. */
export function isNearBottom(m: ScrollMetrics, threshold: number = FOLLOW_THRESHOLD_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}
