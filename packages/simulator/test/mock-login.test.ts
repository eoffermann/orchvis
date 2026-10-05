import { HttpErrorSchema, LOGIN_PATH, LOGOUT_PATH, MEDIA_PATH, MediaRefSchema, OWNER_COOKIE, WS_CLOSE } from '@orchvis/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startMockUiFeed, type MockUiFeed } from '../src/index.js';

let feed: MockUiFeed | undefined;

afterEach(async () => {
  await feed?.close();
  feed = undefined;
});

async function login(token: unknown, raw?: string): Promise<Response> {
  return fetch(`${feed!.httpUrl}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify({ token }),
  });
}

function cookieFrom(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  const pair = header.split(';')[0] ?? '';
  return pair;
}

/** Opens /ws/ui and resolves with the first frame type, or the close code if it closes first. */
function firstEvent(cookie?: string): Promise<{ frame?: string; close?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(feed!.url, cookie ? { headers: { cookie } } : {});
    ws.once('message', (data) => {
      resolve({ frame: (JSON.parse(data.toString()) as { type: string }).type });
      ws.close();
    });
    ws.once('close', (code) => resolve({ close: code }));
    ws.once('error', reject);
  });
}

describe('mock feed login, matching the broker contract', () => {
  it('answers 401 for a wrong token and 400 for a malformed body', async () => {
    feed = await startMockUiFeed({ port: 0, nodes: 3, ownerToken: 'right', startTraffic: false });
    expect((await login('wrong')).status).toBe(401);
    expect(await (await login('wrong')).json()).toEqual({ error: 'unauthorized' });
    expect((await login('')).status).toBe(400);
    expect((await login(undefined, '{not json')).status).toBe(400);
  });

  it('sets an opaque HttpOnly SameSite=Strict cookie on success', async () => {
    feed = await startMockUiFeed({ port: 0, nodes: 3, ownerToken: 'right', startTraffic: false });
    const res = await login('right');
    expect(res.status).toBe(204);
    const header = res.headers.get('set-cookie') ?? '';
    expect(header.startsWith(`${OWNER_COOKIE}=`)).toBe(true);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).not.toContain('right');
  });

  it('closes /ws/ui with 4401 without a valid cookie, and sends a snapshot with one', async () => {
    feed = await startMockUiFeed({ port: 0, nodes: 3, ownerToken: 'right', startTraffic: false });
    expect(await firstEvent()).toEqual({ close: WS_CLOSE.unauthorized });
    expect(await firstEvent(`${OWNER_COOKIE}=forged`)).toEqual({ close: WS_CLOSE.unauthorized });
    const cookie = cookieFrom(await login('right'));
    expect(await firstEvent(cookie)).toEqual({ frame: 'snapshot' });
  });

  it('invalidates the session on logout', async () => {
    feed = await startMockUiFeed({ port: 0, nodes: 3, ownerToken: 'right', startTraffic: false });
    const cookie = cookieFrom(await login('right'));
    const out = await fetch(`${feed.httpUrl}${LOGOUT_PATH}`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await firstEvent(cookie)).toEqual({ close: WS_CLOSE.unauthorized });
  });

  it('guards media with the Owner cookie and answers errors in HttpErrorSchema form', async () => {
    feed = await startMockUiFeed({ port: 0, nodes: 3, ownerToken: 'right', startTraffic: false });
    const base = `${feed.httpUrl}${MEDIA_PATH}`;
    const upload = (cookie?: string, withCaption = true) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }), 'x.bin');
      if (withCaption) form.append('caption', 'three bytes');
      return fetch(base, { method: 'POST', body: form, ...(cookie ? { headers: { cookie } } : {}) });
    };
    const expectError = async (res: Response, status: number, error: string) => {
      expect(res.status).toBe(status);
      const body = HttpErrorSchema.parse(await res.json());
      expect(body.error).toBe(error);
    };

    await expectError(await upload(), 401, 'unauthorized');
    await expectError(await fetch(`${base}/anything`), 401, 'unauthorized');

    const cookie = cookieFrom(await login('right'));
    await expectError(await upload(cookie, false), 400, 'invalid');
    await expectError(await fetch(`${base}/missing`, { headers: { cookie } }), 404, 'not_found');

    const ok = await upload(cookie);
    expect(ok.status).toBe(201);
    const ref = MediaRefSchema.parse(await ok.json());
    const got = await fetch(`${base}/${ref.mediaId}`, { headers: { cookie } });
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('is open when no owner token is configured', async () => {
    feed = await startMockUiFeed({ port: 0, nodes: 3, startTraffic: false });
    expect(await firstEvent()).toEqual({ frame: 'snapshot' });
    expect((await login('anything')).status).toBe(204);
  });
});
