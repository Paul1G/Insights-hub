// adapter/simulator/registry keeps one AmSimulator per simulator connection,
// loading its state lazily from <dataDir>/simulator/<connectionId>/ and
// exposing it through the UpstreamTransport port, so services treat the
// simulator exactly like a real tenant.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type {
  UpstreamRequest,
  UpstreamResponse,
  UpstreamTransport,
} from '../../domain/upstream/transport.js';
import type { Logger } from '../../log.js';
import type { Clock, Sleep } from '../../platform/clock.js';

import { AmSimulator } from './simulator.js';
import { TenantStore } from './store.js';
import { SimTenant } from './tenant.js';

export const newSimId = (): string => randomUUID().replace(/-/g, '');

export class SimulatorRegistry {
  private readonly baseDir: string;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly latencyMs: number;
  private readonly newId: () => string;
  private readonly sims = new Map<string, AmSimulator>();

  constructor(o: {
    dataDir: string;
    logger: Logger;
    clock: Clock;
    sleep: Sleep;
    latencyMs: number;
    newId?: () => string;
  }) {
    this.baseDir = join(o.dataDir, 'simulator');
    this.logger = o.logger;
    this.clock = o.clock;
    this.sleep = o.sleep;
    this.latencyMs = o.latencyMs;
    this.newId = o.newId ?? newSimId;
  }

  /** The simulator for a connection; `tenant` follows the connection. */
  simulator(connectionId: string, tenant: string): AmSimulator {
    const hit = this.sims.get(connectionId);
    if (hit) {
      hit.tenant.tenant = tenant;
      return hit;
    }
    const store = new TenantStore(this.baseDir, connectionId, this.logger);
    const state = store.loadOrSeed(() => SimTenant.seed(tenant, this.newId()));
    const sim = new AmSimulator({
      tenant: new SimTenant({ ...state, tenant }),
      store,
      logger: this.logger,
      now: () => new Date(this.clock.now()).toISOString(),
      newId: this.newId,
    });
    this.sims.set(connectionId, sim);
    return sim;
  }

  transport(connectionId: string, tenant: string): UpstreamTransport {
    return {
      send: async (req: UpstreamRequest): Promise<UpstreamResponse> => {
        if (this.latencyMs > 0) await this.sleep(this.latencyMs);
        return this.simulator(connectionId, tenant).handle(req);
      },
    };
  }

  async destroy(connectionId: string): Promise<void> {
    const sim = this.sims.get(connectionId);
    this.sims.delete(connectionId);
    if (sim) await sim.destroy();
    else
      await new TenantStore(this.baseDir, connectionId, this.logger).destroy();
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.sims.values()].map((s) => s.flush()));
  }
}
