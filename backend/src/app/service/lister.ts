// app/service/lister reads every page of an Asset Management list endpoint.
// Page 0 is fetched with size=200 (the platform's recommended page size —
// never 2000); its `page.totalPages` decides how many further pages are
// fetched, 4 at a time. Pages that still fail after the upstream client's
// retries are reported in `partialFailures` instead of failing the result.

import {
  NotFoundError,
  UpstreamUnavailableError,
  ValidationError,
} from '../../domain/errors.js';
import type { Identity } from '../../domain/identity.js';
import type { UpstreamRequest } from '../../domain/upstream/transport.js';
import type { Clock } from '../../platform/clock.js';
import { mapPool } from '../../platform/semaphore.js';

import { ACCEPT_HEADER } from './am-proxy.js';
import type { ConnectionRuntime } from './connection-runtime.js';
import type { ConnectionService } from './connections.js';
import type { UpstreamClient } from './upstream-client.js';
import { decodeBody, upstreamMessage } from './upstream-body.js';

export const LIST_PAGE_SIZE = 200;
export const LIST_PAGE_CONCURRENCY = 4;
const UNIQUE_ID = /^[0-9A-Fa-f]{32}$/;

export type ListResource =
  | 'assets'
  | 'assettypes'
  | 'aspecttypes'
  | 'files'
  | 'asset-variables'
  | 'asset-aspects';

export interface ListRequest {
  resource: ListResource;
  assetId?: string;
  filter?: string;
  sort?: string;
  exploded?: boolean;
  basicFieldsOnly?: boolean;
  includeShared?: boolean;
  maxItems?: number;
}

export interface PartialFailure {
  page: number;
  status: number;
  message: string;
}

export interface ListResult<T = unknown> {
  items: T[];
  totalElements: number;
  totalPages: number;
  partialFailures: PartialFailure[];
  durationMs: number;
}

interface ResourceSpec {
  path: (assetId?: string) => string;
  embedded: string;
  /** Optional query flags the spec declares for this list operation. */
  flags: readonly ('exploded' | 'basicFieldsOnly' | 'includeShared')[];
}

const RESOURCES: Record<ListResource, ResourceSpec> = {
  assets: {
    path: () => '/assets',
    embedded: 'assets',
    flags: ['includeShared', 'basicFieldsOnly'],
  },
  assettypes: {
    path: () => '/assettypes',
    embedded: 'assetTypes',
    flags: ['exploded', 'includeShared'],
  },
  aspecttypes: {
    path: () => '/aspecttypes',
    embedded: 'aspectTypes',
    flags: ['includeShared'],
  },
  files: { path: () => '/files', embedded: 'files', flags: [] },
  'asset-variables': {
    path: (id) => `/assets/${id}/variables`,
    embedded: 'variables',
    flags: ['includeShared'],
  },
  'asset-aspects': {
    path: (id) => `/assets/${id}/aspects`,
    embedded: 'aspects',
    flags: ['includeShared'],
  },
};

interface PageOutcome {
  ok: boolean;
  items: unknown[];
  totalElements?: number;
  totalPages?: number;
  failure?: PartialFailure;
}

export class ListerService {
  private readonly connections: ConnectionService;
  private readonly runtime: ConnectionRuntime;
  private readonly clock: Clock;

  constructor(o: {
    connections: ConnectionService;
    runtime: ConnectionRuntime;
    clock: Clock;
  }) {
    this.connections = o.connections;
    this.runtime = o.runtime;
    this.clock = o.clock;
  }

