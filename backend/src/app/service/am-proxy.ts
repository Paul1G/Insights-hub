// app/service/am-proxy executes allowlisted Asset Management v3 calls on
// behalf of the signed-in user. Upstream HTTP errors are returned verbatim in
// AmResponse.status (never mapped to the outer status); only proxy-level
// problems raise typed errors. Mutating calls are written to the audit log.

import { isMutating, matchOperation } from '../../domain/am/allowlist.js';
import type { ConnectionRecord } from '../../domain/connection/connection.js';
import {
  UpstreamUnavailableError,
  ValidationError,
} from '../../domain/errors.js';
import type { Identity } from '../../domain/identity.js';
import type {
  HttpMethod,
  UpstreamBody,
  UpstreamRequest,
} from '../../domain/upstream/transport.js';

import type { AuditService } from './audit.js';
import type { ConnectionRuntime } from './connection-runtime.js';
import type { ConnectionService } from './connections.js';
import type { UpstreamResult } from './upstream-client.js';
import { decodeBody, normaliseEtag } from './upstream-body.js';

export type AmContentType = 'application/json' | 'application/merge-patch+json';

export interface AmRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  ifMatch?: string | number;
  ifNoneMatch?: string;
  body?: unknown;
  contentType?: AmContentType;
}

export interface AmResponse<T = unknown> {
  status: number;
  etag?: string;
  body: T;
  attempts: number;
  durationMs: number;
}

export const ACCEPT_HEADER = 'application/hal+json, application/json';

// Visible ASCII only: rejects CR/LF header injection and control characters.
const HEADER_VALUE = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/;

export function headerValue(name: string, v: string | number): string {
  const s = String(v).trim();
  if (s.length === 0 || s.length > 256 || !HEADER_VALUE.test(s)) {
    throw new ValidationError(`${name} contains invalid characters`);
  }
  return s;
}

export function toAmResponse(out: UpstreamResult): AmResponse {
  const etag = normaliseEtag(out.response.headers.etag);
  return {
    status: out.response.status,
    ...(etag !== undefined ? { etag } : {}),
    body: decodeBody(out.response),
    attempts: out.attempts,
    durationMs: out.durationMs,
  };
}

export class AmProxyService {
  private readonly connections: ConnectionService;
  private readonly runtime: ConnectionRuntime;
  private readonly audit: AuditService;

  constructor(o: {
    connections: ConnectionService;
    runtime: ConnectionRuntime;
    audit: AuditService;
  }) {
    this.connections = o.connections;
    this.runtime = o.runtime;
    this.audit = o.audit;
  }

  async call(
    identity: Identity,
    connectionId: string,
    req: AmRequest,
  ): Promise<AmResponse> {
    const rec = await this.connections.getRecord(identity, connectionId);
    const upstream = buildUpstreamRequest(req);
    return this.executeAudited(identity, rec, upstream);
  }

  /** Executes a prepared request; audits it when it mutates upstream state. */
  async executeAudited(
    identity: Identity,
    rec: ConnectionRecord,
    upstream: UpstreamRequest,
  ): Promise<AmResponse> {
    return toAmResponse(await this.executeRaw(identity, rec, upstream));
  }

  /** Like executeAudited, but returns the undecoded upstream response. */
  async executeRaw(
    identity: Identity,
    rec: ConnectionRecord,
    upstream: UpstreamRequest,
  ): Promise<UpstreamResult> {
    const client = this.runtime.client(rec);
    const mutating = isMutating(upstream.method);
    try {
      const out = await client.execute(upstream);
      if (mutating) {
        await this.audit.record({
          userId: identity.scope,
          kind: 'upstream',
          connectionId: rec.id,
          connectionName: rec.config.name,
          method: upstream.method,
          path: upstream.path,
          status: out.response.status,
          durationMs: out.durationMs,
          attempts: out.attempts,
        });
      }
      return out;
    } catch (err) {
      if (mutating && err instanceof UpstreamUnavailableError) {
        await this.audit.record({
          userId: identity.scope,
          kind: 'upstream',
          connectionId: rec.id,
          connectionName: rec.config.name,
          method: upstream.method,
          path: upstream.path,
          error: err.message,
        });
      }
      throw err;
    }
  }
}

/** Validates an AmRequest against the allowlist and builds the upstream call. */
export function buildUpstreamRequest(req: AmRequest): UpstreamRequest {
  const matched = matchOperation(req.method, req.path);
  if (!matched.ok) throw new ValidationError(matched.reason);
  const { operation, path } = matched.match;

  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value === undefined) continue;
    if (!operation.query.includes(key)) {
      throw new ValidationError(
        `query parameter "${key}" is not supported by ${operation.method} ${operation.template}`,
      );
    }
    const s = String(value);
    if (s.length > 8192)
      throw new ValidationError(`query parameter "${key}" is too long`);
    query[key] = s;
  }

  const headers: Record<string, string> = { accept: ACCEPT_HEADER };
  if (req.ifMatch !== undefined)
    headers['if-match'] = headerValue('ifMatch', req.ifMatch);
  if (req.ifNoneMatch !== undefined) {
    headers['if-none-match'] = headerValue('ifNoneMatch', req.ifNoneMatch);
  }

  let body: UpstreamBody | undefined;
  if (req.body !== undefined) {
    if (operation.method === 'GET' || operation.method === 'DELETE') {
      throw new ValidationError(
        `${operation.method} requests must not have a body`,
      );
    }
    const contentType =
      req.contentType ??
      (operation.method === 'PATCH'
        ? 'application/merge-patch+json'
        : 'application/json');
    body = { kind: 'json', contentType, text: JSON.stringify(req.body) };
  }

  return {
    method: operation.method,
    path,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    headers,
    ...(body ? { body } : {}),
  };
}
