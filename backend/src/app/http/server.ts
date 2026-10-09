// app/http/server constructs a fully configured Fastify instance:
//   - request-id propagation (x-request-id header or generated)
//   - structured request logging (one record per request, never bodies)
//   - Prometheus instrumentation (request count + latency)
//   - per-user rate limit on /api (token bucket → 429)
//   - /api routes (docs/api-contract.md) with the {"data"} / {"error"} envelope
//   - /healthz /readyz /metrics ops routes
//   - optionally the built frontend (APP_STATIC_DIR, local installs)
//
// The factory does NOT call listen(); src/server.ts owns the lifecycle.

import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

import type { DatabaseHandle } from '../../adapter/sqlite/db.js';
import type { Logger } from '../../log.js';
import type { Metrics } from '../../platform/metrics.js';
import type { KeyedRateLimiter } from '../../platform/rate-limiter.js';

import { registerApiRoutes, type ApiServices } from './api-routes.js';
import { errorHandler, sendError } from './envelope.js';
import { identityOf } from './identity.js';
import { registerOpsRoutes } from './ops.js';
import { registerStaticRoutes } from './static.js';

export interface ServerDeps {
  logger: Logger;
  db: DatabaseHandle;
  metrics: Metrics;
  services: ApiServices;
  rateLimiter: KeyedRateLimiter;
  bodyLimitBytes: number;
  /** Serve the built frontend from this directory (local installs). */
  staticDir?: string;
}

export function createServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      if (typeof header === 'string' && /^[\w.-]{1,128}$/.test(header))
        return header;
      return randomUUID();
    },
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'request_id',
    disableRequestLogging: true,
    bodyLimit: deps.bodyLimitBytes,
  });

  // Fastify v5 over-narrows the instance generic when `genReqId` is set.
  const typed = app as unknown as FastifyInstance;

  // Accept an empty body with Content-Type: application/json (e.g. POST
  // .../test, DELETE) instead of failing; otherwise use Fastify's secure
  // JSON parser (prototype-poisoning protection).
  const jsonParser = typed.getDefaultJsonParser('error', 'error');
  typed.removeContentTypeParser('application/json');
  typed.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      if (text.trim() === '') {
        done(null, undefined);
        return;
      }
      void jsonParser(req, text, done);
    },
  );

  typed.setErrorHandler(errorHandler(deps.logger));
  typed.setNotFoundHandler(async (req, reply) =>
    sendError(
      reply,
      404,
      `No route for ${req.method} ${req.url.split('?')[0] ?? ''}`,
    ),
  );

  typed.addHook('onRequest', async (req, reply) => {
    req.headers['x-request-id'] = req.id;
    // Echo the request id so clients can quote it in bug reports.
    reply.header('x-request-id', req.id);
    if (!req.url.startsWith('/api/')) return;
    const identity = identityOf(req);
    if (!deps.rateLimiter.tryTake(identity.scope)) {
      reply.header('retry-after', '1');
      return sendError(
        reply,
        429,
        'Too many requests; slow down and retry shortly',
      );
    }
  });

  typed.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    const status = reply.statusCode;
    const latencyMs = reply.elapsedTime;
    deps.logger.info(
      {
        method: req.method,
        // Path only: query strings may carry filters with user data.
        uri: req.url.split('?')[0],
        route,
        status,
        latency_ms: latencyMs,
        request_id: req.id,
      },
      'request',
    );
    deps.metrics.httpRequestsTotal
      .labels(req.method, route, String(status))
      .inc();
    deps.metrics.httpRequestDurationSeconds
      .labels(req.method, route)
      .observe(latencyMs / 1000);
  });

  registerApiRoutes(typed, deps.services);
  registerOpsRoutes(typed, deps.db, deps.metrics);
  if (deps.staticDir) registerStaticRoutes(typed, deps.staticDir);

  return typed;
}
