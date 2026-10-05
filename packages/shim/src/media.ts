import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  HttpErrorSchema,
  MEDIA_CAPTION_FIELD,
  MEDIA_FILE_FIELD,
  MEDIA_PATH,
  MediaUploadResponseSchema,
  SHIM_TOKEN_HEADER,
  UPLOAD_KEY_HEADER,
  sanitizeText,
  utf8Bytes,
  type Limits,
  type MediaRef,
} from '@orchvis/protocol';
import { fileSafe } from './identity.js';
import type { Logger } from './log.js';

/**
 * Headers that authenticate a shim on the broker's HTTP media endpoints: the
 * shared shim token plus this connection's `welcome.uploadKey`. The single
 * place that builds them.
 */
export function shimAuthHeaders(endpoint: Pick<MediaEndpoint, 'token' | 'uploadKey'>): Record<string, string> {
  return { [SHIM_TOKEN_HEADER]: endpoint.token, [UPLOAD_KEY_HEADER]: endpoint.uploadKey };
}

/**
 * Maps a failed media HTTP response (status plus its `HttpErrorSchema` body,
 * when there is one) to a {@link MediaError} with a code and a plain
 * explanation. The single place that interprets broker HTTP errors.
 */
export function mediaHttpError(op: 'upload' | 'download', what: string, status: number, bodyText: string): MediaError {
  const parsed = (() => {
    try {
      const r = HttpErrorSchema.safeParse(JSON.parse(bodyText));
      return r.success ? r.data : undefined;
    } catch {
      return undefined;
    }
  })();
  const detail = parsed?.detail ? ` (${sanitizeText(parsed.detail)})` : '';
  const http = `HTTP ${status}${parsed ? ` ${parsed.error}` : ''}`;
  switch (status) {
    case 401:
    case 403:
      return new MediaError(
        'unauthorized',
        `the broker refused the ${op} of ${what}: shim token or upload key not accepted, ${http}${detail}. The upload key changes on every reconnect; retry once, and if it persists check ~/.orchvis/config.json`,
      );
    case 400:
      return new MediaError('invalid', `the broker refused the ${op} of ${what} as malformed, ${http}${detail}`);
    case 413:
      return new MediaError('too_large', `${what} is over the broker's size limit, ${http}${detail}`);
    case 415:
      return new MediaError(
        'invalid',
        `the content of ${what} does not match its file type, ${http}${detail}; check the file extension`,
      );
    case 429:
      return new MediaError('rate_limited', `too many uploads from this session, ${http}${detail}; wait a minute and retry`);
    case 404:
    case 410:
      if (op === 'download') return new MediaError('not_found', `media ${what} has expired or is unknown to the broker`);
      return new MediaError('upload_failed', `the broker has no media upload endpoint, ${http}${detail}`);
    default:
      return new MediaError(
        op === 'upload' ? 'upload_failed' : 'download_failed',
        `${op} of ${what} failed with ${http}${detail || (parsed ? '' : `: ${sanitizeText(bodyText.slice(0, 200))}`)}`,
      );
  }
}

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
  /** `too_large`, `invalid`, `not_found`, `unauthorized`, `rate_limited`, `upload_failed`, `download_failed` or `checksum_mismatch`. */
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
  /** The current connection's `welcome.uploadKey`. */
  uploadKey: string;
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

/** A filename safe inside a multipart `Content-Disposition` header. */
function dispositionFilename(name: string): string {
  return name.replace(/[\r\n]/g, '').replace(/"/g, '%22');
}

/**
 * Uploads one file to `POST /api/media` as multipart form data (the caption
 * field first, then the file), streamed from disk. Returns the broker's
 * `MediaRef`.
 *
 * It uses node:http, not fetch, and streams the body from a file stream it
 * owns. The broker can answer (401, 413, ...) before the whole file is sent:
 * - fetch turns a 401 to a streamed request into a network error (the fetch
 *   spec's credential-retry rule), hiding the broker's answer;
 * - a file-backed Blob body keeps being read by the HTTP client after the
 *   answer, and a late read failure (the file changed or vanished) rejects
 *   inside the client, where nothing can catch it.
 * Here, the first response wins: the body stream is stopped, and later socket
 * or file errors are ignored.
 */
export async function uploadMedia(
  endpoint: MediaEndpoint,
  file: { absPath: string; caption: string },
): Promise<MediaRef> {
  const name = basename(file.absPath);
  const url = new URL(`${endpoint.httpBase}${MEDIA_PATH}`);
  const boundary = `----orchvis-${randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${MEDIA_CAPTION_FIELD}"\r\n\r\n${file.caption}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="${MEDIA_FILE_FIELD}"; filename="${dispositionFilename(name)}"\r\n` +
      `Content-Type: ${guessMime(name)}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  let answered = false;
  async function* parts(): AsyncGenerator<Buffer> {
    yield head;
    const source = createReadStream(file.absPath);
    try {
      for await (const chunk of source) {
        if (answered) return;
        yield chunk as Buffer;
      }
    } catch (err) {
      if (answered) return;
      throw err;
    } finally {
      source.destroy();
    }
    if (!answered) yield tail;
  }

  let status: number;
  let text: string;
  try {
    ({ status, text } = await new Promise<{ status: number; text: string }>((resolveRes, rejectRes) => {
      const body = Readable.from(parts());
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(url, {
        method: 'POST',
        headers: { ...shimAuthHeaders(endpoint), 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      const failEarly = (err: Error): void => {
        if (answered) return;
        answered = true;
        body.destroy();
        req.destroy();
        rejectRes(err);
      };
      req.on('error', failEarly);
      body.on('error', failEarly);
      req.on('response', (res) => {
        answered = true;
        body.unpipe(req);
        body.destroy();
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolveRes({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', rejectRes);
        res.on('aborted', () => rejectRes(new Error('the broker closed the connection mid-response')));
      });
      body.pipe(req);
    }));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new MediaError('upload_failed', `upload to ${url.origin}${MEDIA_PATH} failed: ${e.code ?? e.message}`);
  }
  if (status < 200 || status >= 300) throw mediaHttpError('upload', name, status, text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MediaError('upload_failed', 'broker answered the upload with something other than JSON');
  }
  const ref = MediaUploadResponseSchema.safeParse(parsed);
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
    const url = `${endpoint.httpBase}${MEDIA_PATH}/${encodeURIComponent(ref.mediaId)}`;
    let response: Response;
    try {
      response = await fetch(url, { headers: shimAuthHeaders(endpoint) });
    } catch (err) {
      throw new MediaError('download_failed', `download from ${url} failed: ${(err as Error).message}`);
    }
    if (!response.ok) throw mediaHttpError('download', ref.mediaId, response.status, await response.text().catch(() => ''));
    if (!response.body) throw new MediaError('download_failed', `download of ${ref.mediaId} returned no body`);

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
