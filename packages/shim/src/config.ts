import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { SHIM_WS_PATH } from '@orchvis/protocol';

/** Shape of `~/.orchvis/config.json`. Unknown keys are ignored. */
export const ShimConfigFileSchema = z.object({
  brokerUrl: z.string().optional(),
  shimToken: z.string().optional(),
});

/** Resolved shim configuration. */
export interface ShimConfig {
  /** The orchvis home directory, normally `~/.orchvis`. */
  home: string;
  /** The config file path that was read (whether or not it existed). */
  configPath: string;
  /** Broker URL as configured, or `undefined` when none is set. */
  brokerUrl: string | undefined;
  /** Shim token, or `undefined` when none is set. Never log it. */
  shimToken: string | undefined;
  /** WebSocket URL for `/ws/shim`, derived from {@link brokerUrl}. */
  wsUrl: string | undefined;
  /** HTTP base URL (no trailing slash) for `/api/media`, derived from {@link brokerUrl}. */
  httpBase: string | undefined;
  /** Why the config is unusable, or `undefined` when it is complete. */
  problem: string | undefined;
}

/**
 * The orchvis home directory: `ORCHVIS_HOME` when set (a test seam), otherwise
 * `~/.orchvis`. The inbox mirror and the config file live under it.
 */
export function orchvisHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['ORCHVIS_HOME'];
  return override && override.trim() ? override.trim() : join(homedir(), '.orchvis');
}

/**
 * Derives the WebSocket and HTTP URLs from a broker URL. Accepts `ws://`,
 * `wss://`, `http://`, `https://` or a bare `host:port`; any path is replaced
 * by the protocol's paths.
 */
export function brokerUrls(brokerUrl: string): { wsUrl: string; httpBase: string } {
  let text = brokerUrl.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `ws://${text}`;
  const url = new URL(text);
  const secure = url.protocol === 'wss:' || url.protocol === 'https:';
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)) {
    throw new Error(`unsupported broker URL scheme ${url.protocol}`);
  }
  const hostPort = url.host;
  return {
    wsUrl: `${secure ? 'wss' : 'ws'}://${hostPort}${SHIM_WS_PATH}`,
    httpBase: `${secure ? 'https' : 'http'}://${hostPort}`,
  };
}

/**
 * Loads `<home>/config.json`, then applies `ORCHVIS_BROKER_URL` and
 * `ORCHVIS_TOKEN` overrides. Never throws: a missing or malformed file yields a
 * config with {@link ShimConfig.problem} set, so the MCP server still starts
 * and its tools can explain what is wrong.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ShimConfig {
  const home = orchvisHome(env);
  const configPath = join(home, 'config.json');
  let fileBrokerUrl: string | undefined;
  let fileToken: string | undefined;
  let problem: string | undefined;

  try {
    const parsed = ShimConfigFileSchema.safeParse(JSON.parse(readFileSync(configPath, 'utf8')));
    if (parsed.success) {
      fileBrokerUrl = parsed.data.brokerUrl;
      fileToken = parsed.data.shimToken;
    } else {
      problem = `${configPath} is not a valid orchvis config`;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') problem = `could not read ${configPath}: ${(err as Error).message}`;
  }

  const brokerUrl = nonEmpty(env['ORCHVIS_BROKER_URL']) ?? nonEmpty(fileBrokerUrl);
  const shimToken = nonEmpty(env['ORCHVIS_TOKEN']) ?? nonEmpty(fileToken);

  let wsUrl: string | undefined;
  let httpBase: string | undefined;
  if (brokerUrl) {
    try {
      ({ wsUrl, httpBase } = brokerUrls(brokerUrl));
    } catch {
      // Reported below as an invalid broker URL.
    }
  }
  // A bad file only matters when the environment does not fill the gap.
  const fileProblem = problem;
  problem = undefined;
  if (brokerUrl && !wsUrl) {
    problem = `invalid broker URL ${brokerUrl}`;
  } else if (!brokerUrl) {
    problem = fileProblem ?? `no broker URL configured (set brokerUrl in ${configPath} or ORCHVIS_BROKER_URL)`;
  } else if (!shimToken) {
    problem = fileProblem ?? `no shim token configured (set shimToken in ${configPath} or ORCHVIS_TOKEN)`;
  }

  return { home, configPath, brokerUrl, shimToken, wsUrl, httpBase, problem };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
