// app/service/connections manages a user's tenant connections: validation
// (including the SSRF guard), write-only secrets, CRUD, and the connection
// test (GET /assets/root).

import {
  toSummary,
  type ConnectionConfig,
  type ConnectionInput,
  type ConnectionRecord,
  type ConnectionSummary,
  type ConnectionTestResult,
  type StoredAuth,
} from '../../domain/connection/connection.js';
import type { ConnectionRepository } from '../../domain/connection/repository.js';
import { checkUpstreamUrl } from '../../domain/connection/url-guard.js';
import {
  NotFoundError,
  UpstreamUnavailableError,
  ValidationError,
} from '../../domain/errors.js';
import type { Identity } from '../../domain/identity.js';
import type { Clock } from '../../platform/clock.js';

import type { AuditService } from './audit.js';
import type { ConnectionRuntime } from './connection-runtime.js';
import { decodeBody, upstreamMessage } from './upstream-body.js';

export const TENANT_PATTERN = /^[A-Za-z0-9_]{1,8}$/;
const NAME_MAX = 100;
const ENVIRONMENT_MAX = 40;
const FIELD_MAX = 255;
const SECRET_MAX = 8192;

export class ConnectionService {
  private readonly repo: ConnectionRepository;
  private readonly runtime: ConnectionRuntime;
  private readonly audit: AuditService;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly allowedHostSuffixes: readonly string[];

  constructor(o: {
    repo: ConnectionRepository;
    runtime: ConnectionRuntime;
    audit: AuditService;
    clock: Clock;
    newId: () => string;
    allowedHostSuffixes: readonly string[];
  }) {
    this.repo = o.repo;
    this.runtime = o.runtime;
    this.audit = o.audit;
    this.clock = o.clock;
    this.newId = o.newId;
    this.allowedHostSuffixes = o.allowedHostSuffixes;
  }

