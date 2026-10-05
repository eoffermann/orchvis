import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  LOGIN_PATH,
  LOGOUT_PATH,
  LoginRequestSchema,
  MEDIA_CAPTION_FIELD,
  MEDIA_FILE_FIELD,
  MEDIA_PATH,
  SHIM_TOKEN_HEADER,
  UPLOAD_KEY_HEADER,
  mediaKindOf,
  sanitizeText,
  type HttpError,
  type Limits,
  type MediaRef,
} from '@orchvis/protocol';
import { LOGIN_FAILURES_PER_MINUTE, OwnerSessions, clearedOwnerCookie, ownerCookie } from './auth.js';
import type { Clock } from './clock.js';
import { timingSafeEqualStr, type BrokerCore } from './core.js';
import type { Logger } from './log.js';
import {
  SNIFF_HEAD_BYTES,
  contentDisposition,
  deleteQuietly,
  newMediaId,
  sanitizeFilename,
  servedInline,
  sniffMime,
  type MediaUploader,
  type StoredMedia,
} from './media.js';
import { RollingRateLimiter } from './rate-limit.js';

/** Largest login request body read, in bytes. */
export const MAX_LOGIN_BODY_BYTES = 4096;

/** Everything the HTTP routes need from the running broker. */
export interface RouteContext {
  core: BrokerCore;
  limits: Limits;
  clock: Clock;
  logger: Logger;
  shimToken: string;
  ownerToken: string;
  sessions: OwnerSessions;
}

/** A status code and {@link HttpError} body. */
interface Failure {
  status: number;
  body: HttpError;
}

function fail(status: number, error: HttpError['error'], detail?: string): Failure {
  return { status, body: detail === undefined ? { error } : { error, detail } };
}

function sendFailure(reply: FastifyReply, f: Failure): FastifyReply {
  return reply.code(f.status).type('application/json; charset=utf-8').send(f.body);
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Who a media request comes from. With either shim header present, both must
 * be: the shim token, and the upload key of an open shim connection, whose
 * session the request is bound to. Otherwise the Owner cookie must name a
 * live login session. Undefined means not authenticated.
 */
export function mediaRequester(headers: IncomingHttpHeaders, ctx: RouteContext): MediaUploader | undefined {
  const token = headerValue(headers, SHIM_TOKEN_HEADER);
  const key = headerValue(headers, UPLOAD_KEY_HEADER);
  if (headers[SHIM_TOKEN_HEADER] !== undefined || headers[UPLOAD_KEY_HEADER] !== undefined) {
    if (token === undefined || key === undefined || !timingSafeEqualStr(token, ctx.shimToken)) return undefined;
    const id = ctx.core.sessionForUploadKey(key);
    return id === undefined ? undefined : { kind: 'session', id };
  }
  return ctx.sessions.fromHeaders(headers) !== undefined ? { kind: 'owner' } : undefined;
}

async function readCapped(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) over = true;
    else chunks.push(chunk as Buffer);
  }
  return over ? undefined : Buffer.concat(chunks);
}

/** Hashes and counts bytes passing through, keeping the first {@link SNIFF_HEAD_BYTES} for sniffing. */
class Tap extends Transform {
  readonly hash = createHash('sha256');
  bytes = 0;
  private readonly head: Buffer[] = [];
  private headBytes = 0;

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    if (this.headBytes < SNIFF_HEAD_BYTES) {
      const part = chunk.subarray(0, SNIFF_HEAD_BYTES - this.headBytes);
      this.head.push(part);
      this.headBytes += part.length;
    }
    cb(null, chunk);
  }

  /** The first bytes of the file. */
  headBuffer(): Buffer {
    return Buffer.concat(this.head);
  }
}

/**
 * Streams one multipart upload to disk and turns it into a stored item, or a
 * failure. The partial file is deleted on every failure.
 */
