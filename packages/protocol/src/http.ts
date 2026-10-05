import { z } from 'zod';

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
  /** `/ws/shim`: `hello` was rejected; the preceding `rejected` frame says why. */
  helloRejected: 4400,
  /** Either endpoint: the broker is shutting down. Reconnect with backoff. */
  shuttingDown: 4503,
});
