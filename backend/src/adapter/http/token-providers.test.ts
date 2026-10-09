import { describe, expect, it } from 'vitest';

import { TokenError } from '../../domain/upstream/transport.js';
import { ManualClock } from '../../test-support/helpers.js';

import type { FetchFn } from './fetch-transport.js';
import {
  AppCredentialsTokenProvider,
  ClientCredentialsTokenProvider,
  StaticBearerTokenProvider,
} from './token-providers.js';

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: (() => Response)[]): {
  fetch: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) return Promise.reject(new Error('unexpected token request'));
    return Promise.resolve(next());
  }) as FetchFn;
  return { fetch, calls };
}

const tokenResponse =
  (token: string, expiresIn = 1800) =>
  () =>
    new Response(
      JSON.stringify({
        access_token: token,
        token_type: 'Bearer',
        expires_in: expiresIn,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );

const TOKEN_URL = 'https://acme.piam.eu1.mindsphere.io/oauth/token';

describe('ClientCredentialsTokenProvider', () => {
  it('posts grant_type=client_credentials with Basic auth', async () => {
    const f = fakeFetch([tokenResponse('t1')]);
    const p = new ClientCredentialsTokenProvider({
      tokenUrl: TOKEN_URL,
      clientId: 'my-id',
      clientSecret: 's3cret',
      fetch: f.fetch,
      clock: new ManualClock(),
      timeoutMs: 1000,
    });
    expect(await p.authorization()).toBe('Bearer t1');
    const call = f.calls[0]!;
    expect(call.url).toBe(TOKEN_URL);
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe('grant_type=client_credentials');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('my-id:s3cret').toString('base64')}`,
    );
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call.init.redirect).toBe('manual');
  });

  it('caches until expires_in - 60 s and refreshes after invalidate()', async () => {
    const clock = new ManualClock();
    const f = fakeFetch([
      tokenResponse('t1', 600),
      tokenResponse('t2', 600),
      tokenResponse('t3', 600),
    ]);
    const p = new ClientCredentialsTokenProvider({
      tokenUrl: TOKEN_URL,
      clientId: 'id',
      clientSecret: 'secret',
      fetch: f.fetch,
      clock,
      timeoutMs: 1000,
    });
    expect(await p.authorization()).toBe('Bearer t1');
    clock.advance(539_000);
    expect(await p.authorization()).toBe('Bearer t1');
    clock.advance(1_000); // 540 s = 600 - 60
    expect(await p.authorization()).toBe('Bearer t2');
    p.invalidate();
    expect(await p.authorization()).toBe('Bearer t3');
    expect(f.calls).toHaveLength(3);
  });

  it('shares one in-flight token request between concurrent callers', async () => {
    const f = fakeFetch([tokenResponse('t1')]);
    const p = new ClientCredentialsTokenProvider({
      tokenUrl: TOKEN_URL,
      clientId: 'id',
      clientSecret: 'secret',
      fetch: f.fetch,
      clock: new ManualClock(),
      timeoutMs: 1000,
    });
    const all = await Promise.all([
      p.authorization(),
      p.authorization(),
      p.authorization(),
    ]);
    expect(all).toEqual(['Bearer t1', 'Bearer t1', 'Bearer t1']);
    expect(f.calls).toHaveLength(1);
  });

  it('raises TokenError on HTTP errors without echoing response details', async () => {
    const f = fakeFetch([
      () =>
        new Response(
          JSON.stringify({
            error: 'invalid_client',
            error_description: 'secret xyz wrong',
          }),
          { status: 401 },
        ),
    ]);
    const p = new ClientCredentialsTokenProvider({
      tokenUrl: TOKEN_URL,
      clientId: 'id',
      clientSecret: 'secret',
      fetch: f.fetch,
      clock: new ManualClock(),
      timeoutMs: 1000,
    });
    const err = await p.authorization().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenError);
    expect((err as Error).message).toBe(
      'token endpoint responded with HTTP 401 (invalid_client)',
    );
  });
});

describe('AppCredentialsTokenProvider', () => {
  it('uses X-SPACE-AUTH-KEY and the JSON body of the Token Management Service', async () => {
    const f = fakeFetch([tokenResponse('app-token')]);
    const p = new AppCredentialsTokenProvider({
      tokenUrl:
        'https://gateway.eu1.mindsphere.io/api/technicaltokenmanager/v3/oauth/token',
      clientId: 'app-id',
      clientSecret: 'app-secret',
      appName: 'studio',
      appVersion: '1.0.0',
      hostTenant: 'acme',
      userTenant: 'acme',
      fetch: f.fetch,
      clock: new ManualClock(),
      timeoutMs: 1000,
    });
    expect(await p.authorization()).toBe('Bearer app-token');
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-space-auth-key']).toBe(
      `Basic ${Buffer.from('app-id:app-secret').toString('base64')}`,
    );
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      appName: 'studio',
      appVersion: '1.0.0',
      hostTenant: 'acme',
      userTenant: 'acme',
    });
  });
});

describe('StaticBearerTokenProvider', () => {
  it('returns the pasted token and is not refreshable', async () => {
    const p = new StaticBearerTokenProvider('pasted');
    expect(await p.authorization()).toBe('Bearer pasted');
    expect(p.refreshable).toBe(false);
  });
});
