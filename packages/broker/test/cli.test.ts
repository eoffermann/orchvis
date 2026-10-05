import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
function runCli(env: Record<string, string>, until?: RegExp): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts'], {
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
  it('creates the config on first run, prints the tokens once, and reports progress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchvis-cli-'));
    dirs.push(dir);
    const env = { ORCHVIS_CONFIG: join(dir, 'orchvis.config.json'), ORCHVIS_PORT: '0', ORCHVIS_BIND: '127.0.0.1' };
    const first = await runCli(env, /ready:/);
    expect(first.stderr).toMatch(/\[orchvis \+\d+\.\ds\] starting orchvis broker/);
    expect(first.stderr).toContain('shim token:');
    expect(first.stdout).toContain('"event":"listening"');
    const second = await runCli(env, /ready:/);
    expect(second.stderr).not.toContain('shim token:');
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
