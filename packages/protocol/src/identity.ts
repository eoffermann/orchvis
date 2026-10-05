import { z } from 'zod';

/**
 * Session identifier: `${hostname lowercased}:${CLAUDE_CODE_SESSION_ID}`, or a
 * process-lifetime UUID in place of the session ID when the variable is absent.
 * Only `CLAUDE_CODE_SESSION_ID` identifies the session; other `CLAUDE_*`
 * variables can be inherited from a parent process and must not be used.
 */
export type SessionId = string;

/** Validates a {@link SessionId}: a non-empty host, a colon, a non-empty ID. */
export const SessionIdSchema = z
  .string()
  .max(256)
  .regex(/^[^\s:|]+:[^\s|]+$/, 'expected <hostname>:<session id>');

/** Builds a {@link SessionId} from a hostname and a Claude Code session ID. */
export function makeSessionId(hostname: string, claudeSessionId: string): SessionId {
  return `${hostname.trim().toLowerCase()}:${claudeSessionId.trim()}`;
}

/** Key that stands for the Owner in thread IDs and `to` fields. */
export const OWNER_KEY = 'owner' as const;

/** A message endpoint: one session, or the human Owner. */
export const AddressSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), id: SessionIdSchema }),
  z.object({ kind: z.literal('owner') }),
]);

/** A message endpoint: one session, or the human Owner. */
export type Address = z.infer<typeof AddressSchema>;

/** The Owner's address. */
export const OWNER_ADDRESS: Readonly<Address> = Object.freeze({ kind: 'owner' });

/** Address of a session. */
export function sessionAddress(id: SessionId): Address {
  return { kind: 'session', id };
}

/** Stable string key for an address: the session ID, or {@link OWNER_KEY}. */
export function addressKey(address: Address): string {
  return address.kind === 'owner' ? OWNER_KEY : address.id;
}

/** Inverse of {@link addressKey}. */
export function addressFromKey(key: string): Address {
  return key === OWNER_KEY ? { kind: 'owner' } : { kind: 'session', id: key };
}

/**
 * Thread ID for a pair of participants: their address keys sorted and joined
 * with `|`. The same pair always yields the same ID, in either direction.
 */
export function threadIdFor(a: Address, b: Address): string {
  const keys = [addressKey(a), addressKey(b)].sort();
  return `${keys[0]}|${keys[1]}`;
}

/** Splits a thread ID into its two participants, in sorted order. */
export function threadParticipants(threadId: string): [Address, Address] {
  const parts = threadId.split('|');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`malformed thread id: ${threadId}`);
  }
  return [addressFromKey(parts[0]), addressFromKey(parts[1])];
}

/** Maximum length of a session name. */
export const MAX_NAME_LENGTH = 64;

/** Maximum length of a session's one-line focus. */
export const MAX_FOCUS_LENGTH = 200;

/**
 * Valid session names: letters, digits, `.`, `_`, `@` and `-`, starting with a
 * letter or digit, at most {@link MAX_NAME_LENGTH} characters, and never
 * `owner` in any case.
 */
export const SessionNameSchema = z
  .string()
  .max(MAX_NAME_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._@-]*$/, 'letters, digits, . _ @ - only')
  .refine((name) => name.toLowerCase() !== OWNER_KEY, 'the name "owner" is reserved');

/**
 * Turns arbitrary text, such as `<directory name>@<hostname>`, into a valid
 * session name. Invalid characters become `-`; an empty or reserved result
 * falls back to `session`.
 */
export function sanitizeSessionName(raw: string): string {
  let name = raw
    .trim()
    .replace(/[^A-Za-z0-9._@-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/, '');
  if (!name) name = 'session';
  if (name.toLowerCase() === OWNER_KEY) name = `${name}-session`;
  return name;
}
