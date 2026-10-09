// platform/metrics is the shared Prometheus registry and reusable metrics.
// The HTTP server records request counts and latency; the upstream client
// records attempts and retries per auth mode.

import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpRequestsTotal: Counter<'method' | 'path' | 'status'>;
  httpRequestDurationSeconds: Histogram<'method' | 'path'>;
  upstreamAttemptsTotal: Counter<'mode' | 'outcome'>;
  upstreamRetriesTotal: Counter<'mode' | 'reason'>;
}

// createMetrics builds a fresh Metrics bundle backed by an isolated Registry.
// Tests construct a new one per case to avoid cross-test contamination.
export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests by method, path, and status.',
    labelNames: ['method', 'path', 'status'] as const,
    registers: [registry],
  });

  const httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency distribution.',
    labelNames: ['method', 'path'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const upstreamAttemptsTotal = new Counter({
    name: 'upstream_attempts_total',
    help: 'Upstream Asset Management HTTP attempts by auth mode and outcome (status code or "network").',
    labelNames: ['mode', 'outcome'] as const,
    registers: [registry],
  });

  const upstreamRetriesTotal = new Counter({
    name: 'upstream_retries_total',
    help: 'Upstream retries by auth mode and reason.',
    labelNames: ['mode', 'reason'] as const,
    registers: [registry],
  });

  return {
    registry,
    httpRequestsTotal,
    httpRequestDurationSeconds,
    upstreamAttemptsTotal,
    upstreamRetriesTotal,
  };
}
