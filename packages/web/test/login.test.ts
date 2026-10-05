import { LOGIN_PATH } from '@orchvis/protocol';
import { describe, expect, it, vi } from 'vitest';
import { login } from '../src/net/login';

function fetchReturning(status: number) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(status === 204 ? null : '{}', { status }));
}

describe('login', () => {
  it('POSTs {token} as JSON to LOGIN_PATH and treats 204 as success', async () => {
    const f = fetchReturning(204);
    expect(await login('secret', f as unknown as typeof fetch)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(LOGIN_PATH);
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(JSON.parse(String(init?.body))).toEqual({ token: 'secret' });
  });

  it('maps 401 to bad_token, other statuses to error, and network failure to unreachable', async () => {
    expect(await login('x', fetchReturning(401) as unknown as typeof fetch)).toEqual({ ok: false, reason: 'bad_token', status: 401 });
    expect(await login('x', fetchReturning(400) as unknown as typeof fetch)).toEqual({ ok: false, reason: 'error', status: 400 });
    const failing = vi.fn(async () => {
      throw new TypeError('network');
    });
    expect(await login('x', failing as unknown as typeof fetch)).toEqual({ ok: false, reason: 'unreachable' });
  });
});
