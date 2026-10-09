// domain/connection/endpoint-factory is the port that turns a stored
// connection into a ready UpstreamEndpoint (transport + token provider).
// Adapters decide what is behind it: Insights Hub over HTTPS, or the
// in-process simulator.

import type { UpstreamEndpoint } from '../upstream/transport.js';
import type { ConnectionRecord } from './connection.js';

export interface EndpointFactory {
  create(rec: ConnectionRecord): UpstreamEndpoint;
  /**
   * Called when a connection is deleted. Implementations drop per-connection
   * resources (e.g. simulator state on disk).
   */
  destroy(connectionId: string): Promise<void>;
}
