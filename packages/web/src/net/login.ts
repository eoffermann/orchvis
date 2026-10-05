import { LOGIN_PATH, type LoginRequest } from '@orchvis/protocol';

/** Outcome of {@link login}. */
export type LoginResult = { ok: true } | { ok: false; reason: 'bad_token' | 'unreachable' | 'error'; status?: number };

/**
 * Exchanges the Owner token for an HttpOnly session cookie via
 * `POST LOGIN_PATH` with a JSON `{ token }` body. The broker answers `204`
 * with the cookie set, `401` for a wrong token, `400` for a malformed body.
 * The token is sent once and never stored by the app.
 */
export async function login(token: string, fetchFn: typeof fetch = fetch): Promise<LoginResult> {
  let res: Response;
  const body: LoginRequest = { token };
  try {
    res = await fetchFn(LOGIN_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (res.status === 204 || res.ok) return { ok: true };
  if (res.status === 401) return { ok: false, reason: 'bad_token', status: res.status };
  return { ok: false, reason: 'error', status: res.status };
}
