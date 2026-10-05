import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_BROKER_PORT, DEFAULT_LIMITS, LimitsSchema, type Limits } from '@orchvis/protocol';

/** Everything the broker needs to run. */
export interface BrokerConfig {
  /** TCP port for HTTP and WebSocket. Default 7801. */
  port: number;
  /** Bind address. Default `0.0.0.0`. */
  bind: string;
  /** Secret every shim presents in `hello`. */
  shimToken: string;
  /** Secret only the Owner's browser holds. */
  ownerToken: string;
  /** Operational limits, sent to shims in `welcome` and to the web app in `snapshot`. */
  limits: Limits;
}

/**
 * A partial {@link BrokerConfig}, as accepted by `startBroker`. Unlike
 * `Partial<BrokerConfig>`, single limits may be given; the rest default.
 */
export type BrokerConfigInput = Partial<Omit<BrokerConfig, 'limits'>> & { limits?: Partial<Limits> };

/** Default bind address. */
export const DEFAULT_BIND = '0.0.0.0';

/** Environment variable naming the config file. */
export const CONFIG_ENV_VAR = 'ORCHVIS_CONFIG';

/**
 * Environment variables that override the config file. Limits use
 * `ORCHVIS_` plus the limit name in upper snake case.
 */
export const CONFIG_ENV_VARS = Object.freeze({
  port: 'ORCHVIS_PORT',
  bind: 'ORCHVIS_BIND',
  shimToken: 'ORCHVIS_SHIM_TOKEN',
  ownerToken: 'ORCHVIS_OWNER_TOKEN',
});

function toEnvName(limit: string): string {
  return `ORCHVIS_${limit.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

/**
 * Environment variable for each limit, e.g. `maxBodyBytes` →
 * `ORCHVIS_MAX_BODY_BYTES`, `offlineRetentionMs` → `ORCHVIS_OFFLINE_RETENTION_MS`.
 */
export const LIMIT_ENV_VARS: Readonly<Record<keyof Limits, string>> = Object.freeze(
  Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((k) => [k, toEnvName(k)])) as Record<keyof Limits, string>,
);

/**
 * Default config file location: `~/.orchvis/orchvis.config.json`, which is
 * outside every repo working tree. Override with `ORCHVIS_CONFIG` or the
 * `path` option of {@link loadConfig}.
 */
export function defaultConfigPath(): string {
  return join(homedir(), '.orchvis', 'orchvis.config.json');
}

/** Generates a fresh random token: 32 bytes, base64url. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

const FileSchema = z.object({
  port: z.number().int().min(0).max(65535).optional(),
  bind: z.string().min(1).optional(),
  shimToken: z.string().min(16).optional(),
  ownerToken: z.string().min(16).optional(),
  limits: LimitsSchema.partial().optional(),
});

/** Default limits with the defined values of `partial` laid over them. */
export function mergeLimits(partial: { [K in keyof Limits]?: number | undefined } = {}): Limits {
  const out: Limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const v = partial[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Result of {@link loadConfig}. */
export interface LoadedConfig {
  /** Effective config, environment overrides applied. */
  config: BrokerConfig;
  /** Absolute path of the config file. */
  path: string;
  /** True when this call created the file or added tokens to it; print the tokens once. */
  generatedTokens: boolean;
}

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Config file path. Defaults to `ORCHVIS_CONFIG`, then {@link defaultConfigPath}. */
  path?: string;
  /** Environment to read overrides from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

function parseIntEnv(name: string, raw: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

/**
 * Applies environment overrides to a config. Throws a clear error on a
 * malformed value. Token values are never echoed in errors.
 */
export function applyEnvOverrides(config: BrokerConfig, env: NodeJS.ProcessEnv): BrokerConfig {
  const out: BrokerConfig = { ...config, limits: { ...config.limits } };
  const port = env[CONFIG_ENV_VARS.port];
  if (port) out.port = parseIntEnv(CONFIG_ENV_VARS.port, port, 0);
  if (out.port > 65535) throw new Error(`${CONFIG_ENV_VARS.port} must be at most 65535`);
  const bind = env[CONFIG_ENV_VARS.bind];
  if (bind) out.bind = bind;
  const shim = env[CONFIG_ENV_VARS.shimToken];
  if (shim) out.shimToken = shim;
  const owner = env[CONFIG_ENV_VARS.ownerToken];
  if (owner) out.ownerToken = owner;
  for (const key of Object.keys(LIMIT_ENV_VARS) as (keyof Limits)[]) {
    const name = LIMIT_ENV_VARS[key];
    const raw = env[name];
    if (raw) out.limits[key] = parseIntEnv(name, raw, 1);
  }
  return out;
}

/**
 * Loads the broker config file, creating it on first run with freshly
 * generated tokens and default limits, then applies environment overrides.
 * The file is written with mode 0600 where the platform supports it.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const path = resolve(options.path ?? env[CONFIG_ENV_VAR] ?? defaultConfigPath());
  let file: z.infer<typeof FileSchema> = {};
  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`config file ${path} is not valid JSON: ${(err as Error).message}`);
    }
    const parsed = FileSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`config file ${path} is invalid: ${issues}`);
    }
    file = parsed.data;
  }

  let generatedTokens = false;
  if (!file.shimToken || !file.ownerToken) {
    file = {
      port: file.port ?? DEFAULT_BROKER_PORT,
      bind: file.bind ?? DEFAULT_BIND,
      shimToken: file.shimToken ?? generateToken(),
      ownerToken: file.ownerToken ?? generateToken(),
      limits: mergeLimits(file.limits),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    generatedTokens = true;
  }

  const base: BrokerConfig = {
    port: file.port ?? DEFAULT_BROKER_PORT,
    bind: file.bind ?? DEFAULT_BIND,
    shimToken: file.shimToken as string,
    ownerToken: file.ownerToken as string,
    limits: mergeLimits(file.limits),
  };
  const config = applyEnvOverrides(base, env);
  const limits = LimitsSchema.safeParse(config.limits);
  if (!limits.success) throw new Error(`invalid limits: ${limits.error.issues[0]?.message ?? 'unknown'}`);
  return { config, path, generatedTokens };
}

/**
 * Fills a {@link BrokerConfigInput} with defaults for tests and embedding:
 * port 0, bind `127.0.0.1`, fresh random tokens, default limits. Never
 * touches disk.
 */
export function resolveConfig(input: BrokerConfigInput = {}): BrokerConfig {
  const limits = mergeLimits(input.limits);
  const parsed = LimitsSchema.safeParse(limits);
  if (!parsed.success) throw new Error(`invalid limits: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  return {
    port: input.port ?? 0,
    bind: input.bind ?? '127.0.0.1',
    shimToken: input.shimToken ?? generateToken(),
    ownerToken: input.ownerToken ?? generateToken(),
    limits,
  };
}
