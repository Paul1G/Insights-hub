// adapter/endpoint-factory implements the EndpointFactory port: real
// connections get a FetchTransport plus the token provider of their auth
// mode; simulator connections get the in-process simulator. URLs are checked
// against the SSRF guard again here, so tightening APP_ALLOWED_HOST_SUFFIXES
// also blocks connections that were stored earlier.

import type { ConnectionRecord } from '../domain/connection/connection.js';
import type { EndpointFactory } from '../domain/connection/endpoint-factory.js';
import { checkUpstreamUrl } from '../domain/connection/url-guard.js';
import { ValidationError } from '../domain/errors.js';
import type { UpstreamEndpoint } from '../domain/upstream/transport.js';
import type { Clock } from '../platform/clock.js';

import { FetchTransport, type FetchFn } from './http/fetch-transport.js';
import {
  AppCredentialsTokenProvider,
  ClientCredentialsTokenProvider,
  StaticBearerTokenProvider,
} from './http/token-providers.js';
import type { SimulatorRegistry } from './simulator/registry.js';

export class DefaultEndpointFactory implements EndpointFactory {
  private readonly fetchFn: FetchFn;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly allowedHostSuffixes: readonly string[];
  private readonly simulators: SimulatorRegistry;

  constructor(o: {
    fetch: FetchFn;
    clock: Clock;
    timeoutMs: number;
    allowedHostSuffixes: readonly string[];
    simulators: SimulatorRegistry;
  }) {
    this.fetchFn = o.fetch;
    this.clock = o.clock;
    this.timeoutMs = o.timeoutMs;
    this.allowedHostSuffixes = o.allowedHostSuffixes;
    this.simulators = o.simulators;
  }

  create(rec: ConnectionRecord): UpstreamEndpoint {
    const { auth } = rec.config;
    if (auth.mode === 'simulator') {
      return {
        transport: this.simulators.transport(rec.id, rec.config.tenant),
      };
    }
    const transport = new FetchTransport({
      baseUrl: this.guard('apiBaseUrl', rec.config.apiBaseUrl),
      fetch: this.fetchFn,
      timeoutMs: this.timeoutMs,
    });
    const common = {
      fetch: this.fetchFn,
      clock: this.clock,
      timeoutMs: this.timeoutMs,
    };
    switch (auth.mode) {
      case 'bearer':
        return { transport, tokens: new StaticBearerTokenProvider(auth.token) };
      case 'client_credentials':
        return {
          transport,
          tokens: new ClientCredentialsTokenProvider({
            ...common,
            tokenUrl: this.guard('tokenUrl', auth.tokenUrl),
            clientId: auth.clientId,
            clientSecret: auth.clientSecret,
          }),
        };
      case 'app_credentials':
        return {
          transport,
          tokens: new AppCredentialsTokenProvider({
            ...common,
            tokenUrl: this.guard('tokenUrl', auth.tokenUrl),
            clientId: auth.clientId,
            clientSecret: auth.clientSecret,
            appName: auth.appName,
            appVersion: auth.appVersion,
            hostTenant: auth.hostTenant,
            userTenant: auth.userTenant,
          }),
        };
    }
  }

  async destroy(connectionId: string): Promise<void> {
    await this.simulators.destroy(connectionId);
  }

  private guard(field: string, url: string | undefined): string {
    if (url === undefined)
      throw new ValidationError(`The connection has no ${field}`);
    const check = checkUpstreamUrl(url, this.allowedHostSuffixes);
    if (!check.ok)
      throw new ValidationError(
        `The stored ${field} is no longer allowed: ${check.reason}`,
      );
    return check.url;
  }
}
