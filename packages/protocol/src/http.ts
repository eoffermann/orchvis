import { z } from 'zod';
import { RejectCodeSchema } from './errors.js';
import { MediaRefSchema } from './model.js';

/**
 * Error body of every broker HTTP endpoint: a rejection code, or `not_found`
 * for an unknown or expired media ID, plus an optional human-readable detail.
 */
export const HttpErrorSchema = z.object({
  error: z.union([RejectCodeSchema, z.literal('not_found')]),
  detail: z.string().max(1024).optional(),
});

/** Error body of every broker HTTP endpoint. */
export type HttpError = z.infer<typeof HttpErrorSchema>;

/** Multipart field carrying the uploaded file in `POST /api/media`. */
export const MEDIA_FILE_FIELD = 'file';

/** Multipart field carrying the required caption in `POST /api/media`. */
export const MEDIA_CAPTION_FIELD = 'caption';

/**
 * Success body of `POST /api/media`: the stored {@link MediaRefSchema}, sent
 * with status `201`.
 *
 * The request is `multipart/form-data` with one {@link MEDIA_FILE_FIELD} part
 * (its filename and declared content type are used) and one
 * {@link MEDIA_CAPTION_FIELD} text field, in either order. A shim
 * authenticates with both the {@link SHIM_TOKEN_HEADER} and
 * {@link UPLOAD_KEY_HEADER} headers, and the upload is bound to the session
 * behind that key. The Owner authenticates with the {@link OWNER_COOKIE}, and
 * the upload is bound to the Owner. The broker sniffs the content and sanitizes
 * the caption and filename. Errors, each with an {@link HttpErrorSchema} body:
 * - `401 unauthorized`: missing or wrong token, upload key or cookie.
 * - `400 invalid`: missing file or caption, empty caption, or more than one file.
 * - `413 too_large`: the file is over `maxMediaBytes` or the caption over `maxCaptionBytes`.
 * - `415 invalid`: the sniffed type does not match the declared type.
 * - `429 rate_limited`: too many uploads from this session or the Owner.
 *
 * `GET /api/media/:id` takes the same auth, supports a single `Range`, and
 * answers `404 not_found` once the item has expired. It serves media with
 * `X-Content-Type-Options: nosniff`, and HTML, SVG and anything not image,
 * audio, video or plain text as an attachment download.
 */
export const MediaUploadResponseSchema = MediaRefSchema;

/** Success body of `POST /api/media`. */
export type MediaUploadResponse = z.infer<typeof MediaUploadResponseSchema>;

/** Liveness endpoint. No auth. */
export const HEALTH_PATH = '/healthz';

/** Owner login endpoint. */
export const LOGIN_PATH = '/api/login';

/** Owner logout endpoint. */
export const LOGOUT_PATH = '/api/logout';

/** Media upload endpoint; `GET ${MEDIA_PATH}/:id` downloads, with Range support. */
export const MEDIA_PATH = '/api/media';

/** Header carrying the shim token on HTTP requests from a shim. */
export const SHIM_TOKEN_HEADER = 'x-orchvis-token';

/**
 * Header carrying the connection's `welcome.uploadKey` on HTTP media requests
 * from a shim. It binds an upload to one session, since every shim shares the
 * same shim token.
 */
export const UPLOAD_KEY_HEADER = 'x-orchvis-upload-key';

/**
 * Name of the Owner session cookie, set by `POST /api/login`. Its value is an
 * opaque session ID, never the Owner token. It is `HttpOnly`,
 * `SameSite=Strict` and `Path=/`, and lives until logout or broker restart.
 */
export const OWNER_COOKIE = 'orchvis_owner';

/**
 * Body of `POST /api/login`, sent as JSON. Answers: `204` with the
 * {@link OWNER_COOKIE} set; `401 {"error":"unauthorized"}` for a wrong token;
 * `400 {"error":"invalid"}` for a malformed body.
 */
export const LoginRequestSchema = z.object({ token: z.string().min(1).max(512) });

/** Body of `POST /api/login`. */
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * WebSocket close codes the broker uses on `/ws/ui` and `/ws/shim`. The
 * broker accepts the upgrade and then closes with one of these, because a
 * browser cannot read the HTTP status of a refused upgrade. A client treats
 * any other close as transient and reconnects with backoff.
 */
export const WS_CLOSE = Object.freeze({
  /** `/ws/ui`: missing, unknown or expired Owner cookie. The web app shows the login page. */
  unauthorized: 4401,
  /** `/ws/ui`: the Origin header does not match the broker's own origin. */
  forbiddenOrigin: 4403,
  /**
   * `/ws/shim`: `hello` was rejected (or never arrived); the preceding
   * `rejected` frame, when there is one, says why. After `unauthorized` a
   * shim stops retrying, since only a config fix helps.
   */
  helloRejected: 4400,
  /** `/ws/shim`: no frame within `disconnectAfterMs`. Reconnect with backoff. */
  heartbeatTimeout: 4408,
  /**
   * `/ws/shim`: a newer connection with the same session ID took over. Do not
   * reconnect, or two shims for one session would take turns evicting each
   * other.
   */
  replaced: 4409,
  /** Either endpoint: the broker is shutting down. Reconnect with backoff. */
  shuttingDown: 4503,
});
