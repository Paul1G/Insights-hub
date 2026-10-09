import { describe, expect, it } from 'vitest';

import {
  TokenError,
  UpstreamNetworkError,
  type TokenProvider,
  type UpstreamRequest,
  type UpstreamResponse,
} from '../../domain/upstream/transport.js';
import { UpstreamUnavailableError } from '../../domain/errors.js';
import { ManualClock, upstreamJson } from '../../test-support/helpers.js';

import {
  DEFAULT_RETRY_POLICY,
  UpstreamClient,
  backoffDelayMs,
  parseRetryAfterMs,
} from './upstream-client.js';

type Step = UpstreamResponse | Error;

function scripted(steps: Step[]) {
  const seen: { req: UpstreamRequest; auth: string | undefined }[] = [];
  return {
    seen,
    transport: {
      send: (
        req: UpstreamRequest,
        auth?: string,
      ): Promise<UpstreamResponse> => {
        seen.push({ req, auth });
        const step = steps.shift();
        if (!step)
          return Promise.reject(new Error('no more scripted responses'));
        return step instanceof Error
          ? Promise.reject(step)
          : Promise.resolve(step);
      },
    },
  };
}

function client(
  steps: Step[],
  o: { tokens?: TokenProvider; random?: () => number } = {},
) {
  const sleeps: number[] = [];
  const clock = new ManualClock();
  const s = scripted(steps);
  const c = new UpstreamClient({
    endpoint: {
      transport: s.transport,
      ...(o.tokens ? { tokens: o.tokens } : {}),
    },
    mode: 'test',
    concurrency: 8,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    },
    clock,
    random: o.random ?? (() => 0.5),
  });
  return { c, sleeps, seen: s.seen };
}

const GET: UpstreamRequest = { method: 'GET', path: '/assets/root' };
const POST: UpstreamRequest = { method: 'POST', path: '/assets' };

describe('backoff', () => {
  it('uses full jitter with base 500 ms, factor 2 and a 20 s cap', () => {
    expect(backoffDelayMs(0, DEFAULT_RETRY_POLICY, () => 0.999)).toBe(499);
    expect(backoffDelayMs(3, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(2000);
    expect(backoffDelayMs(10, DEFAULT_RETRY_POLICY, () => 0.999)).toBe(19980);
    expect(backoffDelayMs(2, DEFAULT_RETRY_POLICY, () => 0)).toBe(0);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('2026-10-06T08:00:00Z');
    expect(parseRetryAfterMs('3', now)).toBe(3000);
    expect(parseRetryAfterMs('Tue, 06 Oct 2026 08:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfterMs('soon', now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
  });
});

describe('UpstreamClient retries', () => {
  it('retries 503/502/504 with exponential full-jitter delays, then succeeds', async () => {
    const { c, sleeps } = client([
      upstreamJson(503),
      upstreamJson(502),
      upstreamJson(504),
      upstreamJson(200, { ok: 1 }),
    ]);
    const out = await c.execute(GET);
    expect(out.response.status).toBe(200);
    expect(out.attempts).toBe(4);
    expect(sleeps).toEqual([250, 500, 1000]);
    expect(out.durationMs).toBe(1750);
  });

  it('honours Retry-After (capped at 20 s) instead of the jittered delay', async () => {
    const { c, sleeps } = client([
      upstreamJson(429, undefined, { 'retry-after': '2' }),
      upstreamJson(503, undefined, { 'retry-after': '120' }),
      upstreamJson(200),
    ]);
    const out = await c.execute(GET);
    expect(out.response.status).toBe(200);
    expect(sleeps).toEqual([2000, 20000]);
  });

  it('gives up after 5 retries and returns the last upstream response', async () => {
    const { c, sleeps } = client(
      Array.from({ length: 6 }, () => upstreamJson(503)),
    );
    const out = await c.execute(GET);
    expect(out.response.status).toBe(503);
    expect(out.attempts).toBe(6);
    expect(sleeps).toHaveLength(5);
  });

  it('does not retry other client/server errors', async () => {
    const { c } = client([upstreamJson(412, { errors: [] })]);
    const out = await c.execute(GET);
    expect(out.response.status).toBe(412);
    expect(out.attempts).toBe(1);
  });

  it('retries network errors for GET and maps exhaustion to 502', async () => {
    const net = () =>
      new UpstreamNetworkError('network error (ECONNRESET)', false);
    const { c } = client([net(), upstreamJson(200)]);
    expect((await c.execute(GET)).attempts).toBe(2);
    const exhausted = client(Array.from({ length: 6 }, net));
    await expect(exhausted.c.execute(GET)).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
  });

  it('retries POST only on 429 and on connect failures', async () => {
    const p503 = client([upstreamJson(503), upstreamJson(201)]);
    expect((await p503.c.execute(POST)).response.status).toBe(503);

    const p429 = client([upstreamJson(429), upstreamJson(201)]);
    const out = await p429.c.execute(POST);
    expect(out.response.status).toBe(201);
    expect(out.attempts).toBe(2);

    const reset = client([
      new UpstreamNetworkError('network error (ECONNRESET)', false),
      upstreamJson(201),
    ]);
    await expect(reset.c.execute(POST)).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
    expect(reset.seen).toHaveLength(1);

    const refused = client([
      new UpstreamNetworkError('connection failed (ECONNREFUSED)', true),
      upstreamJson(201),
    ]);
    expect((await refused.c.execute(POST)).response.status).toBe(201);
  });
});

describe('UpstreamClient tokens', () => {
  function tokens(values: string[]): TokenProvider & { invalidations: number } {
    let current = values.shift();
    return {
      refreshable: true,
      invalidations: 0,
      authorization() {
        return Promise.resolve(`Bearer ${current}`);
      },
      invalidate() {
        this.invalidations++;
        current = values.shift();
      },
    };
  }

  it('refreshes the token once on 401 and retries', async () => {
    const t = tokens(['old', 'new']);
    const { c, seen } = client([upstreamJson(401), upstreamJson(200)], {
      tokens: t,
    });
    const out = await c.execute(GET);
    expect(out.response.status).toBe(200);
    expect(out.attempts).toBe(2);
    expect(t.invalidations).toBe(1);
    expect(seen.map((s) => s.auth)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('returns the second 401 instead of looping', async () => {
    const t = tokens(['a', 'b', 'c']);
    const { c } = client(
      [upstreamJson(401), upstreamJson(401), upstreamJson(200)],
      { tokens: t },
    );
    const out = await c.execute(GET);
    expect(out.response.status).toBe(401);
    expect(t.invalidations).toBe(1);
  });

  it('maps token endpoint failures to 502', async () => {
    const failing: TokenProvider = {
      refreshable: true,
      authorization: () =>
        Promise.reject(
          new TokenError('token endpoint responded with HTTP 401', 401),
        ),
      invalidate: () => undefined,
    };
    const { c } = client([upstreamJson(200)], { tokens: failing });
    const err = await c.execute(GET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect((err as Error).message).toContain('Token request failed');
  });
});

describe('UpstreamClient concurrency', () => {
  it('runs at most 8 requests per connection at a time', async () => {
    let active = 0;
    let peak = 0;
    const c = new UpstreamClient({
      endpoint: {
        transport: {
          send: async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            return upstreamJson(200);
          },
        },
      },
      mode: 'test',
      concurrency: 8,
      sleep: () => Promise.resolve(),
      clock: new ManualClock(),
      random: () => 0,
    });
    await Promise.all(Array.from({ length: 30 }, () => c.execute(GET)));
    expect(peak).toBe(8);
    expect(c.inFlight).toBe(0);
  });
});