  async list(identity: Identity): Promise<ConnectionSummary[]> {
    const recs = await this.repo.list(identity.scope);
    return recs
      .map(toSummary)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /** Loads a connection owned by the caller or throws NotFoundError (404). */
  async getRecord(identity: Identity, id: string): Promise<ConnectionRecord> {
    const rec = await this.repo.get(identity.scope, id);
    if (!rec) throw new NotFoundError(`Unknown connection ${id}`);
    return rec;
  }

  async create(
    identity: Identity,
    input: ConnectionInput,
  ): Promise<ConnectionSummary> {
    const config = this.normalise(input, undefined);
    const now = this.isoNow();
    const rec: ConnectionRecord = {
      id: this.newId(),
      userId: identity.scope,
      createdAt: now,
      updatedAt: now,
      config,
    };
    await this.repo.insert(rec);
    await this.audit.record({
      userId: identity.scope,
      kind: 'connection',
      action: 'connection.create',
      connectionId: rec.id,
      connectionName: config.name,
      summary: `Created connection "${config.name}" (${config.auth.mode})`,
    });
    return toSummary(rec);
  }

  async update(
    identity: Identity,
    id: string,
    input: ConnectionInput,
  ): Promise<ConnectionSummary> {
    const existing = await this.getRecord(identity, id);
    const config = this.normalise(input, existing.config);
    const rec: ConnectionRecord = {
      ...existing,
      // A changed endpoint invalidates the previous test result.
      config,
      updatedAt: this.isoNow(existing.updatedAt),
    };
    if (!(await this.repo.update(rec))) {
      throw new NotFoundError(`Unknown connection ${id}`);
    }
    this.runtime.evict(id);
    await this.audit.record({
      userId: identity.scope,
      kind: 'connection',
      action: 'connection.update',
      connectionId: id,
      connectionName: config.name,
      summary: `Updated connection "${config.name}" (${config.auth.mode})`,
    });
    return toSummary(rec);
  }

  async delete(identity: Identity, id: string): Promise<void> {
    const existing = await this.getRecord(identity, id);
    if (!(await this.repo.delete(identity.scope, id))) {
      throw new NotFoundError(`Unknown connection ${id}`);
    }
    await this.runtime.destroy(id);
    await this.audit.record({
      userId: identity.scope,
      kind: 'connection',
      action: 'connection.delete',
      connectionId: id,
      connectionName: existing.config.name,
      summary: `Deleted connection "${existing.config.name}"`,
    });
  }

  async test(identity: Identity, id: string): Promise<ConnectionTestResult> {
    const rec = await this.getRecord(identity, id);
    const started = this.clock.now();
    let result: ConnectionTestResult;
    let status: number | undefined;
    let attempts: number | undefined;
    try {
      const out = await this.runtime.client(rec).execute({
        method: 'GET',
        path: '/assets/root',
        headers: { accept: 'application/hal+json, application/json' },
      });
      status = out.response.status;
      attempts = out.attempts;
      const body = decodeBody(out.response);
      if (status === 200 && body !== null && typeof body === 'object') {
        const root = body as { assetId?: unknown; name?: unknown };
        result = {
          ok: true,
          latencyMs: out.durationMs,
          ...(typeof root.assetId === 'string'
            ? { rootAssetId: root.assetId }
            : {}),
          ...(typeof root.name === 'string' ? { rootName: root.name } : {}),
        };
      } else {
        result = {
          ok: false,
          latencyMs: out.durationMs,
          message: `Insights Hub responded with HTTP ${status}${
            upstreamMessage(body) ? `: ${upstreamMessage(body)}` : ''
          }`,
        };
      }
    } catch (err) {
      if (!(err instanceof UpstreamUnavailableError)) throw err;
      result = {
        ok: false,
        latencyMs: this.clock.now() - started,
        message: err.message,
      };
    }

    const lastTest = {
      at: this.isoNow(),
      ok: result.ok,
      latencyMs: result.latencyMs,
      ...(result.message ? { message: result.message } : {}),
    };
    // Recording the test result does not change the connection's version.
    // Skip it if the connection was edited or deleted while the test ran.
    const current = await this.repo.get(identity.scope, id);
    if (current && current.updatedAt === rec.updatedAt) {
      await this.repo.update({
        ...current,
        config: { ...current.config, lastTest },
      });
    }
    await this.audit.record({
      userId: identity.scope,
      kind: 'connection',
      action: 'connection.test',
      connectionId: id,
      connectionName: rec.config.name,
      method: 'GET',
      path: '/assets/root',
      durationMs: result.latencyMs,
      summary: result.ok
        ? `Connection test of "${rec.config.name}" succeeded`
        : `Connection test of "${rec.config.name}" failed`,
      ...(status !== undefined ? { status } : {}),
      ...(attempts !== undefined ? { attempts } : {}),
      ...(result.ok ? {} : { error: result.message ?? 'failed' }),
    });
    return result;
  }

  private isoNow(previous?: string): string {
    let now = new Date(this.clock.now()).toISOString();
    // updatedAt doubles as the cache version: keep it strictly increasing.
    if (previous !== undefined && now <= previous) {
      now = new Date(Date.parse(previous) + 1).toISOString();
    }
    return now;
  }

  private checkUrl(field: string, raw: string | undefined): string {
    if (raw === undefined || raw.trim() === '') {
      throw new ValidationError(`${field} is required`);
    }
    const check = checkUpstreamUrl(raw, this.allowedHostSuffixes);
    if (!check.ok) throw new ValidationError(`${field} ${check.reason}`);
    return check.url;
  }

  private normalise(
    input: ConnectionInput,
    existing: ConnectionConfig | undefined,
  ): ConnectionConfig {
    const name = input.name.trim();
    if (name.length < 1 || name.length > NAME_MAX) {
      throw new ValidationError(`name must be 1..${NAME_MAX} characters`);
    }
    const environment = input.environment.trim();
    if (environment.length > ENVIRONMENT_MAX) {
      throw new ValidationError(
        `environment must be at most ${ENVIRONMENT_MAX} characters`,
      );
    }
    const tenant = input.tenant.trim();
    if (!TENANT_PATTERN.test(tenant)) {
      throw new ValidationError(
        'tenant must be 1..8 characters of A-Z, a-z, 0-9 or "_" (the tenant name used in type ids)',
      );
    }

    const auth = this.normaliseAuth(input, existing?.auth);
    const config: ConnectionConfig = { name, environment, tenant, auth };
    if (auth.mode !== 'simulator') {
      config.apiBaseUrl = this.checkUrl('apiBaseUrl', input.apiBaseUrl);
    }
    return config;
  }

  private normaliseAuth(
    input: ConnectionInput,
    previous: StoredAuth | undefined,
  ): StoredAuth {
    const a = input.auth;
    const field = (label: string, v: string): string => {
      const t = v.trim();
      if (t.length < 1 || t.length > FIELD_MAX) {
        throw new ValidationError(
          `auth.${label} must be 1..${FIELD_MAX} characters`,
        );
      }
      return t;
    };
    const secret = (
      label: string,
      v: string | undefined,
      kept: string | undefined,
    ): string => {
      if (v !== undefined && v !== '') {
        if (v.length > SECRET_MAX) {
          throw new ValidationError(`auth.${label} is too long`);
        }
        return v;
      }
      if (kept !== undefined) return kept;
      throw new ValidationError(`auth.${label} is required`);
    };
    const keptClientSecret =
      previous &&
      (previous.mode === 'client_credentials' ||
        previous.mode === 'app_credentials')
        ? previous.clientSecret
        : undefined;

    switch (a.mode) {
      case 'simulator':
        return { mode: 'simulator' };
      case 'bearer':
        return {
          mode: 'bearer',
          token: secret(
            'token',
            a.token?.trim(),
            previous?.mode === 'bearer' ? previous.token : undefined,
          ),
        };
      case 'client_credentials':
        return {
          mode: 'client_credentials',
          tokenUrl: this.checkUrl('auth.tokenUrl', a.tokenUrl),
          clientId: field('clientId', a.clientId),
          clientSecret: secret(
            'clientSecret',
            a.clientSecret,
            keptClientSecret,
          ),
        };
      case 'app_credentials':
        return {
          mode: 'app_credentials',
          tokenUrl: this.checkUrl('auth.tokenUrl', a.tokenUrl),
          clientId: field('clientId', a.clientId),
          clientSecret: secret(
            'clientSecret',
            a.clientSecret,
            keptClientSecret,
          ),
          appName: field('appName', a.appName),
          appVersion: field('appVersion', a.appVersion),
          hostTenant: field('hostTenant', a.hostTenant),
          userTenant: field('userTenant', a.userTenant),
        };
    }
  }
}
