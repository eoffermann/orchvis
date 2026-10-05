/**
 * Matches a `<` that begins a channel open or close tag, such as `<channel`,
 * `</channel` or `< / Channel`. Case-insensitive.
 */
const CHANNEL_TAG_START = /<(?=\s*\/?\s*channel(?![A-Za-z0-9_-]))/gi;

/** C0 and C1 control characters, except tab, line feed and carriage return. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Escapes every `<` that begins a channel tag as `&lt;`, so no sender can
 * forge a channel tag inside another session's context. Idempotent: escaping
 * twice gives the same result as escaping once, so the shim's second pass is
 * harmless.
 */
export function escapeChannelTags(text: string): string {
  return text.replace(CHANNEL_TAG_START, '&lt;');
}

/** Removes control characters other than tab, line feed and carriage return. */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/**
 * Sanitizes untrusted text (bodies, captions, filenames): strips control
 * characters first, so they cannot hide a tag, then escapes channel tags.
 */
export function sanitizeText(text: string): string {
  return escapeChannelTags(stripControlChars(text));
}
