// app/service/connection-runtime caches one UpstreamClient per connection so
// that the token cache and the per-connection concurrency limit are shared by
// every request against that connection. A cached client is rebuilt whenever
// the connection's configuration changes (updatedAt) and dropped on delete.

import type { ConnectionRecord } from '../../domain/connection/connection.js';
import type { EndpointFactory } from '../../domain/connection/endpoint-factory.js';
import type { Clock, Random, Sleep } from '../../platform/clock.js';
import type { Metrics } from '../../platform/metrics.js';

import { UpstreamClient, type RetryPolicy } from './upstream-client.js';

export interface ConnectionRuntimeOptions {
  factory: EndpointFactory;
  concurrency: number;
  policy?: RetryPolicy;
  sleep: Sleep;
  clock: Clock;
  random: Random;
  metrics?: Metrics;
}

interface Entry {
  version: string;
  client: UpstreamClient;
}

export class ConnectionRuntime {
  private readonly o: ConnectionRuntimeOptions;
  private readonly clients = new Map<string, Entry>();

  constructor(o: ConnectionRuntimeOptions) {
    this.o = o;
  }

  client(rec: ConnectionRecord): UpstreamClient {
    const version = `${rec.updatedAt}|${rec.config.auth.mode}`;
    const hit = this.clients.get(rec.id);
    if (hit && hit.version === version) return hit.client;
    const client = new UpstreamClient({
      endpoint: this.o.factory.create(rec),
      mode: rec.config.auth.mode,
      concurrency: this.o.concurrency,
      ...(this.o.policy ? { policy: this.o.policy } : {}),
      sleep: this.o.sleep,
      clock: this.o.clock,
      random: this.o.random,
      ...(this.o.metrics ? { metrics: this.o.metrics } : {}),
    });
    this.clients.set(rec.id, { version, client });
    return client;
  }

  /** Forget the cached client (credentials changed). */
  evict(connectionId: string): void {
    this.clients.delete(connectionId);
  }

  /** Forget the client and release adapter resources (connection deleted). */
  async destroy(connectionId: string): Promise<void> {
    this.clients.delete(connectionId);
    await this.o.factory.destroy(connectionId);
  }
}
