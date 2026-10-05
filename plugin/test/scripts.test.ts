import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyBuild, isStale } from '../../scripts/build-web.mjs';
import { GITHUB_REPO, MARKETPLACE, PLUGIN as PLUGIN_NAME } from '../../scripts/lib/project.mjs';
import { hasShimConfig, normalizeBrokerUrl, readShimConfig, writeShimConfig } from '../../scripts/lib/shim-config.mjs';
import { brokerAddress, logTail, parseArgs } from '../../scripts/orchvis-start.mjs';
import { main as setupMain, parseArgs as setupArgs } from '../../scripts/setup.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPTS = join(REPO, 'scripts');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orchvis-scripts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('normalizeBrokerUrl', () => {
  it.each([
    ['broker-host', 'ws://broker-host:7801'],
    ['broker-host:9000', 'ws://broker-host:9000'],
    ['ws://10.0.0.5:7801/ws/shim', 'ws://10.0.0.5:7801'],
    ['http://Broker.lan:7801/', 'ws://broker.lan:7801'],
    ['https://broker.example.com', 'wss://broker.example.com:7801'],
    ['  ws://h:1  ', 'ws://h:1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeBrokerUrl(input)).toBe(expected);
  });

  it.each(['', 'ftp://h:1', 'ws://'])('rejects %j', (input) => {
    expect(() => normalizeBrokerUrl(input)).toThrow();
  });
});

describe('shim config file', () => {
  it('writes both fields, keeps other keys, and reads back', () => {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ extra: 1, brokerUrl: 'ws://old:1' }));
    writeShimConfig(file, { brokerUrl: 'ws://new:7801', shimToken: 'secret-token-value' });
    expect(readShimConfig(file)).toEqual({ extra: 1, brokerUrl: 'ws://new:7801', shimToken: 'secret-token-value' });
    expect(hasShimConfig(file)).toBe(true);
    expect(readdirSync(dir)).toEqual(['config.json']);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('treats a missing or corrupt file as no config', () => {
    expect(hasShimConfig(join(dir, 'nope.json'))).toBe(false);
    writeFileSync(join(dir, 'bad.json'), '{oops');
    expect(readShimConfig(join(dir, 'bad.json'))).toEqual({});
  });
});

describe('setup.mjs', () => {
  it('writes the config non-interactively from flags and the env token, never printing the token', async () => {
    const env = { ORCHVIS_HOME: dir, ORCHVIS_TOKEN: 'tok-from-env-1234567890' };
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      writes.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      // Port 9 (discard) refuses quickly, so the health check fails fast.
      code = await setupMain(['--broker-url', '127.0.0.1:9', '--yes'], env);
    } finally {
      process.stdout.write = orig;
    }
    expect(code).toBe(0);
    expect(readShimConfig(join(dir, 'config.json'))).toEqual({ brokerUrl: 'ws://127.0.0.1:9', shimToken: 'tok-from-env-1234567890' });
    expect(writes.join('')).not.toContain('tok-from-env');
  });

  it('parses --from-broker-config with and without a path', () => {
    expect(setupArgs(['--from-broker-config']).fromBrokerConfig).toMatch(/orchvis\.config\.json$/);
    expect(setupArgs(['--from-broker-config', 'x.json', '--yes'])).toMatchObject({ yes: true });
    expect(() => setupArgs(['--bogus'])).toThrow();
  });
});

describe('orchvis-start.mjs', () => {
  it('parses options', () => {
    expect(parseArgs(['--background', '--no-open', '--port', '7900'])).toMatchObject({ background: true, open: false, port: 7900 });
    expect(() => parseArgs(['--port', 'abc'])).toThrow();
    expect(() => parseArgs(['--nope'])).toThrow();
  });

  it('resolves the port like the broker: flag, then env, then config file, then 7801', () => {
    const cfg = join(dir, 'orchvis.config.json');
    writeFileSync(cfg, JSON.stringify({ port: 7811, bind: '0.0.0.0' }));
    const opts = parseArgs(['--config', cfg]);
    expect(brokerAddress(opts, {})).toMatchObject({ port: 7811, host: '127.0.0.1' });
    expect(brokerAddress(opts, { ORCHVIS_PORT: '7822' }).port).toBe(7822);
    expect(brokerAddress({ ...opts, port: 7833 }, { ORCHVIS_PORT: '7822' }).port).toBe(7833);
    expect(brokerAddress(parseArgs(['--config', join(dir, 'missing.json')]), {}).port).toBe(7801);
    expect(brokerAddress(opts, { ORCHVIS_BIND: '192.168.1.9' }).base).toBe('http://192.168.1.9:7811');
  });

  it('hides token values in the log tail', () => {
    const log = join(dir, 'broker.log');
    writeFileSync(log, 'starting\n  shim token:  AAAAsecretBBBB\n  owner token: CCCCsecretDDDD\nready\n');
    const tail = logTail(log);
    expect(tail).toContain('ready');
    expect(tail).not.toContain('secret');
  });
});

