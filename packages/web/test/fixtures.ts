import {
  DEFAULT_LIMITS,
  createFrameFactory,
  sessionAddress,
  threadIdFor,
  type BrokerToUiFrame,
  type EdgeStats,
  type MediaIndexEntry,
  type Message,
  type SessionNode,
} from '@orchvis/protocol';

export const T0 = 1_760_000_000_000;

export function frames() {
  return createFrameFactory<BrokerToUiFrame>('t', () => T0);
}

export function node(id: string, patch: Partial<SessionNode> = {}): SessionNode {
  const [host = 'host'] = id.split(':');
  return {
    id,
    hostname: host,
    platform: 'win32',
    name: `n-${id.replace(/[^A-Za-z0-9]/g, '')}`,
    focus: '',
    repos: [{ key: 'github.com/acme/app', name: 'app' }],
    cwd: 'C:/src/app',
    status: 'idle',
    delivery: 'push',
    connected: true,
    lastSeen: T0,
    ...patch,
  };
}

let ulidCounter = 0;
/** A valid ULID, unique per call. */
export function ulid(): string {
  ulidCounter += 1;
  return `01J9ZQ3V5X8K2M4N6P${ulidCounter.toString().padStart(8, '0')}`;
}

export function message(from: string, to: string, ts: number = T0, patch: Partial<Message> = {}): Message & { fromName: string } {
  const f = sessionAddress(from);
  const t = sessionAddress(to);
  return {
    id: ulid(),
    threadId: threadIdFor(f, t),
    from: f,
    fromName: `n-${from.replace(/[^A-Za-z0-9]/g, '')}`,
    to: t,
    senderKind: 'peer',
    kind: 'chat',
    body: 'hello',
    attachments: [],
    ts,
    ...patch,
  };
}

export function edge(a: string, b: string, weight = 1, patch: Partial<EdgeStats> = {}): EdgeStats {
  const threadId = threadIdFor(sessionAddress(a), sessionAddress(b));
  const [x, y] = threadId.split('|') as [string, string];
  return {
    threadId,
    a: x,
    b: y,
    weight,
    updatedAt: T0,
    lastMessageAt: T0,
    sentByA: 1,
    sentByB: 0,
    media: { image: 0, audio: 0, video: 0, other: 0 },
    ...patch,
  };
}

export function mediaEntry(msg: Message, mediaId: string): MediaIndexEntry {
  return {
    ref: {
      mediaId,
      mime: 'image/png',
      filename: 'a.png',
      bytes: 1000,
      sha256: 'a'.repeat(64),
      caption: 'A picture',
      expiresAt: T0 + 60_000,
    },
    kind: 'image',
    threadId: msg.threadId,
    messageId: msg.id,
    from: msg.from,
    ts: msg.ts,
  };
}

export function snapshotFrame(
  mk: ReturnType<typeof frames>,
  parts: { nodes?: SessionNode[]; edges?: EdgeStats[]; messages?: Message[]; media?: MediaIndexEntry[]; now?: number } = {},
): BrokerToUiFrame {
  return mk('snapshot', {
    brokerVersion: 'test',
    protocolVersion: 1,
    now: parts.now ?? T0,
    limits: { ...DEFAULT_LIMITS },
    nodes: parts.nodes ?? [],
    edges: parts.edges ?? [],
    messages: parts.messages ?? [],
    media: parts.media ?? [],
    control: { mutedThreads: [], pausedSessions: [], pausedAll: false },
    mediaStore: { bytes: 0, capBytes: DEFAULT_LIMITS.mediaStoreBytes, files: 0 },
  });
}
