import { randomBytes } from 'node:crypto';
import { MessageSchema, threadIdFor, type Address, type MediaRef, type Message } from '@orchvis/protocol';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A valid ULID: 10 time characters, 16 random. */
export function ulid(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return time + rand;
}

/** A schema-valid media ref. */
export function makeRef(overrides: Partial<MediaRef> = {}): MediaRef {
  return {
    mediaId: `m${randomBytes(6).toString('hex')}`,
    mime: 'image/png',
    filename: 'shot.png',
    bytes: 4,
    sha256: '0'.repeat(64),
    caption: 'A screenshot of the failing build',
    expiresAt: Date.now() + 45 * 60_000,
    ...overrides,
  };
}

/** A schema-valid message from `from` to `to`. */
export function makeMessage(
  overrides: Partial<Message> & { from?: Address; to?: Address } = {},
): Message {
  const from = overrides.from ?? { kind: 'session', id: 'peerhost:peer-1' };
  const to = overrides.to ?? { kind: 'session', id: 'testhost:abc' };
  const message: Message = {
    id: ulid(),
    threadId: threadIdFor(from, to),
    from,
    fromName: 'PEER',
    to,
    senderKind: from.kind === 'owner' ? 'owner' : 'peer',
    kind: 'chat',
    body: 'hello there',
    attachments: [],
    ts: Date.now(),
    ...overrides,
  };
  return MessageSchema.parse(message);
}
