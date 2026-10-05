/**
 * Spawns the bundled shim (`dist/shim.cjs`) over stdio with an MCP SDK client,
 * as Claude Code would, and records every notification it emits.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Notification } from '@modelcontextprotocol/sdk/types.js';

/** Absolute path of the bundle under test. */
export const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'shim.cjs');

/** A channel notification as received. */
export interface ChannelNote {
  content: string;
  meta: Record<string, string>;
}

/** A running shim under test. */
export interface ShimProcess {
  client: Client;
  /** Every notification received, in order. */
  notifications: Notification[];
  /** Channel notifications only. */
  channel(): ChannelNote[];
  /** Waits for a channel notification matching `pred` (counting from index `from` of {@link channel}). */
  waitForChannel(pred: (n: ChannelNote) => boolean, options?: { from?: number; timeoutMs?: number }): Promise<ChannelNote>;
  /** Calls a tool and returns its text and error flag. */
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Captured stderr. */
  stderr(): string;
  /** `ORCHVIS_HOME` used by this shim. */
  home: string;
  /** Temp directory used as the shim's `os.tmpdir()`. */
  tmp: string;
  /** Raw session ID given to the shim. */
  rawSessionId: string;
  close(): Promise<void>;
}

/** Options for {@link spawnShim}. */
export interface SpawnShimOptions {
  /** Broker base URL; omit for an unconfigured shim. */
  brokerUrl?: string;
  token?: string;
  rawSessionId?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** Environment inherited from the test runner, minus anything that would leak identity. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('CLAUDE') || k.startsWith('ORCHVIS')) continue;
    env[k] = v;
  }
  return env;
}

/** Spawns the shim and completes the MCP handshake. */
export async function spawnShim(options: SpawnShimOptions = {}): Promise<ShimProcess> {
  const root = mkdtempSync(join(tmpdir(), 'orchvis-shim-test-'));
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  const rawSessionId = options.rawSessionId ?? `sess-${Math.random().toString(16).slice(2, 10)}`;
  const env: Record<string, string> = {
    ...baseEnv(),
    ORCHVIS_HOME: home,
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    CLAUDE_CODE_SESSION_ID: rawSessionId,
    ...(options.brokerUrl ? { ORCHVIS_BROKER_URL: options.brokerUrl } : {}),
    ...(options.token ? { ORCHVIS_TOKEN: options.token } : {}),
    ...options.env,
  };
  mkdirSync(tmp, { recursive: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    env,
    cwd: options.cwd ?? root,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const notifications: Notification[] = [];
  const listeners = new Set<() => void>();
  const client = new Client({ name: 'orchvis-test', version: '0.0.0' });
  client.fallbackNotificationHandler = async (n) => {
    notifications.push(n);
    for (const l of [...listeners]) l();
  };
  await client.connect(transport);

  const channel = (): ChannelNote[] =>
    notifications
      .filter((n) => n.method === 'notifications/claude/channel')
      .map((n) => n.params as unknown as ChannelNote);

  return {
    client,
    notifications,
    channel,
    home,
    tmp,
    rawSessionId,
    stderr: () => stderr,
    waitForChannel(pred, opts = {}) {
      const from = opts.from ?? 0;
      const timeoutMs = opts.timeoutMs ?? 10_000;
      return new Promise((resolve, reject) => {
        const find = () => channel().slice(from).find(pred);
        const hit = find();
        if (hit) return resolve(hit);
        const check = () => {
          const found = find();
          if (found) {
            listeners.delete(check);
            clearTimeout(timer);
            resolve(found);
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`no matching channel notification within ${timeoutMs} ms\nstderr:\n${stderr}`));
        }, timeoutMs);
        listeners.add(check);
      });
    },
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      return { text: result.content.map((c) => c.text ?? '').join('\n'), isError: result.isError === true };
    },
    async close() {
      await client.close().catch(() => {});
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
