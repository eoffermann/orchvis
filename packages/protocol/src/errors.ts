import { z } from 'zod';

/**
 * Codes the broker uses to reject a frame. The first seven come from the plan;
 * `invalid` covers malformed frames, a wrong protocol version, an invalid name,
 * and a message to oneself.
 */
export const RejectCodeSchema = z.enum([
  'unauthorized',
  'unknown_recipient',
  'too_large',
  'rate_limited',
  'muted',
  'paused',
  'recipient_gone',
  'invalid',
]);

/** A broker rejection code. */
export type RejectCode = z.infer<typeof RejectCodeSchema>;

/**
 * Plain explanation for each rejection code, for tool results shown to a
 * session. The volume rules in the SKILL depend on these staying accurate.
 */
export const REJECT_EXPLANATIONS: Readonly<Record<RejectCode, string>> = Object.freeze({
  unauthorized: 'The broker did not accept this connection or token.',
  unknown_recipient: 'No session with that name or ID is known to the broker. Call list_peers to see who is connected.',
  too_large: 'The message or attachment is over the size limit.',
  rate_limited: 'Too many messages to this recipient in the last minute. Stop sending and continue local work.',
  muted: 'The Owner has muted this thread. Stop sending on it and continue local work.',
  paused: 'The Owner has paused peer traffic. Stop sending and continue local work.',
  recipient_gone: 'The recipient has been disconnected for too long, and messages are no longer queued for it. Its history stays readable with get_thread.',
  invalid: 'The request was malformed or not allowed.',
});
