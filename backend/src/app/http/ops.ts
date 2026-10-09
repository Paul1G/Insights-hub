// app/http/ops mounts the operational endpoints on a Fastify instance.
//   GET /healthz — liveness probe (always 200 if the process is running)
//   GET /readyz  — readiness probe (200 when DB responds, 503 otherwise)
//   GET /metrics — Prometheus scrape endpoint
//
// These routes are co-mounted on the main server for simplicity. The README
// documents how to split them onto a separate internal port.

import type { FastifyInstance } from 'fastify';

import { ping, type DatabaseHandle } from '../../adapter/sqlite/db.js';
import type { Metrics } from '../../platform/metrics.js';

// registerOpsRoutes registers /healthz /readyz /metrics on the given Fastify
// instance. Pass the same DatabaseHandle used by the adapters so readyz
// reflects the real connection state.
export function registerOpsRoutes(
  app: FastifyInstance,
  db: DatabaseHandle,
  metrics: Metrics,
): void {
  app.get('/healthz', (_req, reply) => reply.send({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    if (!ping(db)) {
      return reply
        .code(503)
        .send({ status: 'unavailable', reason: 'database unreachable' });
    }
    return reply.code(200).send({ status: 'ready' });
  });

  app.get('/metrics', async (_req, reply) => {
    const body = await metrics.registry.metrics();
    return reply.code(200).type(metrics.registry.contentType).send(body);
  });
}
