import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIdentity, detectRepo, fileSafe, pickRemoteKey, rawSessionIdFrom, toPlatform } from '../src/identity.js';

function gitIn(dir: string, ...args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

describe('repo detection', () => {
  let root: string;
  let repo: string;
  let plain: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orchvis-id-')));
    repo = join(root, 'MyRepo');
    mkdirSync(join(repo, 'packages', 'deep'), { recursive: true });
    gitIn(repo, 'init', '-q', '-b', 'feature/x');
    gitIn(repo, 'remote', 'add', 'upstream', 'https://github.com/other/fork.git');
    gitIn(repo, 'remote', 'add', 'origin', 'git@GitHub.com:Acme/Orchestrator.git');
    plain = join(root, 'not-a-repo');
    mkdirSync(plain);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('resolves a subdirectory to the repo top level and its origin remote', async () => {
    const { root: top, repo: ref } = await detectRepo(join(repo, 'packages', 'deep'), 'myhost');
    expect(resolve(top!)).toBe(resolve(repo));
    expect(ref).toEqual({ key: 'github.com/Acme/Orchestrator', name: 'Orchestrator', branch: 'feature/x' });
  });

  it('builds identity from a subdirectory with the repo dirname in the default name', async () => {
    const id = await buildIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'abc-123' },
      cwd: join(repo, 'packages'),
      hostname: 'Media-PC',
      platform: 'win32',
    });
    expect(id.sessionId).toBe('media-pc:abc-123');
    expect(id.rawSessionId).toBe('abc-123');
    expect(id.fromEnv).toBe(true);
    expect(id.defaultName).toBe('MyRepo@media-pc');
    expect(id.platform).toBe('win32');
    expect(id.repos).toHaveLength(1);
  });

  it('falls back to a local key outside a work tree, without crashing', async () => {
    const { root: top, repo: ref } = await detectRepo(plain, 'MyHost');
    expect(top).toBeUndefined();
    expect(ref).toEqual({ key: 'local:myhost:not-a-repo', name: 'not-a-repo' });
  });

  it('uses a local key for a repo with no remote', async () => {
    const bare = join(root, 'NoRemote');
    mkdirSync(bare);
    gitIn(bare, 'init', '-q');
    const { repo: ref } = await detectRepo(bare, 'h');
    expect(ref.key).toBe('local:h:NoRemote');
  });

  it('survives a missing directory', async () => {
    const { repo: ref } = await detectRepo(join(root, 'missing'), 'h');
    expect(ref.key).toBe('local:h:missing');
  });
});

describe('identity helpers', () => {
  it('prefers origin, else the first normalizable fetch remote', () => {
    const verbose = [
      'upstream\thttps://github.com/up/r.git (fetch)',
      'upstream\thttps://github.com/up/r.git (push)',
      'origin\tC:\\local\\path (fetch)',
    ].join('\n');
    expect(pickRemoteKey(verbose)).toBe('github.com/up/r');
    expect(pickRemoteKey('')).toBeNull();
  });

  it('uses only CLAUDE_CODE_SESSION_ID, else a UUID', () => {
    expect(rawSessionIdFrom({ CLAUDE_CODE_SESSION_ID: ' s1 ' })).toEqual({ id: 's1', fromEnv: true });
    const fallback = rawSessionIdFrom({ CLAUDE_PID: '9', CLAUDE_CODE_BRIDGE_SESSION_ID: 'wrong' });
    expect(fallback.fromEnv).toBe(false);
    expect(fallback.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps platforms', () => {
    expect(toPlatform('win32')).toBe('win32');
    expect(toPlatform('darwin')).toBe('darwin');
    expect(toPlatform('freebsd')).toBe('linux');
  });

  it('makes file-safe segments', () => {
    expect(fileSafe('host:id/../x')).toBe('host_id_.._x');
    expect(fileSafe('..')).toBe('_');
  });
});
