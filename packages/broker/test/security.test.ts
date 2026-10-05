/**
 * WP9 security cases not covered elsewhere: path traversal in upload
 * filenames and media IDs, oversized WebSocket frames, Owner credentials
 * offered on the shim side, a missing credential on every authenticated
 * endpoint, and a peer claiming the Owner's name. The full map of security
 * cases to tests is docs/security-tests.md.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  BrokerToShimFrameSchema,
  DEFAULT_LIMITS,
  type MediaRef,
  LOGIN_PATH,
  LOGOUT_PATH,
  MEDIA_PATH,
  OWNER_COOKIE,
  SHIM_WS_PATH,
  UI_WS_PATH,
  WS_CLOSE,
} from '@orchvis/protocol';
import { FakeShim, FakeUi, helloPayload, login, uiHeaders } from './helpers/fake.js';
import { dirFiles, download, png, shimCreds, upload, uploadOk, type Creds } from './helpers/media.js';
import { harness } from './helpers/setup.js';

const NUL = String.fromCharCode(0);

/** The broker's WebSocket frame cap, as set in server.ts. */
const MAX_PAYLOAD = Math.max(1024 * 1024, DEFAULT_LIMITS.maxBodyBytes * 8);

async function health(url: string): Promise<{ ok: boolean }> {
  return (await (await fetch(`${url}/healthz`)).json()) as { ok: boolean };
}

/** Opens a raw socket, sends `frames` (each possibly a fragment), and resolves with the close code. */
async function closeCodeAfter(url: string, headers: Record<string, string>, send: (ws: WebSocket) => void): Promise<number> {
  const ws = new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  // A UI socket gets its snapshot first; ignore every inbound frame.
  return new Promise<number>((resolve) => {
    ws.once('close', (code) => resolve(code));
    ws.once('error', () => {});
    send(ws);
  });
}

describe('path traversal', () => {
  it('an upload filename never reaches the disk: only the media ID names the file, and the stored name is one plain component', async () => {
    const h = await harness();
    const { welcome } = await h.shim('host:a');
    const creds = shimCreds(h.broker, welcome);
    const parent = dirname(h.broker.mediaDir);
    const names = ['../../evil.txt', '..\\..\\evil.txt', 'C:\\Windows\\System32\\evil.txt', '/etc/evil.txt', '..', '.', 'a/../../evil.txt', `evil${NUL}.txt`];
    const results = [];
    for (const filename of names) {
      results.push(await upload(h.broker, creds, [{ data: Buffer.from('plain text\n'), mime: 'text/plain', filename }], 'traversal probe'));
    }
    // Path parts are dropped, "." and ".." become "file", and a NUL in the part header fails the multipart parse (400).
    expect(results.map((r) => [r.status, r.body['filename'] ?? r.body['error']])).toEqual([
      [201, 'evil.txt'],
      [201, 'evil.txt'],
      [201, 'evil.txt'],
      [201, 'evil.txt'],
      [201, 'file'],
      [201, 'file'],
      [201, 'evil.txt'],
      [400, 'invalid'],
    ]);
    const refs = results.filter((r) => r.status === 201).map((r) => r.body as unknown as MediaRef);
    for (const ref of refs) {
      expect(ref.filename).not.toMatch(/[\\/]/);
      expect(ref.filename).not.toContain(NUL);
      expect(['.', '..']).not.toContain(ref.filename);
    }
    // Exactly one file per accepted upload, named by its media ID; nothing written beside the media directory.
    expect(dirFiles(h.broker)).toEqual(refs.map((r) => r.mediaId).sort());
    for (const r of refs) expect(r.mediaId).toMatch(/^m[A-Za-z0-9_-]{24}$/);
    for (const dir of [parent, dirname(parent), h.broker.mediaDir]) expect(existsSync(join(dir, 'evil.txt'))).toBe(false);
    expect(readdirSync(h.broker.mediaDir).every((f) => /^m[A-Za-z0-9_-]{24}$/.test(f))).toBe(true);
  });

  it('a media ID with path segments or dot-dot is 404 even for the Owner, and never reads outside the store', async () => {
    const h = await harness();
    const { shim: a, welcome } = await h.shim('host:a');
    await a.register('ALPHA');
    const ref = await uploadOk(h.broker, shimCreds(h.broker, welcome), png());
    const owner: Creds = { cookie: await login(h.broker) };
    expect((await download(h.broker, ref.mediaId, owner)).status).toBe(200);
    const probes = [
      '..',
      '../package.json',
      '..\\package.json',
      `../${ref.mediaId}`,
      `x/../${ref.mediaId}`,
      `${ref.mediaId}/..`,
      `${ref.mediaId}${NUL}`,
      `./${ref.mediaId}`,
      h.broker.mediaDir,
      join(h.broker.mediaDir, ref.mediaId),
    ];
    for (const id of probes) {
      const res = await download(h.broker, id, owner);
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    // Traversal in the raw URL path never serves a file from outside: here, the broker's own package.json
    // beside its default public directory. (fetch normalizes plain ../ segments; encoded ones reach the broker.)
    for (const raw of ['/api/media/../../package.json', '/api/media/%2e%2e/%2e%2e/package.json', '/api/media/..%2f..%2fpackage.json', '/api/media/..%5c..%5cpackage.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/..%5cpackage.json']) {
      const res = await fetch(`${h.broker.url}${raw}`, { headers: { cookie: owner.cookie as string } });
      const text = await res.text();
      expect(text, raw).not.toContain('@orchvis/broker');
      expect(res.headers.get('content-type') ?? '', raw).not.toContain('application/octet-stream');
    }
  });
});

describe('oversized WebSocket frames', () => {
  it('/ws/shim closes with 1009 on a frame over maxPayload, before or after hello, and the broker keeps serving', async () => {
    const h = await harness();
    const url = `${h.broker.url.replace(/^http/, 'ws')}${SHIM_WS_PATH}`;
    const big = 'x'.repeat(MAX_PAYLOAD + 1);
    expect(await closeCodeAfter(url, {}, (ws) => ws.send(big))).toBe(1009);
    // Fragments that add up to more than the cap are refused too: the limit is on the whole message.
    const half = 'y'.repeat(Math.ceil(MAX_PAYLOAD / 2) + 1);
    expect(
      await closeCodeAfter(url, {}, (ws) => {
        ws.send(half, { fin: false });
        ws.send(half, { fin: true });
      }),
    ).toBe(1009);
    // After a welcome as well.
    const { shim } = await h.shim('host:big');
    shim.sendRaw(big);
    expect((await shim.closed).code).toBe(1009);
    expect(await health(h.broker.url)).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.broker.stats()).toMatchObject({ shimLinks: 0, uploadKeys: 0 });
  });

  it('/ws/ui closes with 1009 on a frame over maxPayload', async () => {
    const h = await harness();
    const cookie = await login(h.broker);
    const url = `${h.broker.url.replace(/^http/, 'ws')}${UI_WS_PATH}`;
    expect(await closeCodeAfter(url, uiHeaders(h.broker, cookie), (ws) => ws.send('z'.repeat(MAX_PAYLOAD + 1)))).toBe(1009);
    expect(await health(h.broker.url)).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.broker.stats().uiLinks).toBe(0);
  });

  it('a frame under the cap but over the body limit is rejected as too_large and the connection stays', async () => {
    const h = await harness();
    const { shim: a } = await h.shim('host:a');
    await a.register('ALPHA');
    const { shim: b } = await h.shim('host:b');
    await b.register('BETA');
    const r = await a.sendMessage('BETA', 'q'.repeat(DEFAULT_LIMITS.maxBodyBytes + 1));
    expect(r.type).toBe('rejected');
    expect((r.payload as { code: string }).code).toBe('too_large');
    expect((await a.sendMessage('BETA', 'small')).type).toBe('sent');
  });
});

