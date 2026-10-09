// wiring is the composition root: config → data dir → db → adapters →
// services → HTTP server. src/server.ts uses it for the real process; tests
// use it with an in-memory database, a temp data dir and injected
// fetch/clock/sleep/random.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';

import {
  AesGcmCipher,
  loadEncryptionKey,
  type KeySource,
} from './adapter/crypto/cipher.js';
import { DefaultEndpointFactory } from './adapter/endpoint-factory.js';
import type { FetchFn } from './adapter/http/fetch-transport.js';
import { SimulatorRegistry } from './adapter/simulator/registry.js';
import { SqliteAuditRepository } from './adapter/sqlite/audit-repo.js';
import { SqliteConnectionRepository } from './adapter/sqlite/connection-repo.js';
import {
  closeDatabase,
  migrate,
  openDatabase,
  type DatabaseHandle,
} from './adapter/sqlite/db.js';
import { createServer } from './app/http/server.js';
import { AmProxyService } from './app/service/am-proxy.js';
import { AuditService } from './app/service/audit.js';
import { ConnectionRuntime } from './app/service/connection-runtime.js';
import { ConnectionService } from './app/service/connections.js';
import { FilesService } from './app/service/files.js';
import { ListerService } from './app/service/lister.js';
import type { RetryPolicy } from './app/service/upstream-client.js';
import type { Config } from './config.js';
import type { EndpointFactory } from './domain/connection/endpoint-factory.js';
import type { Logger } from './log.js';
import {
  realSleep,
  systemClock,
  type Clock,
  type Random,
  type Sleep,
} from './platform/clock.js';
import { createMetrics, type Metrics } from './platform/metrics.js';
import { KeyedRateLimiter } from './platform/rate-limiter.js';

export interface WiringOverrides {
  fetch?: FetchFn;
  clock?: Clock;
  sleep?: Sleep;
  random?: Random;
  retryPolicy?: RetryPolicy;
  /** Replace the endpoint factory entirely (tests with fake upstreams). */
  endpointFactory?: (simulators: SimulatorRegistry) => EndpointFactory;
}

export interface Application {
  app: FastifyInstance;
  db: DatabaseHandle;
  metrics: Metrics;
  simulators: SimulatorRegistry;
  keySource: KeySource['origin'];
  close(): Promise<void>;
}

export function buildApplication(
  cfg: Config,
  logger: Logger,
  o: WiringOverrides = {},
): Application {
  const clock = o.clock ?? systemClock;
  const sleep = o.sleep ?? realSleep;
  const random = o.random ?? Math.random;
  const fetchFn = o.fetch ?? globalThis.fetch.bind(globalThis);

  mkdirSync(cfg.dataDir, { recursive: true });
  const key = loadEncryptionKey(cfg.encryptionKey, cfg.dataDir);
  const cipher = new AesGcmCipher(key.key);

  const db = openDatabase(cfg.dbPath);
  migrate(db);

  const metrics = createMetrics();
  const connectionsRepo = new SqliteConnectionRepository(db, cipher);
  const auditRepo = new SqliteAuditRepository(db);

  const simulators = new SimulatorRegistry({
    dataDir: cfg.dataDir,
    logger,
    clock,
    sleep,
    latencyMs: cfg.simulatorLatencyMs,
  });
  const factory: EndpointFactory = o.endpointFactory
    ? o.endpointFactory(simulators)
    : new DefaultEndpointFactory({
        fetch: fetchFn,
        clock,
        timeoutMs: cfg.upstreamTimeoutMs,
        allowedHostSuffixes: cfg.allowedHostSuffixes,
        simulators,
      });
  const runtime = new ConnectionRuntime({
    factory,
    concurrency: cfg.upstreamConcurrency,
    ...(o.retryPolicy ? { policy: o.retryPolicy } : {}),
    sleep,
    clock,
    random,
    metrics,
  });

  const audit = new AuditService({
    repo: auditRepo,
    connections: connectionsRepo,
    clock,
    newId: randomUUID,
    logger,
  });
  const connections = new ConnectionService({
    repo: connectionsRepo,
    runtime,
    audit,
    clock,
    newId: randomUUID,
    allowedHostSuffixes: cfg.allowedHostSuffixes,
  });
  const proxy = new AmProxyService({ connections, runtime, audit });
  const lister = new ListerService({ connections, runtime, clock });
  const files = new FilesService({ connections, proxy });

  const app = createServer({
    logger,
    db,
    metrics,
    services: { connections, proxy, lister, files, audit },
    rateLimiter: new KeyedRateLimiter({
      perSecond: cfg.rateLimitPerSecond,
      burst: cfg.rateLimitBurst,
      clock,
    }),
    bodyLimitBytes: cfg.bodyLimitBytes,
    ...(cfg.staticDir ? { staticDir: cfg.staticDir } : {}),
  });

  return {
    app,
    db,
    metrics,
    simulators,
    keySource: key.origin,
    close: async () => {
      await app.close();
      await simulators.flushAll();
      closeDatabase(db);
    },
  };
}
