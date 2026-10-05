import { describe, expect, it } from 'vitest';
import { localRepoKey, normalizeRepoKey, repoNameFromKey } from '../src/index.js';

describe('normalizeRepoKey', () => {
  it.each([
    ['git@github.com:acme/orchestrator.git', 'github.com/acme/orchestrator'],
    ['git@github.com:acme/orchestrator', 'github.com/acme/orchestrator'],
    ['git@GitHub.com:Acme/Orchestrator.git', 'github.com/Acme/Orchestrator'],
    ['https://github.com/acme/orchestrator.git', 'github.com/acme/orchestrator'],
    ['https://github.com/acme/orchestrator', 'github.com/acme/orchestrator'],
    ['https://github.com/acme/orchestrator/', 'github.com/acme/orchestrator'],
    ['https://github.com/acme/orchestrator.git/', 'github.com/acme/orchestrator'],
    ['http://GITHUB.COM/acme/orchestrator', 'github.com/acme/orchestrator'],
    ['https://user:s3cret@github.com/acme/orchestrator.git', 'github.com/acme/orchestrator'],
    ['https://x-access-token@github.com:443/acme/orchestrator.git', 'github.com/acme/orchestrator'],
    ['ssh://git@github.com/acme/orchestrator.git', 'github.com/acme/orchestrator'],
    ['ssh://git@gitlab.example.com:2222/group/sub/repo.git', 'gitlab.example.com/group/sub/repo'],
    ['git+ssh://git@host.example/org/repo', 'host.example/org/repo'],
    ['git://host.example/org/repo.git', 'host.example/org/repo'],
    ['host.example:org/repo.git', 'host.example/org/repo'],
    ['https://dev.azure.com/org/project/_git/repo', 'dev.azure.com/org/project/_git/repo'],
    ['  git@github.com:acme/orchestrator.git\n', 'github.com/acme/orchestrator'],
    ['https://github.com//acme//orchestrator.git', 'github.com/acme/orchestrator'],
  ])('%s -> %s', (remote, key) => {
    expect(normalizeRepoKey(remote)).toBe(key);
  });

  it('gives the same key for SSH and HTTPS forms of one remote', () => {
    expect(normalizeRepoKey('git@github.com:acme/x.git')).toBe(normalizeRepoKey('https://github.com/acme/x'));
  });

  it.each([
    [''],
    ['   '],
    ['C:\\repos\\orchestrator'],
    ['C:/repos/orchestrator'],
    ['/srv/git/orchestrator.git'],
    ['../orchestrator'],
    ['file:///srv/git/orchestrator.git'],
    ['https://github.com/'],
    ['git@github.com:'],
  ])('returns null for local or empty remote %j', (remote) => {
    expect(normalizeRepoKey(remote)).toBeNull();
  });
});

describe('localRepoKey', () => {
  it('lowercases the host and keeps the directory name', () => {
    expect(localRepoKey('MediaRoomWindows', 'b2cOrcViz')).toBe('local:mediaroomwindows:b2cOrcViz');
  });
});

describe('repoNameFromKey', () => {
  it.each([
    ['github.com/acme/orchestrator', 'orchestrator'],
    ['local:host:my-dir', 'my-dir'],
    ['host/a/b/c', 'c'],
  ])('%s -> %s', (key, name) => {
    expect(repoNameFromKey(key)).toBe(name);
  });
});
