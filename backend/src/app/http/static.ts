// app/http/static serves the built frontend (apps/web/dist) from the backend
// for local installations without a reverse proxy (e.g. on Windows):
// one process on :8080 serves the app and its /api.
//
// Enabled only when APP_STATIC_DIR is set. In the CREATE preview nginx serves
// the frontend and this stays off. The app uses a hash router, so every
// non-file path falls back to index.html.

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sendError } from './envelope.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Resolve a URL path inside root; undefined when it escapes root. */
export function resolveInside(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const target = resolve(root, `.${sep}${normalize(decoded).replace(/^([/\\])+/, '')}`);
  const base = resolve(root);
  return target === base || target.startsWith(base + sep) ? target : undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function registerStaticRoutes(app: FastifyInstance, root: string): void {
  const index = join(root, 'index.html');

  const send = async (reply: FastifyReply, path: string) => {
    const ext = extname(path).toLowerCase();
    reply.type(CONTENT_TYPES[ext] ?? 'application/octet-stream');
    // Hashed build assets never change; the shell and service worker must be revalidated.
    reply.header(
      'cache-control',
      path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    return reply.send(await readFile(path));
  };

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const urlPath = req.url.split('?')[0] ?? '/';
    if (urlPath.startsWith('/api/') || urlPath === '/api') {
      return sendError(reply, 404, `No route for ${req.method} ${urlPath}`);
    }
    const target = resolveInside(root, urlPath);
    if (!target) return sendError(reply, 400, 'Invalid path');
    if (await isFile(target)) return send(reply, target);
    // Missing files with an extension are real 404s; everything else is the app.
    if (extname(urlPath)) return sendError(reply, 404, `Not found: ${urlPath}`);
    if (await isFile(index)) return send(reply, index);
    return sendError(reply, 404, 'The frontend build was not found in APP_STATIC_DIR.');
  };

  app.get('/', handler);
  app.get('/*', handler);
}
