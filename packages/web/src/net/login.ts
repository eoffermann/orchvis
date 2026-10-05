/** Outcome of {@link login}. */
export type LoginResult = { ok: true } | { ok: false; reason: 'bad_token' | 'unreachable' | 'error'; status?: number };

/**
 * Exchanges the Owner token for an HttpOnly session cookie via
 * `POST /api/login`. The token is sent once and never stored by the app.
 */
export async function login(token: string, fetchFn: typeof fetch = fetch): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetchFn('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'bad_token', status: res.status };
  return { ok: false, reason: 'error', status: res.status };
}