async function receiveUpload(req: IncomingMessage, ctx: RouteContext, uploader: MediaUploader): Promise<StoredMedia | Failure> {
  const store = ctx.core.media;
  const fileCap = Math.min(ctx.limits.maxMediaBytes, ctx.limits.mediaStoreBytes);
  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: req.headers,
      // One byte over each cap, so a value exactly at the cap is not mistaken for a truncated one.
      limits: { fileSize: fileCap + 1, fieldSize: ctx.limits.maxCaptionBytes + 1, fields: 8, parts: 16, headerPairs: 32 },
    });
  } catch {
    req.resume();
    return fail(400, 'invalid', 'expected multipart/form-data');
  }

  const mediaId = newMediaId();
  const path = store.pathFor(mediaId);
  let fileCount = 0;
  let tooLarge = false;
  let captionTooLarge = false;
  let captionCount = 0;
  let caption: string | undefined;
  let rawFilename: string | undefined;
  let declared = '';
  let tap: Tap | undefined;
  let written: Promise<void> | undefined;

  parser.on('file', (name, stream, info) => {
    fileCount++;
    if (name !== MEDIA_FILE_FIELD || fileCount > 1) {
      stream.resume();
      return;
    }
    rawFilename = info.filename;
    declared = info.mimeType;
    const t = new Tap();
    tap = t;
    stream.on('limit', () => {
      tooLarge = true;
    });
    written = pipeline(stream, t, createWriteStream(path));
    // Keep the rejection observed until it is awaited below.
    written.catch(() => {});
  });
  parser.on('field', (name, value, info) => {
    if (name !== MEDIA_CAPTION_FIELD) return;
    captionCount++;
    caption = value;
    if (info.valueTruncated || Buffer.byteLength(value, 'utf8') > ctx.limits.maxCaptionBytes) captionTooLarge = true;
  });

  try {
    await pipeline(req, parser);
    if (written) await written;
  } catch {
    deleteQuietly(path);
    return fail(400, 'invalid', 'malformed or interrupted upload');
  }

  const failure = ((): Failure | undefined => {
    if (fileCount > 1) return fail(400, 'invalid', 'exactly one file is allowed');
    if (tooLarge || (tap?.bytes ?? 0) > fileCap) return fail(413, 'too_large', `file is over ${fileCap} bytes`);
    if (captionTooLarge) return fail(413, 'too_large', `caption is over ${ctx.limits.maxCaptionBytes} bytes`);
    if (fileCount === 0 || !tap) return fail(400, 'invalid', `missing ${MEDIA_FILE_FIELD}`);
    if (captionCount !== 1 || caption === undefined) return fail(400, 'invalid', `exactly one ${MEDIA_CAPTION_FIELD} is required`);
    return undefined;
  })();
  if (failure || !tap) {
    deleteQuietly(path);
    return failure ?? fail(400, 'invalid');
  }
  const cleanCaption = sanitizeText(caption ?? '').trim();
  if (!cleanCaption) {
    deleteQuietly(path);
    return fail(400, 'invalid', 'caption is empty');
  }
  const sniffed = await sniffMime(tap.headBuffer(), declared);
  if (!sniffed.ok) {
    deleteQuietly(path);
    return fail(415, 'invalid', sniffed.reason);
  }
  if (store.isClosed) {
    deleteQuietly(path);
    return fail(503, 'invalid', 'broker shutting down');
  }
  const now = ctx.clock.now();
  const ref: MediaRef = {
    mediaId,
    mime: sniffed.mime,
    filename: sanitizeFilename(rawFilename),
    bytes: tap.bytes,
    sha256: tap.hash.digest('hex'),
    caption: cleanCaption,
    expiresAt: now + ctx.limits.mediaTtlMs,
  };
  return { ref, kind: mediaKindOf(ref.mime), uploader, storedAt: now, path, attachment: undefined };
}

/** A single byte range, or a range that cannot be satisfied. Undefined means serve the whole file. */
export type RangeResult = { start: number; end: number } | 'unsatisfiable' | undefined;

