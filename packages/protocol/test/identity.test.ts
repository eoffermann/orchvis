import { describe, expect, it } from 'vitest';
import {
  OWNER_ADDRESS,
  SessionIdSchema,
  SessionNameSchema,
  addressFromKey,
  addressKey,
  makeSessionId,
  sanitizeSessionName,
  sessionAddress,
  threadIdFor,
  threadParticipants,
} from '../src/index.js';

describe('session IDs', () => {
  it('lowercases the hostname', () => {
    expect(makeSessionId('MediaRoomWindows', '3f2a-uuid')).toBe('mediaroomwindows:3f2a-uuid');
  });

  it('validates the host:id form', () => {
    expect(SessionIdSchema.safeParse('host:abc').success).toBe(true);
    expect(SessionIdSchema.safeParse('host').success).toBe(false);
    expect(SessionIdSchema.safeParse(':abc').success).toBe(false);
    expect(SessionIdSchema.safeParse('a|b:c').success).toBe(false);
  });
});

describe('thread IDs', () => {
  const a = sessionAddress('host:aaa');
  const b = sessionAddress('host:bbb');

  it('is the same in both directions', () => {
    expect(threadIdFor(a, b)).toBe(threadIdFor(b, a));
    expect(threadIdFor(a, b)).toBe('host:aaa|host:bbb');
  });

  it('uses the owner key for Owner threads', () => {
    expect(threadIdFor(OWNER_ADDRESS, a)).toBe(threadIdFor(a, OWNER_ADDRESS));
    expect(threadIdFor(OWNER_ADDRESS, a)).toContain('owner');
  });

  it('round-trips through threadParticipants', () => {
    const [x, y] = threadParticipants(threadIdFor(b, OWNER_ADDRESS));
    expect([addressKey(x), addressKey(y)].sort()).toEqual(['host:bbb', 'owner']);
  });

  it('rejects malformed thread IDs', () => {
    expect(() => threadParticipants('nope')).toThrow();
    expect(() => threadParticipants('a|')).toThrow();
  });

  it('maps keys back to addresses', () => {
    expect(addressFromKey('owner')).toEqual({ kind: 'owner' });
    expect(addressFromKey('h:1')).toEqual({ kind: 'session', id: 'h:1' });
  });
});

describe('session names', () => {
  it.each([['ORCH-UI'], ['b2cOrcViz@mediaroomwindows'], ['a.b_c-d'], ['x1']])('accepts %j', (name) => {
    expect(SessionNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([[''], ['owner'], ['Owner'], ['-lead'], ['has space'], ['a'.repeat(65)], ['tag<']])('rejects %j', (name) => {
    expect(SessionNameSchema.safeParse(name).success).toBe(false);
  });

  it.each([
    ['My Project@MediaRoom', 'My-Project@MediaRoom'],
    ['  --weird//name!!  ', 'weird-name'],
    ['', 'session'],
    ['!!!', 'session'],
    ['owner', 'owner-session'],
  ])('sanitizes %j to %j', (raw, name) => {
    expect(sanitizeSessionName(raw)).toBe(name);
    expect(SessionNameSchema.safeParse(sanitizeSessionName(raw)).success).toBe(true);
  });

  it('always produces a valid name', () => {
    for (const raw of ['日本語@host', 'a'.repeat(200), '.hidden', 'OWNER', '@@@']) {
      expect(SessionNameSchema.safeParse(sanitizeSessionName(raw)).success, raw).toBe(true);
    }
  });
});
