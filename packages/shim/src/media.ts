import { createHash } from 'node:crypto';
import { createWriteStream, openAsBlob, rmSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MediaRefSchema, sanitizeText, utf8Bytes, type Limits, type MediaRef } from '@orchvis/protocol';
import { fileSafe } from './identity.js';
import type { Logger } from './log.js';

/**
 * Header that carries the shim token on `/api/media` requests, as
 * `Bearer <token>`. The plan says "shim token header" without naming one; the
 * protocol package does not define it yet.
 */
export const SHIM_TOKEN_HEADER = 'authorization';

/** Formats a path with forward slashes, the `C:/Users/...` form on Windows. */
export function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Makes an untrusted filename safe for every OS: sanitized, path separators and
 * characters Windows forbids replaced, leading dots and trailing dots or spaces
 * removed, reserved device names avoided, length capped.
 */
export function safeFilename(name: string): string {
  let out = sanitizeText(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/&lt;/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(out)) out = `_${out}`;
  if (out.length > 100) {
    const ext = extname(out).slice(0, 16);
    out = out.slice(0, 100 - ext.length) + ext;
  }
  return out || 'file';
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.html': 'text/html',
  '.zip': 'application/zip',
};

/** MIME type from a file extension; the broker sniffs the content and rejects mismatches. */
export function guessMime(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/** An attachment as given to `send_message`. */
export interface AttachmentInput {
  path: string;
  caption: string;
}

/** A media failure with a code for the tool result. */
export class MediaError extends Error {
  /** `too_large`, `invalid`, `not_found`, `unauthorized`, `upload_failed`, `download_failed` or `checksum_mismatch`. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
  }
}

/** Where and how to reach the broker's media endpoints. */
export interface MediaEndpoint {
  /** HTTP base URL, no trailing slash. */
  httpBase: string;
  token: string;
}

/**
 * Checks attachments before any upload: caption present and within limits,
 * file present, a regular file, and within the size limit. Returns resolved
 * absolute paths in input order.
 */
export async function validateAttachments(
  attachments: AttachmentInput[],
  limits: Limits,
  cwd: string,
): Promise<Array<{ absPath: string; bytes: number; caption: string }>> {
  const out: Array<{ absPath: string; bytes: number; caption: string }> = [];
  for (const [i, a] of attachments.entries()) {
    const caption = a.caption?.trim() ?? '';
    if (!caption) throw new MediaError('invalid', `attachment ${i + 1} has no caption; every attachment needs one`);
    if (utf8Bytes(caption) > limits.maxCaptionBytes) {
      throw new MediaError('too_large', `attachment ${i + 1} caption is over ${limits.maxCaptionBytes} bytes`);
    }
    const absPath = isAbsolute(a.path) ? a.path : resolve(cwd, a.path);
    let size: number;
    try {
      const st = await stat(absPath);
      if (!st.isFile()) throw new MediaError('invalid', `attachment ${i + 1} is not a file: ${toForwardSlashes(absPath)}`);
      size = st.size;
    } catch (err) {
      if (err instanceof MediaError) throw err;
      throw new MediaError('not_found', `attachment ${i + 1} not found: ${toForwardSlashes(absPath)}`);
    }
    if (size > limits.maxMediaBytes) {
      throw new MediaError(
        'too_large',
        `attachment ${i + 1} is ${size} bytes, over the ${limits.maxMediaBytes}-byte limit`,
      );
    }
    out.push({ absPath, bytes: size, caption });
  }
  return out;
}

/**
 * Uploads one file to `POST /api/media` as multipart form data (the caption
 * field first, then the file), streamed from disk. Returns the broker's
 * `MediaRef`.
 */
export async function uploadMedia(
  endpoint: MediaEndpoint,
  file: { absPath: string; caption: string },
): Promise<MediaRef> {
  const name = basename(file.absPath);
  const blob = await openAsBlob(file.absPath, { type: guessMime(name) });
  const form = new FormData();
  form.append('caption', file.caption);
  form.append('file', blob, name);
  let response: Response;
  try {
    response = await fetch(`${endpoint.httpBase}/api/media`, {
      method: 'POST',
      headers: { [SHIM_TOKEN_HEADER]: `Bearer ${endpoint.token}` },
      body: form,
    });
  } catch (err) {
    throw new MediaError('upload_failed', `upload to ${endpoint.httpBase}/api/media failed: ${(err as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 413 ? 'too_large' : 'upload_failed';
    throw new MediaError(code, `upload of ${name} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MediaError('upload_failed', 'broker answered the upload with something other than JSON');
  }
  const ref = MediaRefSchema.safeParse(parsed);
  if (!ref.success) throw new MediaError('upload_failed', 'broker answered the upload without a valid MediaRef');
  return ref.data;
}

/** A fetched media file. */
export interface FetchedMedia {
  /** Local path, forward slashes. */
  path: string;
  ref: MediaRef;
  /** When the local copy will be deleted, ms since epoch. */
  localExpiresAt: number;
}

/**
 * The shim's local media directory, `<os temp>/orchvis/<raw session id>/`.
 * Fetched files are named `<mediaId>-<sanitized filename>`. A fetched copy
 * lives for one media TTL from when it was fetched, then is deleted; the whole
 * directory is removed on exit.
 */
export class MediaStore {
  /** Absolute directory path, native separators. */
  readonly dir: string;
  private readonly fetched = new Map<string, { absPath: string; localExpiresAt: number }>();
  private readonly log: Logger;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(rawSessionId: string, log: Logger, baseDir: string = tmpdir()) {
    this.dir = join(baseDir, 'orchvis', fileSafe(rawSessionId));
    this.log = log;
  }

  /** Starts sweeping expired fetched files every `intervalMs`. */
  startSweeping(intervalMs = 60_000): void {
    this.sweepTimer ??= setInterval(() => void this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  /** Local path a media ref is fetched to. */
  pathFor(ref: Pick<MediaRef, 'mediaId' | 'filename'>): string {
    return join(this.dir, `${fileSafe(ref.mediaId)}-${safeFilename(ref.filename)}`);
  }

  /**
   * Downloads a media file from `GET /api/media/:id`, verifies its SHA-256 and
   * size, and returns its local path. A file already fetched and unexpired is
   * returned as is.
   */
  async fetch(endpoint: MediaEndpoint, ref: MediaRef, ttlMs: number, now = Date.now()): Promise<FetchedMedia> {
    await this.sweep(now);
    const existing = this.fetched.get(ref.mediaId);
    if (existing) return { path: toForwardSlashes(existing.absPath), ref, localExpiresAt: existing.localExpiresAt };

    await mkdir(this.dir, { recursive: true });
    const absPath = this.pathFor(ref);
    const url = `${endpoint.httpBase}/api/media/${encodeURIComponent(ref.mediaId)}`;
    let response: Response;
    try {
      response = await fetch(url, { headers: { [SHIM_TOKEN_HEADER]: `Bearer ${endpoint.token}` } });
    } catch (err) {
      throw new MediaError('download_failed', `download from ${url} failed: ${(err as Error).message}`);
    }
    if (response.status === 404 || response.status === 410) {
      throw new MediaError('not_found', `media ${ref.mediaId} has expired or is unknown to the broker`);
    }
    if (!response.ok || !response.body) {
      const code = response.status === 401 || response.status === 403 ? 'unauthorized' : 'download_failed';
      throw new MediaError(code, `download of ${ref.mediaId} failed with HTTP ${response.status}`);
    }

    const hash = createHash('sha256');
    let bytes = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        cb(null, chunk);
      },
    });
    const tmp = `${absPath}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), tap, createWriteStream(tmp));
    } catch (err) {
      await rm(tmp, { force: true });
      throw new MediaError('download_failed', `download of ${ref.mediaId} broke off: ${(err as Error).message}`);
    }
    const digest = hash.digest('hex');
    if (digest !== ref.sha256 || bytes !== ref.bytes) {
      await rm(tmp, { force: true });
      throw new MediaError(
        'checksum_mismatch',
        `media ${ref.mediaId} failed verification (sha256 ${digest.slice(0, 12)}…, ${bytes} bytes); the file was discarded`,
      );
    }
    await rename(tmp, absPath);
    const localExpiresAt = now + ttlMs;
    this.fetched.set(ref.mediaId, { absPath, localExpiresAt });
    this.log.info(`fetched media ${ref.mediaId} (${bytes} bytes)`);
    return { path: toForwardSlashes(absPath), ref, localExpiresAt };
  }

  /** Deletes fetched files past their local expiry. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [id, f] of this.fetched) {
      if (f.localExpiresAt > now) continue;
      this.fetched.delete(id);
      await rm(f.absPath, { force: true }).catch(() => {});
      this.log.debug(`deleted expired fetched media ${id}`);
    }
  }

  /** Stops sweeping and removes the whole directory. Synchronous, for exit paths. */
  disposeSync(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.fetched.clear();
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // Best effort on exit.
    }
  }

  /** Lists files currently in the directory, for tests. */
  async list(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch {
      return [];
    }
  }
}