describe('build-web.mjs', () => {
  it('detects a stale or missing copy and replaces it', () => {
    const web = join(dir, 'web');
    const proto = join(dir, 'protocol');
    const pub = join(dir, 'public');
    mkdirSync(join(web, 'src'), { recursive: true });
    mkdirSync(join(proto, 'src'), { recursive: true });
    writeFileSync(join(web, 'src', 'main.tsx'), 'x');
    writeFileSync(join(proto, 'src', 'index.ts'), 'x');
    expect(isStale(web, pub, proto)).toBe(true);

    const dist = join(dir, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    writeFileSync(join(dist, 'assets', 'a.js'), '1');
    mkdirSync(pub);
    writeFileSync(join(pub, 'old.txt'), 'old');
    copyBuild(dist, pub);
    expect(readdirSync(pub).sort()).toEqual(['assets', 'index.html']);

    const past = new Date(Date.now() - 60_000);
    utimesSync(join(web, 'src', 'main.tsx'), past, past);
    utimesSync(join(proto, 'src', 'index.ts'), past, past);
    expect(isStale(web, pub, proto)).toBe(false);
    writeFileSync(join(proto, 'src', 'index.ts'), 'changed');
    expect(isStale(web, pub, proto)).toBe(true);
  });

  it('refuses to copy a build without index.html', () => {
    mkdirSync(join(dir, 'empty'));
    expect(() => copyBuild(join(dir, 'empty'), join(dir, 'out'))).toThrow(/index\.html/);
  });
});

describe('names stay consistent', () => {
  const marketplace = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(join(REPO, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));

  it('script constants match the manifests', () => {
    expect(MARKETPLACE).toBe(marketplace.name);
    expect(PLUGIN_NAME).toBe(plugin.name);
    expect(plugin.repository).toBe(`https://github.com/${GITHUB_REPO}`);
  });

  it.each(['orchvis-claude.sh', 'orchvis-claude.ps1', 'orchvis-claude.cmd'])('%s launches plugin:<plugin>@<marketplace>', (file) => {
    const text = readFileSync(join(SCRIPTS, file), 'utf8');
    expect(text).toContain('--dangerously-load-development-channels');
    expect(text).toContain(`plugin:${PLUGIN_NAME}@`);
    expect(text).toMatch(new RegExp(`ORCHVIS_MARKETPLACE:-${MARKETPLACE}\\}|'${MARKETPLACE}'|ORCHVIS_MARKETPLACE=${MARKETPLACE}"`));
  });

  it('every repo, marketplace and install reference in skills and README uses the constants', () => {
    const files = [
      join(REPO, 'README.md'),
      ...['orchvis-start', 'orchvis-join'].map((s) => join(REPO, 'plugin', 'skills', s, 'SKILL.md')),
    ];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/g)) expect(m[1]).toBe(GITHUB_REPO);
      for (const m of text.matchAll(/marketplace add ([\w.-]+\/[\w.-]+)/g)) expect(m[1]).toBe(GITHUB_REPO);
      for (const m of text.matchAll(/plugin install ([\w.-]+)@([\w.-]+)/g)) expect([m[1], m[2]]).toEqual([PLUGIN_NAME, MARKETPLACE]);
    }
  });

  it('shell launchers are LF and executable in the index', () => {
    const shells = ['orchvis-claude.sh', 'start-orchvis.sh', 'start-orchvis.command', 'setup.sh'];
    for (const f of shells) {
      expect(readFileSync(join(SCRIPTS, f), 'utf8')).not.toContain('\r');
    }
    const r = spawnSync('git', ['ls-files', '-s', '--', ...shells.map((f) => `scripts/${f}`)], { cwd: REPO, encoding: 'utf8' });
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(shells.length);
    for (const line of lines) expect(line.startsWith('100755 ')).toBe(true);
  });
});
