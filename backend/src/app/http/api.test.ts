// api.test exercises the HTTP layer end to end via fastify.inject(): real
// wiring (SQLite in memory, temp data dir, simulator) with an injected fake
// fetch standing in for Insights Hub and its token endpoints.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import {
  ManualClock,
  silentLogger,
  tempDir,
} from '../../test-support/helpers.js';
import { buildApplication, type Application } from '../../wiring.js';

const SECRET = 'super-secret-client-value';
const BASE = 'https://gateway.eu1.mindsphere.io/api/assetmanagement/v3';
const TOKEN_URL = 'https://acme.piam.eu1.mindsphere.io/oauth/token';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Scriptable stand-in for Insights Hub + token endpoint. */
class FakeIH {
  calls: FetchCall[] = [];
  tokenCount = 0;
  tokenStatus = 200;
  /** Responses for AM calls, consumed in order; default 200 {}. */
  amResponses: (() => Response)[] = [];

  fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const headers = {
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    };
    this.calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body,
    });
    if (url === TOKEN_URL) {
      this.tokenCount++;
      if (this.tokenStatus !== 200)
        return Promise.resolve(
          new Response('{"error":"invalid_client"}', {
            status: this.tokenStatus,
          }),
        );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: `tok-${this.tokenCount}`,
            expires_in: 1800,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    }
    const next = this.amResponses.shift();
    return Promise.resolve(
      next
        ? next()
        : new Response(JSON.stringify({ assetId: 'r00t', name: 'acme' }), {
            status: 200,
            headers: { 'content-type': 'application/hal+json', etag: '"4"' },
          }),
    );
  };

  amCalls(): FetchCall[] {
    return this.calls.filter((c) => c.url.startsWith(BASE));
  }
}

let dir: ReturnType<typeof tempDir>;
let ih: FakeIH;
let clock: ManualClock;
let application: Application;

async function boot(env: Record<string, string> = {}): Promise<void> {
  const cfg = loadConfig({
    APPLICATION_DATA_DIR: dir.path,
    APP_DB_PATH: ':memory:',
    ...env,
  });
  application = buildApplication(cfg, silentLogger, {
    fetch: ih.fetch,
    clock,
    sleep: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
    random: () => 0,
  });
  await application.app.ready();
}

beforeEach(async () => {
  dir = tempDir('ams-api-');
  ih = new FakeIH();
  clock = new ManualClock();
  await boot();
});

afterEach(async () => {
  await application.close();
  dir.cleanup();
});

const as = (user: string | null) =>
  user
    ? { 'x-forwarded-user': user, 'x-forwarded-email': `${user}@example.com` }
    : {};

