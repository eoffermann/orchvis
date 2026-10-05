import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { OWNER_COOKIE, WS_CLOSE } from '@orchvis/protocol';

/** Failed logins allowed per remote address per rolling minute; further attempts get `429 rate_limited`. */
export const LOGIN_FAILURES_PER_MINUTE = 10;

/** Owner login sessions kept at once; the oldest is dropped beyond this. */
export const MAX_OWNER_SESSIONS = 64;

/** Parses a `Cookie` header into name/value pairs. Malformed pairs are skipped; the first of a repeated name wins. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * In-memory Owner login sessions. Each is an opaque random ID carried in the
 * {@link OWNER_COOKIE}; the Owner token itself never goes in a cookie.
 * Sessions live until logout or broker restart.
 */
export class OwnerSessions {
  private readonly ids = new Set<string>();

  /** Starts a session and returns its ID, dropping the oldest beyond {@link MAX_OWNER_SESSIONS}. */
  create(): string {
    const id = randomBytes(32).toString('base64url');
    this.ids.add(id);
    while (this.ids.size > MAX_OWNER_SESSIONS) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
    return id;
  }

  /** Ends a session. Returns whether it existed. */
  delete(id: string): boolean {
    return this.ids.delete(id);
  }

  /** The live session ID in a request's Owner cookie, or undefined. */
  fromHeaders(headers: IncomingHttpHeaders): string | undefined {
    const id = parseCookies(headers.cookie).get(OWNER_COOKIE);
    return id !== undefined && this.ids.has(id) ? id : undefined;
  }

  /** Number of live sessions. */
  get size(): number {
    return this.ids.size;
  }
}

/** `Set-Cookie` value that starts an Owner session. */
export function ownerCookie(sessionId: string): string {
  return `${OWNER_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`;
}

/** `Set-Cookie` value that clears the Owner cookie. */
export function clearedOwnerCookie(): string {
  return `${OWNER_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Verdict on a `/ws/ui` upgrade: the Owner session to bind, or the close code to send after accepting. */
export type UiUpgradeVerdict = { ok: true; ownerSession: string } | { ok: false; code: number; reason: string };

/**
 * Decides a `/ws/ui` upgrade. The Origin must equal the broker's own origin,
 * `http://<Host header>` (compared case-insensitively); a missing Origin is
 * refused too, since browsers always send one. Then the {@link OWNER_COOKIE}
 * must name a live Owner session. The Origin is checked first, so a
 * cross-site page learns nothing about the cookie.
 */
export function uiUpgradeVerdict(headers: IncomingHttpHeaders, sessions: OwnerSessions): UiUpgradeVerdict {
  const origin = headers.origin;
  const host = headers.host;
  if (!origin || !host || origin.toLowerCase() !== `http://${host}`.toLowerCase()) {
    return { ok: false, code: WS_CLOSE.forbiddenOrigin, reason: 'origin not allowed' };
  }
  const ownerSession = sessions.fromHeaders(headers);
  if (!ownerSession) return { ok: false, code: WS_CLOSE.unauthorized, reason: 'login required' };
  return { ok: true, ownerSession };
}
