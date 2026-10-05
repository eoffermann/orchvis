import {
  DEFAULT_LIMITS,
  type BrokerToUiFrame,
  type FrameOf,
  type MediaIndexEntry,
  type MediaStoreUsage,
} from '@orchvis/protocol';
import type { AppState, ConnectionStatus, FeedData, Filters, Selection, StoreMessage } from './types';

/** Everything that can change the client state. */
export type Action =
  /** A validated frame from `/ws/ui`. `receivedAt` is the local clock on arrival. */
  | { type: 'frame'; frame: BrokerToUiFrame; receivedAt: number }
  /** The connection changed state. Leaving `open` drops sync until the next snapshot. */
  | { type: 'connection'; status: ConnectionStatus }
  /** The 1 s decay timer (and any other clock read). `localNow` is `Date.now()`. */
  | { type: 'tick'; localNow: number }
  /** The Owner selected something, or cleared the selection. */
  | { type: 'select'; selection: Selection | null }
  /** The pointer entered or left a node. */
  | { type: 'hover'; nodeId: string | null }
  /** The top-bar filters changed. */
  | { type: 'filters'; filters: Filters };

const EMPTY_MEDIA_STORE: MediaStoreUsage = { bytes: 0, capBytes: DEFAULT_LIMITS.mediaStoreBytes, files: 0 };

/** Broker data before any snapshot. */
export function emptyFeedData(): FeedData {
  return {
    brokerVersion: '',
    limits: { ...DEFAULT_LIMITS },
    nodes: {},
    edges: {},
    messages: {},
    messageThread: {},
    media: {},
    expiredMedia: {},
    control: { mutedThreads: [], pausedSessions: [], pausedAll: false },
    mediaStore: EMPTY_MEDIA_STORE,
    lastRejection: null,
  };
}

/** The state at page load. `localNow` seeds the clock. */
export function initialState(localNow: number = Date.now()): AppState {
  return {
    connection: 'idle',
    synced: false,
    everSynced: false,
    clockOffsetMs: 0,
    now: localNow,
    data: emptyFeedData(),
    view: { selection: null, hoverNodeId: null, filters: { repos: [], hosts: [] } },
  };
}

/**
 * The client state reducer. Pure: it never mutates `state` and has no side
 * effects, so it runs the same under React, in tests, and in a worker.
 */
export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'connection': {
      const synced = action.status === 'open' ? state.synced : false;
      if (state.connection === action.status && state.synced === synced) return state;
      return { ...state, connection: action.status, synced };
    }
    case 'tick': {
      const now = action.localNow + state.clockOffsetMs;
      return now === state.now ? state : { ...state, now };
    }
    case 'select':
      return { ...state, view: { ...state.view, selection: action.selection } };
    case 'hover':
      if (state.view.hoverNodeId === action.nodeId) return state;
      return { ...state, view: { ...state.view, hoverNodeId: action.nodeId } };
    case 'filters':
      return { ...state, view: { ...state.view, filters: action.filters } };
    case 'frame':
      return applyFrame(state, action.frame, action.receivedAt);
  }
}

function applyFrame(state: AppState, frame: BrokerToUiFrame, receivedAt: number): AppState {
  if (frame.type === 'snapshot') return applySnapshot(state, frame, receivedAt);
  // Before the snapshot on this connection, deltas are stale or premature: the
  // snapshot that follows contains their effect.
  if (!state.synced) return state;
  switch (frame.type) {
    case 'node':
      return applyNode(state, frame);
    case 'message':
      return applyMessage(state, frame);
    case 'seen':
      return applySeen(state, frame);
    case 'media':
      return applyMedia(state, frame);
    case 'control_state':
      return withData(state, { control: frame.payload });
    case 'rejected':
      return withData(state, { lastRejection: { ...frame.payload } });
    case 'sent':
    case 'ping':
    case 'pong':
      return state;
  }
}

function withData(state: AppState, patch: Partial<FeedData>): AppState {
  return { ...state, data: { ...state.data, ...patch } };
}

function applySnapshot(state: AppState, frame: FrameOf<BrokerToUiFrame, 'snapshot'>, receivedAt: number): AppState {
  const p = frame.payload;
  const cap = p.limits.ringBufferPerThread;
  const messages: Record<string, StoreMessage[]> = {};
  const messageThread: Record<string, string> = {};
  for (const m of p.messages) {
    const list = (messages[m.threadId] ??= []);
    list.push(m);
    messageThread[m.id] = m.threadId;
  }
  for (const [threadId, list] of Object.entries(messages)) {
    if (list.length > cap) {
      for (const dropped of list.splice(0, list.length - cap)) delete messageThread[dropped.id];
      messages[threadId] = list;
    }
  }
  const media: Record<string, MediaIndexEntry> = Object.fromEntries(p.media.map((m) => [m.ref.mediaId, m]));
  // The snapshot lists every unexpired item, so any attachment it leaves out
  // has expired.
  const expiredMedia: Record<string, true> = {};
  for (const list of Object.values(messages)) {
    for (const m of list) for (const a of m.attachments) if (!(a.mediaId in media)) expiredMedia[a.mediaId] = true;
  }
  const data: FeedData = {
    brokerVersion: p.brokerVersion,
    limits: p.limits,
    nodes: Object.fromEntries(p.nodes.map((n) => [n.id, n])),
    edges: Object.fromEntries(p.edges.map((e) => [e.threadId, e])),
    messages,
    messageThread,
    media,
    expiredMedia,
    control: p.control,
    mediaStore: p.mediaStore,
    lastRejection: null,
  };
  const clockOffsetMs = p.now - receivedAt;
  const next: AppState = {
    ...state,
    synced: true,
    everSynced: true,
    clockOffsetMs,
    now: p.now,
    data,
  };
  return pruneView(next);
}

