import { describe, expect, it } from 'vitest';
import {
  BrokerToShimFrameSchema,
  BrokerToUiFrameSchema,
  DEFAULT_LIMITS,
  LimitsSchema,
  MessageSchema,
  ShimToBrokerFrameSchema,
  UiToBrokerFrameSchema,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  mediaKindOf,
  toPeerInfo,
  type BrokerToShimFrame,
  type BrokerToUiFrame,
  type EdgeStats,
  type Message,
  type SessionNode,
  type ShimToBrokerFrame,
  type UiToBrokerFrame,
} from '../src/index.js';

const ULID = '01J9ZQ3V5X8K2M4N6P7R8S9T0V';
const SHA = 'a'.repeat(64);

const node: SessionNode = {
  id: 'mediaroomwindows:1111',
  hostname: 'mediaroomwindows',
  platform: 'win32',
  name: 'ORCH-UI',
  focus: 'web app graph',
  repos: [{ key: 'github.com/acme/orchvis', name: 'orchvis', branch: 'main' }],
  cwd: 'H:/b2cOrcViz',
  status: 'working',
  delivery: 'poll',
  connected: true,
  lastSeen: 1,
};

const message: Message = {
  id: ULID,
  threadId: 'mediaroomwindows:1111|owner',
  from: { kind: 'owner' },
  fromName: 'owner',
  to: { kind: 'session', id: 'mediaroomwindows:1111' },
  senderKind: 'owner',
  kind: 'chat',
  body: 'hello',
  attachments: [
    { mediaId: 'm1', mime: 'image/png', filename: 'shot.png', bytes: 10, sha256: SHA, caption: 'the graph', expiresAt: 9 },
  ],
  ts: 5,
};

const edge: EdgeStats = {
  threadId: message.threadId,
  a: 'mediaroomwindows:1111',
  b: 'owner',
  weight: 1,
  updatedAt: 5,
  lastMessageAt: 5,
  sentByA: 0,
  sentByB: 1,
  media: { image: 1, audio: 0, video: 0, other: 0 },
};

const mediaStore = { bytes: 10, capBytes: DEFAULT_LIMITS.mediaStoreBytes, files: 1 };

function roundTrip<F>(schema: Parameters<typeof decodeFrame>[0], frame: F): F {
  const result = decodeFrame(schema, encodeFrame(frame as never));
  if (!result.ok) throw new Error(result.error);
  return result.frame as F;
}

describe('frame round trips', () => {
  const shim = createFrameFactory<ShimToBrokerFrame>('s', () => 1);
  const toShim = createFrameFactory<BrokerToShimFrame>('b', () => 2);
  const ui = createFrameFactory<UiToBrokerFrame>('u', () => 3);
  const toUi = createFrameFactory<BrokerToUiFrame>('w', () => 4);

  const shimFrames: ShimToBrokerFrame[] = [
    shim('hello', {
      token: 't',
      sessionId: node.id,
      hostname: node.hostname,
      platform: 'win32',
      cwd: 'H:/b2cOrcViz',
      repos: node.repos,
      defaultName: 'b2cOrcViz@mediaroomwindows',
      shimVersion: '0.1.0',
      protocolVersion: 1,
    }),
    shim('register', { name: 'ORCH-UI', focus: 'graph', repos: [] }),
    shim('send', { to: 'ORCH-BROKER', kind: 'request', body: 'hi', replyTo: ULID, attachments: ['m1'] }),
    shim('send', { to: 'owner', kind: 'chat', body: '', attachments: [] }),
    shim('seen', { ids: [ULID] }),
    shim('status', { status: 'blocked' }),
    shim('status', { delivery: 'push' }),
    shim('thread_request', { peer: 'ORCH-BROKER', limit: 50 }),
    shim('ping', {}),
    shim('pong', { re: 'b7' }),
  ];

  const toShimFrames: BrokerToShimFrame[] = [
    toShim('welcome', {
      re: 's1',
      sessionId: node.id,
      name: 'ORCH-UI',
      uploadKey: 'k'.repeat(32),
      limits: { ...DEFAULT_LIMITS },
      peers: [toPeerInfo(node)],
      brokerVersion: '0.1.0',
      protocolVersion: 1,
    }),
    toShim('registered', { re: 's2', sessionId: 'mediaroomwindows:0000', name: 'ORCH-UI-2', peers: [] }),
    toShim('sent', { re: 's3', messageId: ULID, threadId: message.threadId, ts: 5 }),
    toShim('rejected', { re: 's3', code: 'rate_limited', detail: 'slow down' }),
    toShim('deliver', { message }),
    toShim('thread', { re: 's8', threadId: message.threadId, messages: [message] }),
    toShim('peers', { peers: [toPeerInfo(node)] }),
    toShim('ping', {}),
  ];

  const uiFrames: UiToBrokerFrame[] = [
    ui('owner_send', { to: node.id, kind: 'chat', body: 'status?', attachments: [] }),
    ui('control', { action: 'mute_thread', threadId: message.threadId }),
    ui('control', { action: 'pause_session', sessionId: node.id }),
    ui('control', { action: 'pause_all' }),
    ui('pong', { re: 'w1' }),
  ];

  const toUiFrames: BrokerToUiFrame[] = [
    toUi('snapshot', {
      brokerVersion: '0.1.0',
      protocolVersion: 1,
      now: 6,
      limits: { ...DEFAULT_LIMITS },
      nodes: [node],
      edges: [edge],
      messages: [message],
      media: [{ ref: message.attachments[0]!, kind: 'image', threadId: message.threadId, messageId: ULID, from: message.from, ts: 5 }],
      control: { mutedThreads: [], pausedSessions: [], pausedAll: false },
      mediaStore,
    }),
    toUi('node', { op: 'upsert', node }),
    toUi('node', { op: 'remove', id: node.id }),
    toUi('message', { message, edge }),
    toUi('message', { message: { ...message, seenAt: 6 }, edge }),
    toUi('seen', { by: node.id, ids: [ULID], seenAt: 7 }),
    toUi('media', { op: 'expire', mediaId: 'm1', threadId: message.threadId, edge, mediaStore }),
    toUi('control_state', { mutedThreads: [message.threadId], pausedSessions: [], pausedAll: true }),
    toUi('rejected', { re: 'u1', code: 'unknown_recipient', detail: '' }),
  ];

  it.each(shimFrames.map((f) => [f.type, f] as const))('shim -> broker %s', (_t, f) => {
    expect(roundTrip(ShimToBrokerFrameSchema, f)).toEqual(f);
  });
  it.each(toShimFrames.map((f) => [f.type, f] as const))('broker -> shim %s', (_t, f) => {
    expect(roundTrip(BrokerToShimFrameSchema, f)).toEqual(f);
  });
  it.each(uiFrames.map((f) => [f.type, f] as const))('web -> broker %s', (_t, f) => {
    expect(roundTrip(UiToBrokerFrameSchema, f)).toEqual(f);
  });
  it.each(toUiFrames.map((f) => [f.type, f] as const))('broker -> web %s', (_t, f) => {
    expect(roundTrip(BrokerToUiFrameSchema, f)).toEqual(f);
  });

  it('numbers frame IDs per factory', () => {
    const mk = createFrameFactory<ShimToBrokerFrame>('x');
    expect(mk('ping', {}).id).toBe('x1');
    expect(mk('ping', {}).id).toBe('x2');
  });
});