async function api(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  user: string | null = 'alice',
) {
  const res = await application.app.inject({
    method,
    url,
    headers: as(user),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return {
    status: res.statusCode,
    json: res.json<{ data?: any; error?: string }>(),
    headers: res.headers,
  };
}

async function createSimulator(user = 'alice'): Promise<string> {
  const res = await api(
    'POST',
    '/api/connections',
    {
      name: 'Simulator',
      environment: 'dev',
      tenant: 'acme',
      auth: { mode: 'simulator' },
    },
    user,
  );
  expect(res.status).toBe(200);
  return res.json.data.id as string;
}

async function createRealConnection(user = 'alice'): Promise<string> {
  const res = await api(
    'POST',
    '/api/connections',
    {
      name: 'QA tenant',
      environment: 'qa',
      tenant: 'acme',
      apiBaseUrl: BASE,
      auth: {
        mode: 'client_credentials',
        tokenUrl: TOKEN_URL,
        clientId: 'acme-service-client',
        clientSecret: SECRET,
      },
    },
    user,
  );
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.data.id as string;
}

describe('identity and ops', () => {
  it('GET /api/me reflects the proxy headers or anonymous', async () => {
    const me = await api('GET', '/api/me');
    expect(me.json).toEqual({
      data: { anonymous: false, userId: 'alice', email: 'alice@example.com' },
    });
    const anon = await api('GET', '/api/me', undefined, null);
    expect(anon.json.data).toEqual({ anonymous: true, userId: null });
  });

  it('serves /healthz, /readyz, /metrics and a 404 envelope', async () => {
    expect((await application.app.inject({ url: '/healthz' })).json()).toEqual({
      status: 'ok',
    });
    expect((await application.app.inject({ url: '/readyz' })).statusCode).toBe(
      200,
    );
    expect((await application.app.inject({ url: '/metrics' })).body).toContain(
      'http_requests_total',
    );
    const nf = await api('GET', '/api/nope');
    expect(nf.status).toBe(404);
    expect(nf.json.error).toBeTruthy();
  });
});

describe('connections', () => {
  it('creates, lists, updates and deletes with per-user scoping', async () => {
    const id = await createSimulator();
    expect((await api('GET', '/api/connections')).json.data).toHaveLength(1);
    expect(
      (await api('GET', '/api/connections', undefined, 'bob')).json.data,
    ).toEqual([]);
    expect(
      (await api('POST', `/api/connections/${id}/test`, undefined, 'bob'))
        .status,
    ).toBe(404);
    expect(
      (await api('DELETE', `/api/connections/${id}`, undefined, 'bob')).status,
    ).toBe(404);
    expect(
      (await api('GET', '/api/connections', undefined, null)).json.data,
    ).toEqual([]);

    const upd = await api('PUT', `/api/connections/${id}`, {
      name: 'Renamed',
      environment: 'dev',
      tenant: 'acme',
      auth: { mode: 'simulator' },
    });
    expect(upd.json.data.name).toBe('Renamed');
    expect(upd.json.data.updatedAt > upd.json.data.createdAt).toBe(true);
    expect((await api('DELETE', `/api/connections/${id}`)).json).toEqual({
      data: { deleted: true },
    });
    expect((await api('GET', '/api/connections')).json.data).toEqual([]);
  });

  it('validates input: tenant, SSRF guard, required secrets', async () => {
    const base = {
      name: 'X',
      environment: 'qa',
      tenant: 'acme',
      apiBaseUrl: BASE,
    };
    const cc = {
      mode: 'client_credentials',
      tokenUrl: TOKEN_URL,
      clientId: 'id',
      clientSecret: 's',
    };
    expect(
      (
        await api('POST', '/api/connections', {
          ...base,
          tenant: 'waytoolongtenant',
          auth: cc,
        })
      ).status,
    ).toBe(400);
    const ssrf = await api('POST', '/api/connections', {
      ...base,
      apiBaseUrl: 'https://169.254.169.254/latest',
      auth: cc,
    });
    expect(ssrf.status).toBe(400);
    expect(ssrf.json.error).toContain('apiBaseUrl');
    const badToken = await api('POST', '/api/connections', {
      ...base,
      auth: { ...cc, tokenUrl: 'https://evil.example.com/token' },
    });
    expect(badToken.status).toBe(400);
    const noSecret = await api('POST', '/api/connections', {
      ...base,
      auth: { ...cc, clientSecret: undefined },
    });
    expect(noSecret.status).toBe(400);
    expect(noSecret.json.error).toContain('clientSecret');
    expect(
      (
        await api('POST', '/api/connections', {
          ...base,
          auth: { mode: 'magic' },
        })
      ).status,
    ).toBe(400);
  });

  it('never returns, logs or audits secrets; masks the client id; encrypts at rest', async () => {
    const id = await createRealConnection();
    const list = await api('GET', '/api/connections');
    const summary = list.json.data[0];
    expect(summary).toMatchObject({
      authMode: 'client_credentials',
      tokenUrl: TOKEN_URL,
      clientIdHint: 'acme…ient',
      apiBaseUrl: BASE,
    });
    expect(JSON.stringify(list.json)).not.toContain(SECRET);
    expect(JSON.stringify(list.json)).not.toContain('acme-service-client');

    await api('POST', `/api/connections/${id}/test`);
    await api('POST', `/api/connections/${id}/am`, {
      method: 'PUT',
      path: '/assettypes/acme.Pump',
      ifMatch: 1,
      body: { name: 'Pump', parentTypeId: 'core.basicasset' },
    });
    const audit = await api('GET', '/api/audit');
    expect(audit.json.data.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audit.json)).not.toContain(SECRET);
    expect(JSON.stringify(audit.json)).not.toContain('tok-1');

    const rows = application.db.raw.prepare('SELECT * FROM connections').all();
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain(TOKEN_URL);
    expect(JSON.stringify(rows)).not.toContain('QA tenant');
  });

  it('keeps stored secrets when omitted on update', async () => {
    const id = await createRealConnection();
    const upd = await api('PUT', `/api/connections/${id}`, {
      name: 'QA tenant 2',
      environment: 'qa',
      tenant: 'acme',
      apiBaseUrl: BASE,
      auth: {
        mode: 'client_credentials',
        tokenUrl: TOKEN_URL,
        clientId: 'acme-service-client',
      },
    });
    expect(upd.status).toBe(200);
    await api('POST', `/api/connections/${id}/am`, {
      method: 'GET',
      path: '/assets/root',
    });
    const tokenCall = ih.calls.find((c) => c.url === TOKEN_URL)!;
    expect(tokenCall.headers.authorization).toBe(
      `Basic ${Buffer.from(`acme-service-client:${SECRET}`).toString('base64')}`,
    );
    const switchMode = await api('PUT', `/api/connections/${id}`, {
      name: 'x',
      environment: 'qa',
      tenant: 'acme',
      apiBaseUrl: BASE,
      auth: { mode: 'bearer' },
    });
    expect(switchMode.status).toBe(400);
  });

  it('tests a simulator connection and records lastTest', async () => {
    const id = await createSimulator();
    const t = await api('POST', `/api/connections/${id}/test`);
    expect(t.json.data).toMatchObject({ ok: true, rootName: 'acme' });
    expect(t.json.data.rootAssetId).toMatch(/^[0-9a-f]{32}$/);
    const list = await api('GET', '/api/connections');
    expect(list.json.data[0].lastTest).toMatchObject({ ok: true });
  });

  it('reports token failures in the test result', async () => {
    const id = await createRealConnection();
    ih.tokenStatus = 401;
    const t = await api('POST', `/api/connections/${id}/test`);
    expect(t.status).toBe(200);
    expect(t.json.data.ok).toBe(false);
    expect(t.json.data.message).toContain('HTTP 401');
  });

  it('deletes simulator state together with the connection', async () => {
    const id = await createSimulator();
    await api('POST', `/api/connections/${id}/am`, {
      method: 'GET',
      path: '/assets/root',
    });
    await application.simulators.flushAll();
    expect(existsSync(join(dir.path, 'simulator', id))).toBe(true);
    await api('DELETE', `/api/connections/${id}`);
    expect(existsSync(join(dir.path, 'simulator', id))).toBe(false);
  });
});

describe('POST /api/connections/:id/am', () => {
  it('proxies allowlisted calls and returns the upstream status inside the envelope', async () => {
    const id = await createSimulator();
    const root = await api('POST', `/api/connections/${id}/am`, {
      method: 'GET',
      path: '/assets/root',
    });
    expect(root.status).toBe(200);
    expect(root.json.data).toMatchObject({
      status: 200,
      etag: '0',
      attempts: 1,
    });
    expect(root.json.data.body.typeId).toBe('core.basicenterprise');

    const create = await api('POST', `/api/connections/${id}/am`, {
      method: 'PUT',
      path: '/aspecttypes/acme.Motor',
      body: {
        name: 'Motor',
        category: 'static',
        scope: 'private',
        variables: [{ name: 'rpm', dataType: 'DOUBLE' }],
      },
    });
    expect(create.json.data.status).toBe(201);
    const stale = await api('POST', `/api/connections/${id}/am`, {
      method: 'PATCH',
      path: '/aspecttypes/acme.Motor',
      ifMatch: 9,
      body: { description: 'x' },
    });
    expect(stale.status).toBe(200);
    expect(stale.json.data.status).toBe(412);
    expect(stale.json.data.body.errors[0].message).toBeTruthy();
  });

  it('rejects paths, methods and query parameters outside the allowlist', async () => {
    const id = await createSimulator();
    for (const req of [
      { method: 'GET', path: '/files/0123456789abcdef0123456789abcdef/file' },
      { method: 'POST', path: '/files' },
      { method: 'DELETE', path: '/assettypes' },
      { method: 'GET', path: '/../../etc/passwd' },
      { method: 'GET', path: '/assets', query: { evil: '1' } },
      { method: 'GET', path: '/assets', body: { x: 1 } },
      { method: 'TRACE', path: '/assets' },
    ]) {
      const res = await api('POST', `/api/connections/${id}/am`, req);
      expect(res.status, JSON.stringify(req)).toBe(400);
      expect(res.json.error).toBeTruthy();
    }
    expect(
      (
        await api('POST', '/api/connections/unknown/am', {
          method: 'GET',
          path: '/assets',
        })
      ).status,
    ).toBe(404);
  });

  it('authenticates real connections, caches the token and refreshes on 401', async () => {
    const id = await createRealConnection();
    ih.amResponses.push(() => new Response('{}', { status: 401 }));
    const res = await api('POST', `/api/connections/${id}/am`, {
      method: 'GET',
      path: '/assets',
      query: { size: 5, page: 0, includeShared: false },
    });
    expect(res.json.data.status).toBe(200);
    expect(res.json.data.attempts).toBe(2);
    expect(res.json.data.etag).toBe('4');
    const am = ih.amCalls();
    expect(am.map((c) => c.headers.authorization)).toEqual([
      'Bearer tok-1',
      'Bearer tok-2',
    ]);
    expect(am[0]!.url).toBe(`${BASE}/assets?size=5&page=0&includeShared=false`);
    await api('POST', `/api/connections/${id}/am`, {
      method: 'GET',
      path: '/assets/root',
    });
    expect(ih.tokenCount).toBe(2);
  });

  it('sends JSON / merge-patch bodies with If-Match and audits mutating calls', async () => {
    const id = await createRealConnection();
    await api('POST', `/api/connections/${id}/am`, {
      method: 'PATCH',
      path: '/assettypes/acme.Pump/variables',
      ifMatch: 3,
      body: { rpm: { unit: '1/min' } },
    });
    const call = ih.amCalls()[0]!;
    expect(call.method).toBe('PATCH');
    expect(call.headers['content-type']).toBe('application/merge-patch+json');
    expect(call.headers['if-match']).toBe('3');
    expect(JSON.parse(String(call.body))).toEqual({ rpm: { unit: '1/min' } });
    const audit = await api('GET', `/api/audit?connectionId=${id}`);
    const entry = audit.json.data.find(
      (e: { kind: string }) => e.kind === 'upstream',
    );
    expect(entry).toMatchObject({
      method: 'PATCH',
      path: '/assettypes/acme.Pump/variables',
      status: 200,
      attempts: 1,
      connectionName: 'QA tenant',
    });
    expect(entry.details).toBeUndefined();
  });

  it('answers 502 when the token endpoint fails', async () => {
    const id = await createRealConnection();
    ih.tokenStatus = 500;
    const res = await api('POST', `/api/connections/${id}/am`, {
      method: 'GET',
      path: '/assets/root',
    });
    expect(res.status).toBe(502);
    expect(res.json.error).toContain('Token request failed');
  });
});

describe('POST /api/connections/:id/list', () => {
  it('reads all pages from the simulator', async () => {
    const id = await createSimulator();
    const res = await api('POST', `/api/connections/${id}/list`, {
      resource: 'assettypes',
      exploded: true,
    });
    expect(res.status).toBe(200);
    expect(res.json.data.items.length).toBe(20);
    expect(res.json.data).toMatchObject({
      totalElements: 20,
      totalPages: 1,
      partialFailures: [],
    });
    expect(
      (
        await api('POST', `/api/connections/${id}/list`, {
          resource: 'widgets',
        })
      ).status,
    ).toBe(400);
  });
});

describe('files', () => {
  const upload = (over: Record<string, unknown> = {}) => ({
    name: 'manual.pdf',
    fileName: 'manual.pdf',
    mimeType: 'application/pdf',
    scope: 'private',
    contentBase64: Buffer.from('%PDF-1.4 test').toString('base64'),
    ...over,
  });

  it('uploads, replaces and downloads through the simulator', async () => {
    const id = await createSimulator();
    const up = await api('POST', `/api/connections/${id}/files`, upload());
    expect(up.status).toBe(200);
    expect(up.json.data.status).toBe(201);
    const fileId = up.json.data.body.id as string;
    const rep = await api('PUT', `/api/connections/${id}/files/${fileId}`, {
      ...upload({
        contentBase64: Buffer.from('%PDF-1.5 v2').toString('base64'),
      }),
      ifMatch: up.json.data.etag,
    });
    expect(rep.json.data.status).toBe(200);
    expect(rep.json.data.etag).toBe('1');
    const down = await api(
      'GET',
      `/api/connections/${id}/files/${fileId}/content`,
    );
    expect(down.json.data.status).toBe(200);
    expect(down.json.data.body).toEqual({
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('%PDF-1.5 v2').toString('base64'),
    });
    const audit = await api('GET', `/api/audit?connectionId=${id}&limit=10`);
    expect(
      audit.json.data.map(
        (e: { method?: string; path?: string }) => `${e.method} ${e.path}`,
      ),
    ).toEqual(expect.arrayContaining(['POST /files', `PUT /files/${fileId}`]));
  });

  it('validates extension vs content type and the 5 MB limit', async () => {
    const id = await createSimulator();
    const mismatch = await api(
      'POST',
      `/api/connections/${id}/files`,
      upload({ mimeType: 'text/plain' }),
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error).toContain('does not match');
    const big = await api(
      'POST',
      `/api/connections/${id}/files`,
      upload({
        contentBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'),
      }),
    );
    expect(big.status).toBe(413);
    const badName = await api(
      'POST',
      `/api/connections/${id}/files`,
      upload({ name: 'my manual.pdf' }),
    );
    expect(badName.status).toBe(400);
  });
});

describe('audit', () => {
  it('appends app-level actions with redacted details and pages newest first', async () => {
    const id = await createSimulator();
    const appended = await api('POST', '/api/audit', {
      connectionId: id,
      action: 'deployment.started',
      summary: 'Deploying 3 types',
      details: {
        types: 3,
        clientSecret: 'nope',
        nested: { token: 'x', ok: true },
      },
    });
    expect(appended.status).toBe(200);
    expect(appended.json.data).toMatchObject({
      kind: 'action',
      userId: 'alice',
      connectionName: 'Simulator',
    });
    expect(appended.json.data.details).toEqual({
      types: 3,
      clientSecret: '[REDACTED]',
      nested: { token: '[REDACTED]', ok: true },
    });

    clock.advance(1000);
    await api('POST', '/api/audit', {
      action: 'batch.delete',
      summary: 'Deleted 2 assets',
    });
    const all = await api('GET', '/api/audit');
    expect(all.json.data[0].action).toBe('batch.delete');
    const older = await api(
      'GET',
      `/api/audit?before=${encodeURIComponent(all.json.data[0].at)}`,
    );
    expect(
      older.json.data.every(
        (e: { action?: string }) => e.action !== 'batch.delete',
      ),
    ).toBe(true);
    expect(
      (await api('GET', `/api/audit?connectionId=${id}`)).json.data.every(
        (e: { connectionId?: string }) => e.connectionId === id,
      ),
    ).toBe(true);
    expect((await api('GET', '/api/audit?limit=1')).json.data).toHaveLength(1);
    expect((await api('GET', '/api/audit?limit=501')).status).toBe(400);
    expect((await api('GET', '/api/audit?before=yesterday')).status).toBe(400);
    expect(
      (await api('GET', '/api/audit', undefined, 'bob')).json.data,
    ).toEqual([]);
    expect(
      (await api('POST', '/api/audit', { action: '', summary: 'x' })).status,
    ).toBe(400);
  });
});

describe('limits', () => {
  it('rate-limits each user (burst, then 429) independently', async () => {
    await application.close();
    await boot({ APP_RATE_LIMIT_BURST: '3', APP_RATE_LIMIT_PER_SEC: '1' });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++)
      statuses.push((await api('GET', '/api/me')).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await api('GET', '/api/me', undefined, 'bob')).status).toBe(200);
    const limited = await api('GET', '/api/me');
    expect(limited.json.error).toBeTruthy();
    expect(limited.headers['retry-after']).toBe('1');
    clock.advance(1000);
    expect((await api('GET', '/api/me')).status).toBe(200);
    expect((await application.app.inject({ url: '/healthz' })).statusCode).toBe(
      200,
    );
  });

  it('rejects bodies above the limit with 413', async () => {
    await application.close();
    await boot({ APP_BODY_LIMIT_BYTES: '2048' });
    const res = await api('POST', '/api/audit', {
      action: 'x',
      summary: 'y',
      details: { blob: 'z'.repeat(4096) },
    });
    expect(res.status).toBe(413);
    expect(res.json.error).toContain('too large');
  });
});