/** Drops a selection or hover that points at something no longer present. */
function pruneView(state: AppState): AppState {
  const { selection, hoverNodeId } = state.view;
  const { nodes, edges } = state.data;
  let keepSelection = true;
  if (selection?.kind === 'node') keepSelection = selection.id in nodes;
  else if (selection) keepSelection = selection.threadId in edges;
  const keepHover = hoverNodeId === null || hoverNodeId in nodes;
  if (keepSelection && keepHover) return state;
  return {
    ...state,
    view: {
      ...state.view,
      selection: keepSelection ? selection : null,
      hoverNodeId: keepHover ? hoverNodeId : null,
    },
  };
}

/** Whether a thread ID names the given participant key. */
function threadHas(threadId: string, key: string): boolean {
  return threadId.split('|').includes(key);
}

/**
 * `node {op:'remove'}` is a purge: the node, every thread it took part in (edge,
 * buffered messages, media index entries, tombstones) and any control naming
 * them go, so the state still equals a fresh snapshot.
 */
function applyNode(state: AppState, frame: FrameOf<BrokerToUiFrame, 'node'>): AppState {
  const p = frame.payload;
  if (p.op === 'upsert') {
    return withData(state, { nodes: { ...state.data.nodes, [p.node.id]: p.node } });
  }
  const d = state.data;
  const gone = new Set(
    [...Object.keys(d.edges), ...Object.keys(d.messages)].filter((threadId) => threadHas(threadId, p.id)),
  );
  if (!(p.id in d.nodes) && gone.size === 0) return state;

  const nodes = { ...d.nodes };
  delete nodes[p.id];
  const edges = { ...d.edges };
  const messages = { ...d.messages };
  const messageThread = { ...d.messageThread };
  const expiredMedia = { ...d.expiredMedia };
  for (const threadId of gone) {
    delete edges[threadId];
    for (const m of messages[threadId] ?? []) {
      delete messageThread[m.id];
      for (const a of m.attachments) delete expiredMedia[a.mediaId];
    }
    delete messages[threadId];
  }
  const media = Object.fromEntries(Object.entries(d.media).filter(([, e]) => !gone.has(e.threadId)));
  const control = {
    ...d.control,
    mutedThreads: d.control.mutedThreads.filter((t) => !gone.has(t)),
    pausedSessions: d.control.pausedSessions.filter((s) => s !== p.id),
  };
  return pruneView(withData(state, { nodes, edges, messages, messageThread, media, expiredMedia, control }));
}

function applyMessage(state: AppState, frame: FrameOf<BrokerToUiFrame, 'message'>): AppState {
  const { message, edge } = frame.payload;
  if (message.id in state.data.messageThread) {
    return withData(state, { edges: { ...state.data.edges, [edge.threadId]: edge } });
  }
  const cap = state.data.limits.ringBufferPerThread;
  const prev = state.data.messages[message.threadId] ?? [];
  let list: StoreMessage[] = [...prev, message];
  const messageThread: Record<string, string> = { ...state.data.messageThread, [message.id]: message.threadId };
  if (list.length > cap) {
    const dropped = list.slice(0, list.length - cap);
    list = list.slice(list.length - cap);
    for (const d of dropped) delete messageThread[d.id];
  }
  return withData(state, {
    messages: { ...state.data.messages, [message.threadId]: list },
    messageThread,
    edges: { ...state.data.edges, [edge.threadId]: edge },
  });
}

function applySeen(state: AppState, frame: FrameOf<BrokerToUiFrame, 'seen'>): AppState {
  const { seenAt } = frame.payload;
  const byThread = new Map<string, Set<string>>();
  for (const id of frame.payload.ids) {
    const threadId = state.data.messageThread[id];
    if (threadId === undefined) continue;
    let ids = byThread.get(threadId);
    if (!ids) byThread.set(threadId, (ids = new Set()));
    ids.add(id);
  }
  if (byThread.size === 0) return state;
  const messages = { ...state.data.messages };
  for (const [threadId, ids] of byThread) {
    const list = messages[threadId];
    if (!list) continue;
    messages[threadId] = list.map((m) => (ids.has(m.id) && m.seenAt === undefined ? { ...m, seenAt } : m));
  }
  return withData(state, { messages });
}

function applyMedia(state: AppState, frame: FrameOf<BrokerToUiFrame, 'media'>): AppState {
  const p = frame.payload;
  const edges = { ...state.data.edges, [p.edge.threadId]: p.edge };
  const media = { ...state.data.media };
  let expiredMedia = state.data.expiredMedia;
  if (p.op === 'add') {
    media[p.entry.ref.mediaId] = p.entry;
  } else {
    delete media[p.mediaId];
    expiredMedia = { ...expiredMedia, [p.mediaId]: true };
  }
  const next = withData(state, { media, expiredMedia, edges, mediaStore: p.mediaStore });
  return pruneView(next);
}