describe('decodeFrame rejections', () => {
  it('rejects invalid JSON without throwing', () => {
    expect(decodeFrame(ShimToBrokerFrameSchema, '{nope')).toMatchObject({ ok: false, id: '' });
  });

  it('rejects another protocol version and keeps the frame ID', () => {
    const raw = JSON.stringify({ v: 2, type: 'ping', id: 'f1', ts: 0, payload: {} });
    expect(decodeFrame(ShimToBrokerFrameSchema, raw)).toMatchObject({ ok: false, id: 'f1' });
  });

  it('rejects a frame type from the wrong direction', () => {
    const raw = JSON.stringify({ v: 1, type: 'deliver', id: 'f2', ts: 0, payload: { message } });
    expect(decodeFrame(ShimToBrokerFrameSchema, raw).ok).toBe(false);
  });

  it('rejects a shim frame that tries to set sender fields', () => {
    const raw = JSON.stringify({ v: 1, type: 'owner_send', id: 'f3', ts: 0, payload: { to: node.id, kind: 'chat', body: 'x', attachments: [] } });
    expect(decodeFrame(ShimToBrokerFrameSchema, raw).ok).toBe(false);
  });

  it('rejects an empty status', () => {
    const raw = JSON.stringify({ v: 1, type: 'status', id: 'f4', ts: 0, payload: {} });
    expect(decodeFrame(ShimToBrokerFrameSchema, raw).ok).toBe(false);
  });

  it('rejects a reserved register name', () => {
    const raw = JSON.stringify({ v: 1, type: 'register', id: 'f5', ts: 0, payload: { name: 'owner', focus: '', repos: [] } });
    expect(decodeFrame(ShimToBrokerFrameSchema, raw).ok).toBe(false);
  });

  it('rejects too many attachments', () => {
    const raw = JSON.stringify({
      v: 1, type: 'send', id: 'f6', ts: 0,
      payload: { to: 'x', kind: 'chat', body: '', attachments: Array.from({ length: 11 }, (_, i) => `m${i}`) },
    });
    expect(decodeFrame(ShimToBrokerFrameSchema, raw).ok).toBe(false);
  });

  it('does not echo the body in the error', () => {
    const raw = JSON.stringify({ v: 1, type: 'send', id: 'f7', ts: 0, payload: { to: '', kind: 'chat', body: 'SECRET-BODY', attachments: [] } });
    const result = decodeFrame(ShimToBrokerFrameSchema, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('SECRET-BODY');
  });
});

describe('model', () => {
  it('keeps cwd away from peers', () => {
    const peer = toPeerInfo(node);
    expect('cwd' in peer).toBe(false);
    expect(peer.name).toBe(node.name);
  });

  it('requires fromName on a message', () => {
    const { fromName: _f, ...rest } = message;
    expect(MessageSchema.safeParse(rest).success).toBe(false);
  });

  it('requires a caption on media', () => {
    const bad = { ...message, attachments: [{ ...message.attachments[0], caption: '' }] };
    expect(MessageSchema.safeParse(bad).success).toBe(false);
  });

  it('requires a ULID message ID', () => {
    expect(MessageSchema.safeParse({ ...message, id: 'not-a-ulid' }).success).toBe(false);
  });

  it('classifies MIME types', () => {
    expect(mediaKindOf('image/png')).toBe('image');
    expect(mediaKindOf('AUDIO/ogg')).toBe('audio');
    expect(mediaKindOf('video/mp4')).toBe('video');
    expect(mediaKindOf('application/pdf')).toBe('other');
    expect(mediaKindOf('')).toBe('other');
  });

  it('has valid default limits matching the plan', () => {
    expect(LimitsSchema.parse(DEFAULT_LIMITS)).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS.maxBodyBytes).toBe(16384);
    expect(DEFAULT_LIMITS.ringBufferPerThread).toBe(500);
    expect(DEFAULT_LIMITS.mediaTtlMs).toBe(45 * 60_000);
    expect(DEFAULT_LIMITS.sendRatePerMinute).toBe(30);
  });
});