  async listAll(
    identity: Identity,
    connectionId: string,
    req: ListRequest,
  ): Promise<ListResult> {
    const rec = await this.connections.getRecord(identity, connectionId);
    const spec = RESOURCES[req.resource];
    if (!spec)
      throw new NotFoundError(`Unknown list resource ${String(req.resource)}`);
    if (
      req.resource === 'asset-variables' ||
      req.resource === 'asset-aspects'
    ) {
      if (!req.assetId || !UNIQUE_ID.test(req.assetId)) {
        throw new ValidationError(
          `assetId (32 hex characters) is required for ${req.resource}`,
        );
      }
    }
    if (
      req.maxItems !== undefined &&
      (!Number.isInteger(req.maxItems) || req.maxItems < 1)
    ) {
      throw new ValidationError('maxItems must be a positive integer');
    }

    const started = this.clock.now();
    const client = this.runtime.client(rec);
    const baseQuery: Record<string, string> = { size: String(LIST_PAGE_SIZE) };
    if (req.filter !== undefined && req.filter !== '')
      baseQuery.filter = req.filter;
    if (req.sort !== undefined && req.sort !== '') baseQuery.sort = req.sort;
    for (const flag of spec.flags) {
      const v = req[flag];
      if (v !== undefined) baseQuery[flag] = String(v);
    }
    const path = spec.path(req.assetId);

    const first = await this.fetchPage(
      client,
      path,
      baseQuery,
      0,
      spec.embedded,
    );
    if (!first.ok) {
      return {
        items: [],
        totalElements: 0,
        totalPages: 0,
        partialFailures: first.failure ? [first.failure] : [],
        durationMs: this.clock.now() - started,
      };
    }

    const totalPages = first.totalPages ?? 1;
    const totalElements = first.totalElements ?? first.items.length;
    let lastPage = totalPages - 1;
    if (req.maxItems !== undefined) {
      lastPage = Math.min(
        lastPage,
        Math.ceil(req.maxItems / LIST_PAGE_SIZE) - 1,
      );
    }
    const rest = Array.from({ length: Math.max(0, lastPage) }, (_, i) => i + 1);
    const outcomes = await mapPool(rest, LIST_PAGE_CONCURRENCY, (page) =>
      this.fetchPage(client, path, baseQuery, page, spec.embedded),
    );

    let items = [...first.items];
    const partialFailures: PartialFailure[] = [];
    for (const o of outcomes) {
      items = items.concat(o.items);
      if (o.failure) partialFailures.push(o.failure);
    }
    if (req.maxItems !== undefined && items.length > req.maxItems) {
      items = items.slice(0, req.maxItems);
    }
    return {
      items,
      totalElements,
      totalPages,
      partialFailures,
      durationMs: this.clock.now() - started,
    };
  }

  private async fetchPage(
    client: UpstreamClient,
    path: string,
    baseQuery: Record<string, string>,
    page: number,
    embedded: string,
  ): Promise<PageOutcome> {
    const req: UpstreamRequest = {
      method: 'GET',
      path,
      query: { ...baseQuery, page: String(page) },
      headers: { accept: ACCEPT_HEADER },
    };
    let status: number;
    let body: unknown;
    try {
      const out = await client.execute(req);
      status = out.response.status;
      body = decodeBody(out.response);
    } catch (err) {
      if (!(err instanceof UpstreamUnavailableError)) throw err;
      // Page 0 decides everything; without it there is nothing to return.
      if (page === 0) throw err;
      return {
        ok: false,
        items: [],
        failure: { page, status: 0, message: err.message },
      };
    }
    if (status !== 200 || body === null || typeof body !== 'object') {
      return {
        ok: false,
        items: [],
        failure: {
          page,
          status,
          message:
            upstreamMessage(body) ??
            (status === 200 ? 'Unexpected response body' : `HTTP ${status}`),
        },
      };
    }
    const doc = body as {
      _embedded?: Record<string, unknown>;
      page?: { totalElements?: unknown; totalPages?: unknown };
    };
    const list = doc._embedded?.[embedded];
    const items = Array.isArray(list) ? (list as unknown[]) : [];
    const outcome: PageOutcome = { ok: true, items };
    if (typeof doc.page?.totalElements === 'number')
      outcome.totalElements = doc.page.totalElements;
    if (typeof doc.page?.totalPages === 'number')
      outcome.totalPages = doc.page.totalPages;
    return outcome;
  }
}
