/** Unicode format characters (category Cf): zero-width spaces, joiners, BOM, tag characters. */
const FORMAT_CHAR = /^\p{Cf}$/u;

/** Unicode whitespace. */
const WHITESPACE = /^\s$/u;

/** Characters that would continue a tag name past `channel`. */
const NAME_CHAR = /^[A-Za-z0-9_-]$/;

/** C0 and C1 control characters, except tab, line feed and carriage return. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const TAG_NAME = 'channel';

/** Code point at `i` and its length in UTF-16 units. */
function charAt(text: string, i: number): [string, number] {
  const cp = text.codePointAt(i) ?? 0;
  const ch = String.fromCodePoint(cp);
  return [ch, ch.length];
}

/**
 * Whether the text after a `<` at `pos - 1` reads as a channel open or close
 * tag: optional whitespace, an optional `/`, optional whitespace, then
 * `channel` in any case, not followed by another name character. Format
 * characters are ignored anywhere in that span, so `<​channel` and
 * `<chan​nel` count.
 */
function beginsChannelTag(text: string, pos: number): boolean {
  let i = pos;
  let slashSeen = false;
  while (i < text.length) {
    const [ch, len] = charAt(text, i);
    if (WHITESPACE.test(ch) || FORMAT_CHAR.test(ch)) {
      i += len;
    } else if (ch === '/' && !slashSeen) {
      slashSeen = true;
      i += len;
    } else {
      break;
    }
  }
  let matched = 0;
  while (i < text.length && matched < TAG_NAME.length) {
    const [ch, len] = charAt(text, i);
    i += len;
    if (FORMAT_CHAR.test(ch)) continue;
    if (ch.toLowerCase() !== TAG_NAME[matched]) return false;
    matched++;
  }
  if (matched < TAG_NAME.length) return false;
  while (i < text.length) {
    const [ch, len] = charAt(text, i);
    i += len;
    if (FORMAT_CHAR.test(ch)) continue;
    return !NAME_CHAR.test(ch);
  }
  return true;
}

/**
 * Escapes every `<` that begins a channel open or close tag as `&lt;`, so no
 * sender can forge a channel tag inside another session's context. Whitespace,
 * one `/` and Unicode format characters (zero-width spaces and the like) are
 * skipped while matching, and case is ignored. Idempotent: escaping twice gives
 * the same result as escaping once, so the shim's second pass is harmless.
 *
 * Known gap, accepted: homoglyphs such as Cyrillic `с` in `channel` are not
 * matched.
 */
export function escapeChannelTags(text: string): string {
  let out = '';
  let last = 0;
  for (let i = text.indexOf('<'); i !== -1; i = text.indexOf('<', i + 1)) {
    if (beginsChannelTag(text, i + 1)) {
      out += `${text.slice(last, i)}&lt;`;
      last = i + 1;
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Removes control characters other than tab, line feed and carriage return.
 * Format characters are kept, since emoji sequences need the zero-width
 * joiner; {@link escapeChannelTags} sees through them instead.
 */
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