describe('Owner credentials are never shim credentials', () => {
  it('/ws/shim ignores the Owner cookie and refuses the Owner token, the cookie value, or an empty token in hello', async () => {
    const h = await harness();
    const cookie = await login(h.broker);
    const sessionValue = cookie.split('=')[1] as string;
    const cases: [string, string][] = [
      [h.broker.ownerToken, 'unauthorized'],
      [sessionValue, 'unauthorized'],
      [cookie, 'unauthorized'],
      // An empty token fails the hello schema before any comparison.
      ['', 'invalid'],
    ];
    for (const [token, code] of cases) {
      const ws = new WebSocket(`${h.broker.url.replace(/^http/, 'ws')}${SHIM_WS_PATH}`, { headers: { cookie, origin: h.broker.url } });
      const shim = new FakeShim(ws, BrokerToShimFrameSchema);
      await new Promise<void>((resolve) => ws.once('open', () => resolve()));
      shim.send('hello', helloPayload(h.broker, { sessionId: 'host:imp', token }));
      expect((await shim.next('rejected')).payload.code, `token ${token.length} chars`).toBe(code);
      expect((await shim.closed).code).toBe(WS_CLOSE.helloRejected);
    }
    expect(h.broker.stats().nodes).toBe(0);
  });

  it('media endpoints refuse the Owner token or cookie value in the shim headers, even beside a valid Owner cookie', async () => {
    const h = await harness();
    const { shim: a, welcome } = await h.shim('host:a');
    await a.register('ALPHA');
    const ok = shimCreds(h.broker, welcome);
    const ref = await uploadOk(h.broker, ok, png());
    const cookie = await login(h.broker);
    const sessionValue = cookie.split('=')[1] as string;
    const bad: Creds[] = [
      { token: h.broker.ownerToken, key: ok.key as string },
      { token: sessionValue, key: ok.key as string },
      { token: h.broker.ownerToken },
      { token: ok.token as string, key: sessionValue },
      // Shim headers present means shim auth only: a valid Owner cookie beside a bad shim token does not rescue it.
      { token: h.broker.ownerToken, key: ok.key as string, cookie },
      { key: ok.key as string, cookie },
    ];
    for (const creds of bad) {
      expect((await upload(h.broker, creds, [png()], 'x')).status, JSON.stringify(Object.keys(creds))).toBe(401);
      expect((await download(h.broker, ref.mediaId, creds)).status).toBe(404);
    }
    expect(dirFiles(h.broker)).toEqual([ref.mediaId]);
  });
});

