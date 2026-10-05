import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../src/index.js';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Run {
  stderr: string;
  stdout: string;
  code: number | null;
}

/** Runs the CLI until `until` matches stderr (then kills it) or it exits. */
function runCli(env: Record<string, string>, until?: RegExp, args: string[] = []): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: pkg,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const run: Run = { stderr: '', stdout: '', code: null };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cli timed out; stderr:\n${run.stderr}`));
    }, 30_000);
    child.stdout.on('data', (d: Buffer) => (run.stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => {
      run.stderr += d.toString();
      if (until?.test(run.stderr)) child.kill();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      run.code = code;
      resolve(run);
    });
  });
}

describe('cli', () => {
  it('creates the config on first run without ever printing a token, and reports progress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchvis-cli-'));
    dirs.push(dir);
    const path = join(dir, 'orchvis.config.json');
    const env = { ORCHVIS_CONFIG: path, ORCHVIS_PORT: '0', ORCHVIS_BIND: '127.0.0.1' };
    const first = await runCli(env, /ready:/);
    expect(first.stderr).toMatch(/\[orchvis \+\d+\.\ds\] starting orchvis broker/);
    expect(first.stderr).toContain(`created config file ${path}`);
    expect(first.stderr).toMatch(/shim token .*owner token/);
    expect(first.stdout).toContain('"event":"listening"');
    const second = await runCli(env, /ready:/);
    expect(second.stderr).not.toContain('created config file');
    const { shimToken, ownerToken } = JSON.parse(readFileSync(path, 'utf8')) as { shimToken: string; ownerToken: string };
    for (const run of [first, second]) {
      for (const token of [shimToken, ownerToken]) {
        expect(run.stdout).not.toContain(token);
        expect(run.stderr).not.toContain(token);
      }
    }
  }, 60_000);

  it('--init creates a valid config, prints its path, binds nothing, and never prints a token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchvis-cli-'));
    dirs.push(dir);
    // Hold the configured port: if --init tried to bind it, the run would fail.
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = String((server.address() as { port: number }).port);
    try {
      const viaFlag = join(dir, 'flag.json');
      const first = await runCli({ ORCHVIS_PORT: port, ORCHVIS_BIND: '127.0.0.1' }, undefined, ['--config', viaFlag, '--init']);
      expect(first.code).toBe(0);
      expect(first.stdout).toBe(`${resolve(viaFlag)}\ncreated\n`);
      expect(first.stderr).not.toContain('checking that port');
      const again = await runCli({ ORCHVIS_PORT: port }, undefined, ['--init', '--config', viaFlag]);
      expect(again.code).toBe(0);
      expect(again.stdout).toBe(`${resolve(viaFlag)}\nexists\n`);
      expect(again.stderr).toContain('already exists');

      const viaEnv = join(dir, 'env.json');
      const third = await runCli({ ORCHVIS_CONFIG: viaEnv, ORCHVIS_PORT: port }, undefined, ['--init']);
      expect(third.code).toBe(0);
      expect(third.stdout).toBe(`${resolve(viaEnv)}\ncreated\n`);

      for (const [path, runs] of [
        [viaFlag, [first, again]],
        [viaEnv, [third]],
      ] as const) {
        const cfg = loadConfig({ path, env: {} });
        expect(cfg.generatedTokens).toBe(false);
        expect(cfg.config.shimToken).not.toBe(cfg.config.ownerToken);
        for (const run of runs) {
          for (const token of [cfg.config.shimToken, cfg.config.ownerToken]) {
            expect(run.stdout).not.toContain(token);
            expect(run.stderr).not.toContain(token);
          }
        }
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);

  it('documents --init in --help', async () => {
    const run = await runCli({}, undefined, ['--help']);
    expect(run.stderr).toContain('--init');
  }, 60_000);

  it('fails with a clear message when the port is in use', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchvis-cli-'));
    dirs.push(dir);
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const run = await runCli({ ORCHVIS_CONFIG: join(dir, 'c.json'), ORCHVIS_PORT: String(port), ORCHVIS_BIND: '127.0.0.1' });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`port ${port} is already in use`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});
