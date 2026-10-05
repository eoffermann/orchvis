import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import { basename, resolve } from 'node:path';
import {
  localRepoKey,
  makeSessionId,
  normalizeRepoKey,
  repoNameFromKey,
  sanitizeSessionName,
  type Platform,
  type RepoRef,
  type SessionId,
} from '@orchvis/protocol';

/** Who this shim is: everything `hello` needs except the token. */
export interface ShimIdentity {
  /** `${hostname lowercased}:${rawSessionId}`. */
  sessionId: SessionId;
  /**
   * The raw `CLAUDE_CODE_SESSION_ID`, or a process-lifetime UUID when it is
   * absent. Names the inbox mirror file and the media directory, because hooks
   * receive this raw value and `:` is illegal in Windows filenames.
   */
  rawSessionId: string;
  /** Whether {@link rawSessionId} came from `CLAUDE_CODE_SESSION_ID`. */
  fromEnv: boolean;
  /** Lowercased hostname. */
  hostname: string;
  platform: Platform;
  /** The directory Claude Code launched the shim in. */
  cwd: string;
  /** Git top-level directory of {@link cwd}, when it is inside a work tree. */
  repoRoot: string | undefined;
  /** The cwd repo, always exactly one entry. */
  repos: RepoRef[];
  /** `<directory name>@<hostname>`, sanitized into a valid session name. */
  defaultName: string;
}

/** Maps `process.platform` onto the protocol's platforms; anything else counts as linux. */
export function toPlatform(platform: NodeJS.Platform): Platform {
  return platform === 'win32' || platform === 'darwin' ? platform : 'linux';
}

/**
 * The raw Claude Code session ID. Only `CLAUDE_CODE_SESSION_ID` is trusted;
 * other `CLAUDE_*` variables can be inherited from a parent process.
 */
export function rawSessionIdFrom(env: NodeJS.ProcessEnv): { id: string; fromEnv: boolean } {
  const fromEnv = env['CLAUDE_CODE_SESSION_ID']?.trim();
  return fromEnv ? { id: fromEnv, fromEnv: true } : { id: randomUUID(), fromEnv: false };
}

/** Runs git with a timeout; resolves to trimmed stdout, or `undefined` on any failure. */
export function git(args: string[], timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    try {
      execFile('git', args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        resolvePromise(err ? undefined : stdout.trim());
      });
    } catch {
      resolvePromise(undefined);
    }
  });
}

/** Result of {@link detectRepo}. */
export interface RepoDetection {
  /** Git top-level directory, when `dir` is inside a work tree. */
  root: string | undefined;
  repo: RepoRef;
}

/**
 * Picks the remote that names the repo: `origin` when present, otherwise the
 * first fetch remote that normalizes.
 */
export function pickRemoteKey(remoteVerbose: string): string | null {
  const remotes: Array<{ name: string; key: string }> = [];
  for (const line of remoteVerbose.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (!match || !match[1] || !match[2]) continue;
    const key = normalizeRepoKey(match[2]);
    if (key) remotes.push({ name: match[1], key });
  }
  return (remotes.find((r) => r.name === 'origin') ?? remotes[0])?.key ?? null;
}

/**
 * Finds the repo a directory belongs to. Resolves the git top level first, so
 * a subdirectory of a repo maps to the repo. A directory with no usable remote,
 * outside any work tree, or on a machine without git maps to
 * `local:<hostname>:<directory name>`. Never throws.
 */
export async function detectRepo(dir: string, hostname: string): Promise<RepoDetection> {
  const top = await git(['-C', dir, 'rev-parse', '--show-toplevel']);
  const root = top ? resolve(top) : undefined;
  const base = root ?? resolve(dir);
  let key: string | null = null;
  let branch: string | undefined;
  if (root) {
    const [remotes, head] = await Promise.all([
      git(['-C', root, 'remote', '-v']),
      // symbolic-ref also names an unborn branch, and fails on a detached HEAD.
      git(['-C', root, 'symbolic-ref', '--short', '-q', 'HEAD']),
    ]);
    key = remotes ? pickRemoteKey(remotes) : null;
    if (head) branch = head;
  }
  const dirName = basename(base) || base;
  const finalKey = key ?? localRepoKey(hostname, dirName);
  const repo: RepoRef = { key: finalKey, name: repoNameFromKey(finalKey) };
  if (branch) repo.branch = branch;
  return { root, repo };
}

/** Inputs to {@link buildIdentity}; each defaults to the current process. */
export interface IdentityInputs {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  hostname?: string;
  platform?: NodeJS.Platform;
  /** A raw session ID already chosen by {@link rawSessionIdFrom}. */
  raw?: { id: string; fromEnv: boolean };
}

/** Collects the shim's identity: hostname, session ID, cwd, platform and repo. */
export async function buildIdentity(inputs: IdentityInputs = {}): Promise<ShimIdentity> {
  const env = inputs.env ?? process.env;
  const cwd = resolve(inputs.cwd ?? process.cwd());
  const hostname = (inputs.hostname ?? osHostname()).trim().toLowerCase() || 'localhost';
  const raw = inputs.raw ?? rawSessionIdFrom(env);
  const { root, repo } = await detectRepo(cwd, hostname);
  const dirName = basename(root ?? cwd) || 'session';
  return {
    sessionId: makeSessionId(hostname, raw.id),
    rawSessionId: raw.id,
    fromEnv: raw.fromEnv,
    hostname,
    platform: toPlatform(inputs.platform ?? process.platform),
    cwd,
    repoRoot: root,
    repos: [repo],
    defaultName: sanitizeSessionName(`${dirName}@${hostname}`),
  };
}

/**
 * Makes a string safe to use as one path segment on every OS: anything other
 * than letters, digits, `.`, `_` and `-` becomes `_`.
 */
export function fileSafe(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, 128) || '_';
}
