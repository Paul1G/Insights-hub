// lister.test drives ListerService against a fake upstream that serves
// HAL pages, asserting page size 200, bounded concurrency, concatenation in
// page order, maxItems and partial failures.

import { describe, expect, it } from 'vitest';

import type { ConnectionRecord } from '../../domain/connection/connection.js';
import type { EndpointFactory } from '../../domain/connection/endpoint-factory.js';
import type {
  UpstreamRequest,
  UpstreamResponse,
} from '../../domain/upstream/transport.js';
import { UpstreamNetworkError } from '../../domain/upstream/transport.js';
import { identityFromHeaders } from '../../domain/identity.js';
import { UpstreamUnavailableError } from '../../domain/errors.js';
import { ManualClock, upstreamJson } from '../../test-support/helpers.js';

import { ConnectionRuntime } from './connection-runtime.js';
import type { ConnectionService } from './connections.js';
import { ListerService } from './lister.js';

const REC: ConnectionRecord = {
  id: 'c1',
  userId: 'alice',
  createdAt: '2026-10-06T08:00:00.000Z',
  updatedAt: '2026-10-06T08:00:00.000Z',
  config: {
    name: 'QA',
    environment: 'qa',
    tenant: 'acme',
    apiBaseUrl: 'https://gateway.eu1.mindsphere.io/api/assetmanagement/v3',
    auth: { mode: 'bearer', token: 't' },
  },
};

const identity = identityFromHeaders({ user: 'alice' });

function setup(
  total: number,
  opts: {
    failPages?: Record<number, number | 'network'>;
    embedded?: string;
    delayMs?: number;
  } = {},
) {
  const requests: UpstreamRequest[] = [];
  let active = 0;
  let peak = 0;
  const embedded = opts.embedded ?? 'assets';
  const send = async (req: UpstreamRequest): Promise<UpstreamResponse> => {
    requests.push(req);
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 2));
      const page = Number(req.query?.page ?? '0');
      const size = Number(req.query?.size ?? '10');
      const fail = opts.failPages?.[page];
      if (fail === 'network')
        throw new UpstreamNetworkError('network error (ECONNRESET)', false);
      if (fail !== undefined)
        return upstreamJson(fail, {
          errors: [{ code: 'x', message: `page ${page} failed` }],
        });
      const items = Array.from({ length: total }, (_, i) => ({ n: i })).slice(
        page * size,
        page * size + size,
      );
      return upstreamJson(200, {
        _embedded: { [embedded]: items },
        page: {
          size,
          totalElements: total,
          totalPages: Math.ceil(total / size),
          number: page,
        },
      });
    } finally {
      active--;
    }
  };
  const factory: EndpointFactory = {
    create: () => ({ transport: { send } }),
    destroy: () => Promise.resolve(),
  };
  const runtime = new ConnectionRuntime({
    factory,
    concurrency: 8,
    policy: { baseDelayMs: 1, factor: 2, maxRetries: 2, capMs: 4 },
    sleep: () => Promise.resolve(),
    clock: new ManualClock(),
    random: () => 0,
  });
  const connections = {
    getRecord: () => Promise.resolve(REC),
  } as unknown as ConnectionService;
  const lister = new ListerService({
    connections,
    runtime,
    clock: new ManualClock(),
  });
  return { lister, requests, peak: () => peak };
}

describe('ListerService', () => {
  it('fetches page 0 with size=200, then the rest 4 at a time, in page order', async () => {
    const s = setup(2150);
    const res = await s.lister.listAll(identity, 'c1', {
      resource: 'assets',
      filter: '{"name":"x"}',
      basicFieldsOnly: true,
    });
    expect(res.items).toHaveLength(2150);
    expect((res.items as { n: number }[]).map((i) => i.n)).toEqual(
      Array.from({ length: 2150 }, (_, i) => i),
    );
    expect(res.totalElements).toBe(2150);
    expect(res.totalPages).toBe(11);
    expect(res.partialFailures).toEqual([]);
    expect(s.requests).toHaveLength(11);
    expect(s.requests.every((r) => r.query?.size === '200')).toBe(true);
    expect(s.requests[0]!.query).toMatchObject({
      page: '0',
      filter: '{"name":"x"}',
      basicFieldsOnly: 'true',
    });
    expect(s.requests[0]!.path).toBe('/assets');
    expect(s.peak()).toBe(4);
  });

  it('reports pages that still fail as partial failures', async () => {
    const s = setup(1000, { failPages: { 2: 503, 4: 'network' } });
    const res = await s.lister.listAll(identity, 'c1', { resource: 'assets' });
    expect(res.items).toHaveLength(600);
    expect(res.partialFailures).toEqual([
      { page: 2, status: 503, message: 'page 2 failed' },
      { page: 4, status: 0, message: expect.stringContaining('not reachable') },
    ]);
  });

  it('returns an upstream error on page 0 as a partial result, network failure as 502', async () => {
    const s = setup(10, { failPages: { 0: 400 } });
    const res = await s.lister.listAll(identity, 'c1', {
      resource: 'assets',
      filter: 'bad',
    });
    expect(res.items).toEqual([]);
    expect(res.partialFailures).toEqual([
      { page: 0, status: 400, message: 'page 0 failed' },
    ]);
    const n = setup(10, { failPages: { 0: 'network' } });
    await expect(
      n.lister.listAll(identity, 'c1', { resource: 'assets' }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('stops after maxItems', async () => {
    const s = setup(5000);
    const res = await s.lister.listAll(identity, 'c1', {
      resource: 'assets',
      maxItems: 450,
    });
    expect(res.items).toHaveLength(450);
    expect(s.requests).toHaveLength(3);
    expect(res.totalElements).toBe(5000);
  });

  it('maps resources to paths and embedded keys and forwards only supported flags', async () => {
    const s = setup(3, { embedded: 'variables' });
    const id = '0123456789abcdef0123456789abcdef';
    const res = await s.lister.listAll(identity, 'c1', {
      resource: 'asset-variables',
      assetId: id,
      exploded: true,
      includeShared: false,
    });
    expect(res.items).toHaveLength(3);
    expect(s.requests[0]!.path).toBe(`/assets/${id}/variables`);
    expect(s.requests[0]!.query).toEqual({
      size: '200',
      page: '0',
      includeShared: 'false',
    });
    await expect(
      s.lister.listAll(identity, 'c1', { resource: 'asset-aspects' }),
    ).rejects.toThrow(/assetId/);
  });
});