/**
 * Parses a `Range` header against a file of `size` bytes. Only one
 * `bytes=` range is supported; several ranges, other units or a malformed
 * header are ignored (the whole file is served), as RFC 9110 allows.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return undefined;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return undefined;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return undefined;
  if (a === '') {
    const n = Number(b);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (b !== '' && Number(b) < start) return undefined;
  if (start >= size) return 'unsatisfiable';
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  return { start, end };
}

/** Registers `POST /api/login`, `POST /api/logout`, `POST /api/media` and `GET /api/media/:id`. */
export function registerApiRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const loginFailures = new RollingRateLimiter(LOGIN_FAILURES_PER_MINUTE);
  const reject = (reply: FastifyReply, endpoint: string, f: Failure) => {
    ctx.logger.log('rejected', { endpoint, code: f.body.error, status: f.status, detail: f.body.detail });
    return sendFailure(reply, f);
  };

  app.post(LOGIN_PATH, async (request, reply) => {
    const remote = request.ip;
    const now = ctx.clock.now();
    if (loginFailures.count(remote, now) >= LOGIN_FAILURES_PER_MINUTE) {
      request.raw.resume();
      return reject(reply, 'login', fail(429, 'rate_limited', 'too many failed logins; wait a minute'));
    }
    const raw = await readCapped(request.raw, MAX_LOGIN_BODY_BYTES);
    let token: string | undefined;
    try {
      const parsed = raw ? LoginRequestSchema.safeParse(JSON.parse(raw.toString('utf8'))) : undefined;
      if (parsed?.success) token = parsed.data.token;
    } catch {
      token = undefined;
    }
    if (token === undefined) return reject(reply, 'login', fail(400, 'invalid'));
    if (!timingSafeEqualStr(token, ctx.ownerToken)) {
      loginFailures.tryAcquire(remote, now);
      ctx.logger.log('login_failed', { remote, failuresInWindow: loginFailures.count(remote, now) });
      return sendFailure(reply, fail(401, 'unauthorized'));
    }
    const session = ctx.sessions.create();
    ctx.logger.log('login', { remote, ownerSessions: ctx.sessions.size });
    return reply.code(204).header('set-cookie', ownerCookie(session)).send();
  });

  app.post(LOGOUT_PATH, async (request, reply) => {
    request.raw.resume();
    const session = ctx.sessions.fromHeaders(request.headers);
    if (session !== undefined) {
      ctx.sessions.delete(session);
      ctx.core.endOwnerSession(session);
      ctx.logger.log('logout', { remote: request.ip, ownerSessions: ctx.sessions.size });
    }
    return reply.code(204).header('set-cookie', clearedOwnerCookie()).send();
  });

  app.post(MEDIA_PATH, async (request, reply) => {
    const uploader = mediaRequester(request.headers, ctx);
    if (!uploader) {
      request.raw.resume();
      return reject(reply, 'media', fail(401, 'unauthorized'));
    }
    const who = uploader.kind === 'owner' ? 'owner' : uploader.id;
    if (!ctx.core.tryUpload(uploader)) {
      request.raw.resume();
      ctx.logger.log('rejected', { endpoint: 'media', code: 'rate_limited', status: 429, uploader: who });
      return sendFailure(reply, fail(429, 'rate_limited', `over ${ctx.limits.sendRatePerMinute} uploads per minute`));
    }
    const result = await receiveUpload(request.raw, ctx, uploader);
    if ('status' in result) {
      ctx.logger.log('rejected', { endpoint: 'media', code: result.body.error, status: result.status, uploader: who, detail: result.body.detail });
      return sendFailure(reply, result);
    }
    ctx.core.mediaStored(result);
    return reply.code(201).type('application/json; charset=utf-8').send(result.ref);
  });

  app.get<{ Params: { id: string } }>(`${MEDIA_PATH}/:id`, async (request, reply) => {
    const notFound = () => sendFailure(reply, fail(404, 'not_found'));
    const entry = ctx.core.media.get(request.params.id);
    const requester = mediaRequester(request.headers, ctx);
    const allowed =
      entry !== undefined &&
      requester !== undefined &&
      (requester.kind === 'owner' || ctx.core.sessionMayRead(requester.id, entry));
    if (!entry || !allowed || entry.ref.expiresAt <= ctx.clock.now()) {
      ctx.logger.log('media_denied', { authenticated: requester !== undefined });
      return notFound();
    }
    const { ref } = entry;
    const size = ref.bytes;
    const disposition = contentDisposition(servedInline(ref.mime) ? 'inline' : 'attachment', ref.filename);
    reply
      .header('content-type', ref.mime)
      .header('content-disposition', disposition)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, no-store');
    const range = parseRange(headerValue(request.headers, 'range'), size);
    if (range === 'unsatisfiable') {
      return reply.code(416).header('content-range', `bytes */${size}`).type('application/json; charset=utf-8').send({ error: 'invalid' });
    }
    if (range) {
      reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`).header('content-length', range.end - range.start + 1);
      return reply.send(createReadStream(entry.path, { start: range.start, end: range.end }));
    }
    reply.code(200).header('content-length', size);
    if (size === 0) return reply.send('');
    return reply.send(createReadStream(entry.path));
  });
}
