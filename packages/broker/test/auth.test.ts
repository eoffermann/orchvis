import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOGIN_PATH, LOGOUT_PATH, OWNER_COOKIE, WS_CLOSE } from '@orchvis/protocol';
import { LOGIN_FAILURES_PER_MINUTE, WEB_CSP } from '../src/index.js';
import { FakeUi, login, uiHeaders } from './helpers/fake.js';
import { harness } from './helpers/setup.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function postLogin(url: string, body: string, contentType = 'application/json'): Promise<Response> {
  return fetch(`${url}${LOGIN_PATH}`, { method: 'POST', headers: { 'content-type': contentType }, body });
}

describe('POST /api/login', () => {
  it('answers 204 with an opaque HttpOnly, SameSite=Strict, Path=/ session cookie', async () => {
    const h = await harness();
    const res = await postLogin(h.broker.url, JSON.stringify({ token: h.broker.ownerToken }));
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie') ?? '';
    const [pair, ...attrs] = setCookie.split(';').map((s) => s.trim());
    expect(pair?.startsWith(`${OWNER_COOKIE}=`)).toBe(true);
    const value = pair?.slice(OWNER_COOKIE.length + 1) ?? '';
    expect(value.length).toBeGreaterThanOrEqual(32);
    expect(value).not.toContain(h.broker.ownerToken);
    expect(attrs).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Strict', 'Path=/']));
    // Two logins get two different sessions.
    expect(await login(h.broker)).not.toBe(pair);
    expect(h.logs.some((l) => l.includes('"event":"login"'))).toBe(true);
  });

  it('answers 401 for a wrong token and 400 for a malformed body', async () => {
    const h = await harness();
    const wrong = await postLogin(h.broker.url, JSON.stringify({ token: h.broker.shimToken }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'unauthorized' });
    expect(wrong.headers.get('set-cookie')).toBeNull();
    for (const body of ['not json', '{}', JSON.stringify({ token: '' }), JSON.stringify({ token: 5 }), JSON.stringify({ token: 'x'.repeat(600) }), '']) {
      const res = await postLogin(h.broker.url, body);
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid' });
    }
    const huge = await postLogin(h.broker.url, JSON.stringify({ token: 'x'.repeat(10_000) }));
    expect(huge.status).toBe(400);
  });

  it('rate-limits failed logins per remote address, then recovers after a minute', async () => {
    const h = await harness();
    for (let i = 0; i < LOGIN_FAILURES_PER_MINUTE; i++) {
      expect((await postLogin(h.broker.url, JSON.stringify({ token: `guess-${i}` }))).status).toBe(401);
    }
    const limited = await postLogin(h.broker.url, JSON.stringify({ token: h.broker.ownerToken }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
    h.clock.advance(60_001);
    expect((await postLogin(h.broker.url, JSON.stringify({ token: h.broker.ownerToken }))).status).toBe(204);
  });
});

describe('POST /api/logout', () => {
  it('ends the session, clears the cookie, and closes its live feed with 4401', async () => {
    const h = await harness();
    const cookie = await login(h.broker);
    const other = await login(h.broker);
    const { ui } = await FakeUi.connect(h.broker, cookie);
    const { ui: ui2 } = await FakeUi.connect(h.broker, other);
    const res = await fetch(`${h.broker.url}${LOGOUT_PATH}`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${OWNER_COOKIE}=;.*Max-Age=0`));
    expect((await ui.closed).code).toBe(WS_CLOSE.unauthorized);
    expect(await FakeUi.tryConnect(h.broker, uiHeaders(h.broker, cookie))).toBe(WS_CLOSE.unauthorized);
    // Another session is untouched.
    await ui2.sync();
    expect(await FakeUi.tryConnect(h.broker, uiHeaders(h.broker, other))).toBe(101);
    // Logout without a session is harmless.
    expect((await fetch(`${h.broker.url}${LOGOUT_PATH}`, { method: 'POST' })).status).toBe(204);
  });
});

describe('/ws/ui upgrade', () => {
  it('closes with 4401 without a cookie or with a forged one', async () => {
    const h = await harness();
    const origin = h.broker.url;
    expect(await FakeUi.tryConnect(h.broker, { origin })).toBe(WS_CLOSE.unauthorized);
    expect(await FakeUi.tryConnect(h.broker, { origin, cookie: `${OWNER_COOKIE}=forged-session-id` })).toBe(WS_CLOSE.unauthorized);
    expect(await FakeUi.tryConnect(h.broker, { origin, cookie: `${OWNER_COOKIE}=${h.broker.ownerToken}` })).toBe(WS_CLOSE.unauthorized);
  });

  it('closes with 4403 for a cross-origin or Origin-less upgrade, even with a valid cookie', async () => {
    const h = await harness();
    const cookie = await login(h.broker);
    expect(await FakeUi.tryConnect(h.broker, { cookie, origin: 'http://evil.example' })).toBe(WS_CLOSE.forbiddenOrigin);
    expect(await FakeUi.tryConnect(h.broker, { cookie, origin: h.broker.url.replace('127.0.0.1', 'localhost') })).toBe(WS_CLOSE.forbiddenOrigin);
    expect(await FakeUi.tryConnect(h.broker, { cookie })).toBe(WS_CLOSE.forbiddenOrigin);
    expect(h.logs.some((l) => l.includes('"frame":"upgrade"') && l.includes(String(WS_CLOSE.forbiddenOrigin)))).toBe(true);
  });

  it('sends a snapshot with a valid cookie and the right Origin', async () => {
    const h = await harness();
    const { snapshot } = await FakeUi.connect(h.broker);
    expect(snapshot.payload).toMatchObject({ nodes: [], media: [], mediaStore: { bytes: 0, files: 0 } });
  });

  it('closes live feeds with 4503 on shutdown', async () => {
    const h = await harness();
    const { ui } = await FakeUi.connect(h.broker);
    await h.broker.close();
    expect((await ui.closed).code).toBe(WS_CLOSE.shuttingDown);
  });
});

describe('static web app', () => {
  it('serves a placeholder at / with the CSP and nosniff when there is no build', async () => {
    const h = await harness({}, { publicDir: join(tmpdir(), 'orchvis-no-such-public-dir') });
    for (const path of ['/', '/graph/some-route']) {
      const res = await fetch(`${h.broker.url}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(res.headers.get('content-security-policy')).toBe(WEB_CSP);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).not.toMatch(/<script/i);
    }
    expect(WEB_CSP).toContain("script-src 'self'");
    expect(WEB_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('serves the build from publicDir, falls back to index.html for client routes, and never escapes the root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orchvis-public-'));
    dirs.push(root);
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title><script src="/assets/app.js"></script>');
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1);');
    writeFileSync(join(root, '..', 'orchvis-secret.txt'), 'secret');
    const h = await harness({}, { publicDir: root });
    const index = await fetch(`${h.broker.url}/`);
    expect(await index.text()).toContain('<title>app</title>');
    expect(index.headers.get('content-security-policy')).toBe(WEB_CSP);
    const route = await fetch(`${h.broker.url}/thread/a%7Cb`);
    expect(await route.text()).toContain('<title>app</title>');
    const js = await fetch(`${h.broker.url}/assets/app.js`);
    expect(js.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(`${h.broker.url}/assets/missing.js`)).status).toBe(404);
    for (const path of ['/..%2Forchvis-secret.txt', '/%2e%2e/orchvis-secret.txt', '/assets/..%5C..%5Corchvis-secret.txt']) {
      const res = await fetch(`${h.broker.url}${path}`);
      expect(await res.text(), path).not.toContain('secret');
    }
    rmSync(join(root, '..', 'orchvis-secret.txt'), { force: true });
    const api = await fetch(`${h.broker.url}/api/nothing`);
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: 'not_found' });
  });
});
