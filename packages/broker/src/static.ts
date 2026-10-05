import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Content-Security-Policy sent on every broker response, HTML included. No
 * inline script; inline styles are allowed for the graph's computed styles.
 */
export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
  "media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** Default location of the built web app: `packages/broker/public`. */
export function defaultPublicDir(): string {
  return fileURLToPath(new URL('../public', import.meta.url));
}

/** Page served at `/` when no web build is present. Plain HTML, no script. */
export const PLACEHOLDER_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>orchvis broker</title></head>' +
  '<body><p>The orchvis broker is running. The web app is not built yet.</p></body></html>\n';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Paths that belong to the API or the sockets, never to the web app. */
function isReserved(path: string): boolean {
  return path === '/api' || path.startsWith('/api/') || path === '/ws' || path.startsWith('/ws/') || path === '/healthz';
}

function fileIn(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const full = resolve(root, `.${normalize(`/${decoded}`)}`);
  if (full !== root && !full.startsWith(root + sep)) return undefined;
  try {
    return statSync(full).isFile() ? full : undefined;
  } catch {
    return undefined;
  }
}

function sendFile(reply: FastifyReply, path: string): FastifyReply {
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const html = type.startsWith('text/html');
  return reply
    .code(200)
    .type(type)
    .header('cache-control', html ? 'no-cache' : 'public, max-age=300')
    .send(createReadStream(path));
}

/**
 * Serves the web app from `publicDir`: a file when one matches, else
 * `index.html` for client routes (paths without an extension), else 404.
 * Without a build, `/` and client routes get {@link PLACEHOLDER_HTML}. API
 * and socket paths are never served from here; unknown ones get a JSON 404.
 */
export function registerStatic(app: FastifyInstance, publicDir: string): void {
  const root = resolve(publicDir);
  const index = join(root, 'index.html');
  app.setNotFoundHandler(async (request, reply) => {
    const path = (request.url.split('?')[0] ?? '/') || '/';
    const notFound = () => reply.code(404).type('application/json; charset=utf-8').send({ error: 'not_found' });
    if ((request.method !== 'GET' && request.method !== 'HEAD') || isReserved(path)) return notFound();
    const file = path === '/' ? undefined : fileIn(root, path);
    if (file) return sendFile(reply, file);
    if (extname(path) !== '') return notFound();
    if (existsSync(index)) return sendFile(reply, index);
    return reply.code(200).type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(PLACEHOLDER_HTML);
  });
}
