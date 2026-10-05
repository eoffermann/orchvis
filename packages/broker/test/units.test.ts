import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, weightAt, type Message } from '@orchvis/protocol';
import {
  LIMIT_ENV_VARS,
  ManualClock,
  RollingRateLimiter,
  ThreadStore,
  authorizeUi,
  checkPortFree,
  createLogger,
  loadConfig,
  parseCookies,
  resolveConfig,
  timingSafeEqualStr,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'orchvis-broker-test-'));
  dirs.push(d);
  return d;
}

describe('ManualClock', () => {
  it('fires timeouts and intervals in order as time advances', () => {
    const c = new ManualClock(0);
    const seen: string[] = [];
    c.setTimeout(() => seen.push(`t@${c.now()}`), 25);
    const iv = c.setInterval(() => seen.push(`i@${c.now()}`), 10);
    const cancelled = c.setTimeout(() => seen.push('never'), 5);
    c.clearTimeout(cancelled);
    c.advance(30);
    expect(seen).toEqual(['i@10', 'i@20', 't@25', 'i@30']);
    c.clearInterval(iv);
    c.advance(100);
    expect(seen).toHaveLength(4);
    expect(c.now()).toBe(130);
    expect(c.pending).toBe(0);
  });
});

describe('RollingRateLimiter', () => {
  it('allows `limit` events per key in any rolling window', () => {
    const r = new RollingRateLimiter(2, 1000);
    expect(r.tryAcquire('k', 0)).toBe(true);
    expect(r.tryAcquire('k', 500)).toBe(true);
    expect(r.tryAcquire('k', 999)).toBe(false);
    expect(r.tryAcquire('other', 999)).toBe(true);
    expect(r.tryAcquire('k', 1000)).toBe(true); // the event at 0 has left the window
    expect(r.count('k', 1000)).toBe(2);
    r.sweep(10_000);
    expect(r.size).toBe(0);
  });
});

function msg(id: string, from: string, to: string, ts: number): Message {
  const [x, y] = [from, to].sort();
  return {
    id,
    threadId: `${x}|${y}`,
    from: from === 'owner' ? { kind: 'owner' } : { kind: 'session', id: from },
    fromName: from,
    to: to === 'owner' ? { kind: 'owner' } : { kind: 'session', id: to },
    senderKind: from === 'owner' ? 'owner' : 'peer',
    kind: 'chat',
    body: '',
    attachments: [],
    ts,
  };
}

describe('ThreadStore', () => {
  it('evicts the oldest beyond capacity, in order, and drops them from the index', () => {
    const s = new ThreadStore(2, DEFAULT_LIMITS.edgeTauMs);
    const ids = ['01A', '01B', '01C'].map((p) => p.padEnd(26, '0'));
    s.append(msg(ids[0]!, 'h:a', 'h:b', 0));
    s.append(msg(ids[1]!, 'h:b', 'h:a', 0));
    const r = s.append(msg(ids[2]!, 'h:a', 'h:b', 0));
    expect(r.evicted.map((m) => m.id)).toEqual([ids[0]]);
    expect(s.get(ids[0]!)).toBeUndefined();
    expect(s.history('h:a|h:b').map((m) => m.id)).toEqual([ids[1], ids[2]]);
    expect(s.history('h:a|h:b', 1).map((m) => m.id)).toEqual([ids[2]]);
    expect(r.edge).toMatchObject({ a: 'h:a', b: 'h:b', sentByA: 2, sentByB: 1, weight: 3 });
  });

  it('decays the edge weight with the shared function', () => {
    const tau = 1000;
    const s = new ThreadStore(10, tau);
    s.append(msg('0'.repeat(26), 'owner', 'h:a', 0));
    const { edge } = s.append(msg('1'.repeat(26), 'h:a', 'owner', tau));
    expect(edge.weight).toBeCloseTo(1 + 1 / Math.E, 12);
    expect(edge).toMatchObject({ a: 'h:a', b: 'owner', sentByA: 1, sentByB: 1 });
    expect(weightAt(edge, 2 * tau, tau)).toBeCloseTo((1 + 1 / Math.E) / Math.E, 12);
  });

  it('lists all messages across threads in ULID order', () => {
    const s = new ThreadStore(10, 1000);
    s.append(msg('2'.repeat(26), 'h:a', 'h:b', 0));
    s.append(msg('1'.repeat(26), 'h:c', 'owner', 0));
    expect(s.allMessages().map((m) => m.id[0])).toEqual(['1', '2']);
  });
});

