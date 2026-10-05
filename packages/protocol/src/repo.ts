import { z } from 'zod';

/** A repository a session works in, grouped by its normalized remote. */
export const RepoRefSchema = z.object({
  /** Normalized remote such as `github.com/acme/orchestrator`, or a `local:` key. */
  key: z.string().min(1).max(512),
  /** Last path segment of the key, used for labels. */
  name: z.string().min(1).max(256),
  /** Current branch, when known. */
  branch: z.string().max(256).optional(),
});

/** A repository a session works in, grouped by its normalized remote. */
export type RepoRef = z.infer<typeof RepoRefSchema>;

const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * Normalizes a git remote URL into a repo key: `host/path` with the protocol,
 * credentials, port, trailing `.git` and trailing `/` removed and the host
 * lowercased. `git@host:org/repo` becomes `host/org/repo`.
 *
 * Returns `null` for remotes that are local paths or `file://` URLs, which
 * cannot group sessions across machines; the caller then uses
 * {@link localRepoKey}.
 */
export function normalizeRepoKey(remote: string): string | null {
  const input = remote.trim();
  if (!input || WINDOWS_DRIVE.test(input)) return null;

  let host: string;
  let path: string;

  if (URL_LIKE.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (url.protocol === 'file:') return null;
    host = url.hostname;
    path = decodeURIComponent(url.pathname);
  } else {
    const scp = SCP_LIKE.exec(input);
    if (!scp || !scp[1] || !scp[2]) return null;
    host = scp[1];
    path = scp[2];
  }

  host = host.toLowerCase().replace(/^\[|\]$/g, '');
  path = path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

  if (!host || !path) return null;
  return `${host}/${path}`;
}

/** Repo key for a directory with no usable remote: `local:<hostname>:<dirname>`. */
export function localRepoKey(hostname: string, directoryName: string): string {
  return `local:${hostname.trim().toLowerCase()}:${directoryName}`;
}

/** Label for a repo key: its last path segment. */
export function repoNameFromKey(key: string): string {
  const segments = key.split(/[/:]/).filter(Boolean);
  return segments[segments.length - 1] ?? key;
}
