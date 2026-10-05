// Reading and writing the shim's config file, <ORCHVIS_HOME or ~/.orchvis>/config.json:
// { "brokerUrl": "...", "shimToken": "..." }. The shape is defined by
// packages/shim/src/config.ts; keep the two in step.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PORT, orchvisHome } from './project.mjs';

/** Path of the shim config file. */
export function shimConfigPath(env = process.env) {
  return join(orchvisHome(env), 'config.json');
}

/**
 * Normalizes a broker URL as typed by a user: accepts `ws://`, `wss://`,
 * `http://`, `https://` or a bare `host[:port]`, adds the default port when
 * none is given, and returns `ws://host:port` (or `wss://`). Throws on
 * anything else.
 */
export function normalizeBrokerUrl(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('the broker URL is empty');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `ws://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${input}" is not a valid broker URL`);
  }
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)) {
    throw new Error(`unsupported broker URL scheme ${url.protocol}; use ws://host:port`);
  }
  if (!url.hostname) throw new Error(`"${input}" has no host`);
  const secure = url.protocol === 'wss:' || url.protocol === 'https:';
  const port = url.port || String(DEFAULT_PORT);
  return `${secure ? 'wss' : 'ws'}://${url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname}:${port}`;
}

/** The HTTP base URL (no trailing slash) for a normalized broker URL. */
export function httpBase(brokerUrl) {
  return brokerUrl.replace(/^ws/, 'http');
}

/** Reads the shim config file; `{}` when it is missing or unreadable. */
export function readShimConfig(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * Writes `brokerUrl` and `shimToken` into the shim config file, keeping any
 * other keys, atomically and readable by the owner only (on POSIX). The token
 * is never printed.
 */
export function writeShimConfig(file, { brokerUrl, shimToken }) {
  const dir = join(file, '..');
  mkdirSync(dir, { recursive: true });
  const next = { ...readShimConfig(file), brokerUrl, shimToken };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Not supported on every filesystem; Windows ACLs already limit the profile directory.
  }
}

/** Whether a usable shim config (both fields) already exists. */
export function hasShimConfig(file) {
  if (!existsSync(file)) return false;
  const c = readShimConfig(file);
  return typeof c.brokerUrl === 'string' && !!c.brokerUrl.trim() && typeof c.shimToken === 'string' && !!c.shimToken.trim();
}

/** GET <base>/healthz with a timeout; resolves to the parsed body, or undefined when unreachable. */
export async function healthz(base, timeoutMs = 3000) {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    return await res.json().catch(() => ({}));
  } catch {
    return undefined;
  }
}
