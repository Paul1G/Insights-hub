import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerStaticRoutes, resolveInside } from './static.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ams-static-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app-1234.js'), 'console.log(1)');
  const app = Fastify();
  app.get('/api/ping', () => ({ data: 'pong' }));
  registerStaticRoutes(app, root);
  return { app, root };
}

describe('static frontend serving', () => {
  it('serves index.html, hashed assets with immutable caching and falls back for app paths', async () => {
    const { app } = fixture();
    const index = await app.inject({ url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.headers['cache-control']).toBe('no-cache');
    const asset = await app.inject({ url: '/assets/app-1234.js' });
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await app.inject({ url: '/some/app/route' })).body).toContain('<title>app</title>');
    expect((await app.inject({ url: '/missing.js' })).statusCode).toBe(404);
  });

  it('keeps /api routes and JSON 404s for unknown /api paths', async () => {
    const { app } = fixture();
    expect((await app.inject({ url: '/api/ping' })).json()).toEqual({ data: 'pong' });
    const missing = await app.inject({ url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toHaveProperty('error');
  });

  it('never serves files outside the root', async () => {
    const { app, root } = fixture();
    expect(resolveInside(root, '/../../etc/passwd')?.startsWith(root)).toBe(true);
    expect(resolveInside(root, '/%2e%2e/%2e%2e/secret')?.startsWith(root)).toBe(true);
    expect(resolveInside(root, '/a%00b')).toBeUndefined();
    const res = await app.inject({ url: '/..%2f..%2fpackage.json' });
    expect([400, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain('"name"');
  });
});