describe('a missing credential on every authenticated endpoint', () => {
  it('fails safely everywhere, and logout without a cookie ends nothing', async () => {
    const h = await harness();
    const { welcome } = await h.shim('host:a');
    const ref = await uploadOk(h.broker, shimCreds(h.broker, welcome), png());
    const { ui } = await h.ui();

    // POST /api/login with no token: 400, and no cookie is set.
    const noToken = await fetch(`${h.broker.url}${LOGIN_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noToken.status).toBe(400);
    expect(noToken.headers.get('set-cookie')).toBeNull();
    const empty = await fetch(`${h.broker.url}${LOGIN_PATH}`, { method: 'POST' });
    expect(empty.status).toBe(400);
    // POST /api/media: 401, nothing stored.
    expect((await upload(h.broker, {}, [png()], 'x')).status).toBe(401);
    expect(dirFiles(h.broker)).toEqual([ref.mediaId]);
    // GET /api/media/:id: 404, the same answer as an unknown ID.
    expect((await download(h.broker, ref.mediaId, {})).status).toBe(404);
    // GET /ws/ui: 4401 (with the right Origin, so the cookie is what is missing).
    expect(await FakeUi.tryConnect(h.broker, { origin: h.broker.url })).toBe(WS_CLOSE.unauthorized);
    expect(await FakeUi.tryConnect(h.broker, { origin: h.broker.url, cookie: `${OWNER_COOKIE}=` })).toBe(WS_CLOSE.unauthorized);
    // GET /ws/shim: a hello without a token does not parse (invalid), one with an empty token is unauthorized; both close 4400.
    const shim = await FakeShim.open(h.broker);
    const { token: _drop, ...noTokenHello } = helloPayload(h.broker, { sessionId: 'host:x' });
    void _drop;
    shim.sendRaw(JSON.stringify({ v: 1, type: 'hello', id: 'h1', ts: 0, payload: noTokenHello }));
    expect((await shim.next('rejected')).payload.code).toBe('invalid');
    expect((await shim.closed).code).toBe(WS_CLOSE.helloRejected);
    // POST /api/logout without a cookie: 204 and a cleared cookie, but the live Owner session is untouched.
    const out = await fetch(`${h.broker.url}${LOGOUT_PATH}`, { method: 'POST' });
    expect(out.status).toBe(204);
    await ui.sync();
    expect(ui.ws.readyState).toBe(WebSocket.OPEN);
    // MEDIA_PATH with a GET (no ID) is not an endpoint that leaks a listing.
    expect((await fetch(`${h.broker.url}${MEDIA_PATH}`)).status).toBe(404);
  });
});

describe('a peer claiming to be the Owner', () => {
  it('cannot take the name "owner" in any case, by hello or by register, and "owner" always means the Owner', async () => {
    const h = await harness();
    const { ui } = await h.ui();
    // A hello whose default name is "owner" in any case fails the schema and is closed.
    for (const defaultName of ['owner', 'Owner']) {
      const s = await FakeShim.open(h.broker);
      s.send('hello', helloPayload(h.broker, { sessionId: 'host:imp0', defaultName }));
      expect((await s.next('rejected')).payload.code).toBe('invalid');
      expect((await s.closed).code).toBe(WS_CLOSE.helloRejected);
    }
    const { shim: imp } = await h.shim('host:imp');
    for (const name of ['owner', 'OWNER', 'Owner']) {
      const re = imp.send('register', { name, focus: '', repos: [] });
      expect((await imp.next('rejected', (f) => f.payload.re === re)).payload.code).toBe('invalid');
    }
    const { shim: peer } = await h.shim('host:peer');
    await peer.register('PEER');
    const sent = await peer.sendMessage('owner', 'for the human');
    expect(sent.type).toBe('sent');
    const fed = await ui.next('message', (f) => f.payload.message.body === 'for the human');
    expect(fed.payload.message.to).toEqual({ kind: 'owner' });
    await imp.sync();
    expect(imp.pending('deliver')).toEqual([]);
    // A session ID cannot be "owner" either: it must be <host>:<id>.
    const bad = await FakeShim.open(h.broker);
    bad.send('hello', helloPayload(h.broker, { sessionId: 'owner', hostname: 'owner' }));
    expect((await bad.next('rejected')).payload.code).toBe('invalid');
    expect((await bad.closed).code).toBe(WS_CLOSE.helloRejected);
  });
});
