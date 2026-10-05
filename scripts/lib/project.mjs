// Shared constants and helpers for the orchvis launcher scripts.
// Plain Node (no dependencies), so it runs before `pnpm install`.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The public GitHub repository, as `owner/name`. The one place to change it in
 * scripts; the README, skills and shell launchers spell it out too, and
 * plugin/test/consistency.test.ts checks they all agree with this value.
 */
export const GITHUB_REPO = 'eoffermann/orchvis';

/** Marketplace name, from the `name` in .claude-plugin/marketplace.json. */
export const MARKETPLACE = 'orchvis';

/** Plugin name, from plugin/.claude-plugin/plugin.json. */
export const PLUGIN = 'orchvis';

/** Broker port when nothing else sets it. Matches the broker's default. */
export const DEFAULT_PORT = 7801;

/** Root of the orchvis checkout this script lives in. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The orchvis home directory: ORCHVIS_HOME when set, else ~/.orchvis (same rule as the shim). */
export function orchvisHome(env = process.env) {
  const override = env.ORCHVIS_HOME;
  return override && override.trim() ? override.trim() : join(homedir(), '.orchvis');
}

const started = Date.now();

/** Prints one flushed progress line with seconds since the script started. */
export function log(text) {
  process.stdout.write(`[orchvis +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}\n`);
}

/** Prints an error line and sets a failing exit code. */
export function fail(text) {
  process.stderr.write(`[orchvis +${((Date.now() - started) / 1000).toFixed(1)}s] error: ${text}\n`);
  process.exitCode = 1;
}

/**
 * Runs pnpm with inherited stdio. On Windows pnpm is a .cmd shim, which needs
 * a shell; arguments here are fixed strings without spaces or quotes.
 */
export function runPnpm(args, options = {}) {
  return spawnPnpm(args, { cwd: REPO_ROOT, stdio: 'inherit', ...options });
}

function spawnPnpm(args, options) {
  if (process.platform === 'win32') {
    // A shell command line, since pnpm is a .cmd; args are fixed, space-free strings.
    return spawnSync(['pnpm', ...args].join(' '), { ...options, shell: true });
  }
  return spawnSync('pnpm', args, options);
}

/** The installed pnpm version, or undefined when pnpm is not on PATH. */
export function pnpmVersion() {
  const r = spawnPnpm(['--version'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** Whether the module at `moduleUrl` is the script Node was started with. */
export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(fileURLToPath(moduleUrl)) === norm(process.argv[1]);
}

/** Throws a readable error when Node is older than 20. */
export function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    throw new Error(`Node ${process.versions.node} is too old; orchvis needs Node 20 or later. Install it from https://nodejs.org`);
  }
}