describe('config', () => {
  it('creates the file with fresh tokens on first run, then reuses it', () => {
    const path = join(tempDir(), 'sub', 'orchvis.config.json');
    const first = loadConfig({ path, env: {} });
    expect(first.generatedTokens).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(first.config).toMatchObject({ port: 7801, bind: '0.0.0.0', limits: DEFAULT_LIMITS });
    expect(first.config.shimToken).not.toBe(first.config.ownerToken);
    const second = loadConfig({ path, env: {} });
    expect(second.generatedTokens).toBe(false);
    expect(second.config.shimToken).toBe(first.config.shimToken);
  });

  it('reads the path from ORCHVIS_CONFIG and applies env overrides over the file', () => {
    const path = join(tempDir(), 'c.json');
    writeFileSync(path, JSON.stringify({ port: 9000, shimToken: 's'.repeat(32), ownerToken: 'o'.repeat(32), limits: { maxBodyBytes: 100 } }));
    const { config, generatedTokens } = loadConfig({
      env: {
        ORCHVIS_CONFIG: path,
        ORCHVIS_PORT: '9100',
        ORCHVIS_BIND: '127.0.0.1',
        ORCHVIS_OWNER_TOKEN: 'x'.repeat(32),
        ORCHVIS_OFFLINE_RETENTION_MS: '1234',
      },
    });
    expect(generatedTokens).toBe(false);
    expect(config).toMatchObject({ port: 9100, bind: '127.0.0.1', shimToken: 's'.repeat(32), ownerToken: 'x'.repeat(32) });
    expect(config.limits).toMatchObject({ maxBodyBytes: 100, offlineRetentionMs: 1234, ringBufferPerThread: 500 });
  });

  it('names one env var per limit', () => {
    expect(LIMIT_ENV_VARS.maxBodyBytes).toBe('ORCHVIS_MAX_BODY_BYTES');
    expect(LIMIT_ENV_VARS.sendRatePerMinute).toBe('ORCHVIS_SEND_RATE_PER_MINUTE');
    expect(Object.keys(LIMIT_ENV_VARS).sort()).toEqual(Object.keys(DEFAULT_LIMITS).sort());
  });

  it('rejects malformed values clearly, without echoing tokens', () => {
    const path = join(tempDir(), 'c.json');
    writeFileSync(path, '{"port": "nope"}');
    expect(() => loadConfig({ path, env: {} })).toThrow(/invalid/);
    writeFileSync(path, '{oops');
    expect(() => loadConfig({ path, env: {} })).toThrow(/not valid JSON/);
    rmSync(path);
    expect(() => loadConfig({ path, env: { ORCHVIS_MAX_BODY_BYTES: '-5' } })).toThrow(/ORCHVIS_MAX_BODY_BYTES/);
    expect(readFileSync(path, 'utf8')).toContain('shimToken');
  });

  it('resolveConfig fills test defaults without touching disk', () => {
    const c = resolveConfig({ limits: { maxBodyBytes: 5 } });
    expect(c).toMatchObject({ port: 0, bind: '127.0.0.1' });
    expect(c.limits.maxBodyBytes).toBe(5);
    expect(c.limits.ringBufferPerThread).toBe(DEFAULT_LIMITS.ringBufferPerThread);
  });
});

describe('UI auth', () => {
  const req = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as IncomingMessage;
  it('accepts only the owner token in the orchvis_owner cookie', () => {
    expect(authorizeUi(req(`orchvis_owner=${'t'.repeat(40)}`), 't'.repeat(40))).toBe(true);
    expect(authorizeUi(req(`a=b; orchvis_owner=${encodeURIComponent('t+/=')}`), 't+/=')).toBe(true);
    expect(authorizeUi(req(), 'tok')).toBe(false);
    expect(authorizeUi(req('orchvis_owner=wrong'), 'tok')).toBe(false);
    expect(authorizeUi(req('orchvis_owner_x=tok'), 'tok')).toBe(false);
  });

  it('parses cookies and compares secrets safely', () => {
    expect([...parseCookies(' a=1; b = 2 ;junk; c=%E0')]).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
  });
});

describe('logger', () => {
  it('writes one JSON object per line and drops undefined fields', () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l), () => 0).log('ev', { a: 1, b: undefined });
    expect(lines).toEqual(['{"t":"1970-01-01T00:00:00.000Z","event":"ev","a":1}\n']);
  });
});

describe('checkPortFree', () => {
  it('rejects with EADDRINUSE for a taken port and resolves for a free one', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    await expect(checkPortFree(port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new Promise<void>((r) => server.close(() => r()));
    await expect(checkPortFree(port, '127.0.0.1')).resolves.toBeUndefined();
  });
});
