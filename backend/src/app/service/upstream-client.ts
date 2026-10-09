// app/service/upstream-client wraps a connection's UpstreamEndpoint with the
// resilience rules from docs/api-contract.md:
//
//   - exponential backoff with full jitter: delay = random(0, min(cap,
//     base * factor^retry)), base 500 ms, factor 2, max 5 retries, cap 20 s;
//   - retried on 429, 502, 503, 504 and network errors; Retry-After (seconds
//     or HTTP date) replaces the jittered delay, capped at the same 20 s;
//   - POST (non-idempotent) is retried only on 429 and on connection errors
//     that provably happened before the request reached the server;
//   - at most N concurrent upstream requests per connection (FIFO queue);
//     a slot is held per attempt, never while sleeping between attempts;
//   - an upstream 401 drops the cached token and retries once.

import {
  TokenError,
  UpstreamNetworkError,
  type UpstreamEndpoint,
  type UpstreamRequest,
  type UpstreamResponse,
} from '../../domain/upstream/transport.js';
import { UpstreamUnavailableError } from '../../domain/errors.js';
import type { Clock, Random, Sleep } from '../../platform/clock.js';
import type { Metrics } from '../../platform/metrics.js';
import { Semaphore } from '../../platform/semaphore.js';

export interface RetryPolicy {
  baseDelayMs: number;
  factor: number;
  maxRetries: number;
  capMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 500,
  factor: 2,
  maxRetries: 5,
  capMs: 20_000,
};

export interface UpstreamResult {
  response: UpstreamResponse;
  /** Total HTTP attempts, including token-refresh retries. */
  attempts: number;
  durationMs: number;
}

/** Full-jitter delay before retry number `retryIndex` (0-based). */
export function backoffDelayMs(
  retryIndex: number,
  policy: RetryPolicy,
  random: Random,
): number {
  const ceiling = Math.min(
    policy.capMs,
    policy.baseDelayMs * policy.factor ** retryIndex,
  );
  return Math.floor(random() * ceiling);
}

/** Parses a Retry-After header (delta-seconds or HTTP-date) into ms. */
export function parseRetryAfterMs(
  value: string | undefined,
  nowMs: number,
): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

function isRetryableStatus(status: number, method: string): boolean {
  if (status === 429) return true;
  if (method === 'POST') return false;
  return status === 502 || status === 503 || status === 504;
}

export interface UpstreamClientOptions {
  endpoint: UpstreamEndpoint;
  /** Auth mode label for metrics. */
  mode: string;
  concurrency: number;
  policy?: RetryPolicy;
  sleep: Sleep;
  clock: Clock;
  random: Random;
  metrics?: Metrics;
}

export class UpstreamClient {
  private readonly endpoint: UpstreamEndpoint;
  private readonly mode: string;
  private readonly limiter: Semaphore;
  private readonly policy: RetryPolicy;
  private readonly sleep: Sleep;
  private readonly clock: Clock;
  private readonly random: Random;
  private readonly metrics?: Metrics;

  constructor(o: UpstreamClientOptions) {
    this.endpoint = o.endpoint;
    this.mode = o.mode;
    this.limiter = new Semaphore(o.concurrency);
    this.policy = o.policy ?? DEFAULT_RETRY_POLICY;
    this.sleep = o.sleep;
    this.clock = o.clock;
    this.random = o.random;
    if (o.metrics) this.metrics = o.metrics;
  }

  /** Requests currently being sent (for tests and diagnostics). */
  get inFlight(): number {
    return this.limiter.inFlight;
  }

  async execute(req: UpstreamRequest): Promise<UpstreamResult> {
    const started = this.clock.now();
    let attempts = 0;
    let retries = 0;
    let refreshed = false;

    for (;;) {
      const authorization = await this.authorization();
      attempts++;
      let res: UpstreamResponse;
      try {
        res = await this.limiter.run(() =>
          this.endpoint.transport.send(req, authorization),
        );
      } catch (err) {
        if (!(err instanceof UpstreamNetworkError)) throw err;
        this.metrics?.upstreamAttemptsTotal.labels(this.mode, 'network').inc();
        const retryable = req.method !== 'POST' || err.connectFailure;
        if (retryable && retries < this.policy.maxRetries) {
          this.metrics?.upstreamRetriesTotal.labels(this.mode, 'network').inc();
          await this.sleep(backoffDelayMs(retries, this.policy, this.random));
          retries++;
          continue;
        }
        throw new UpstreamUnavailableError(
          `Insights Hub is not reachable: ${err.message}`,
          { cause: err },
        );
      }
      this.metrics?.upstreamAttemptsTotal
        .labels(this.mode, String(res.status))
        .inc();

      if (
        res.status === 401 &&
        !refreshed &&
        this.endpoint.tokens?.refreshable
      ) {
        refreshed = true;
        this.endpoint.tokens.invalidate();
        this.metrics?.upstreamRetriesTotal
          .labels(this.mode, 'token_refresh')
          .inc();
        continue;
      }

      if (
        isRetryableStatus(res.status, req.method) &&
        retries < this.policy.maxRetries
      ) {
        const retryAfter = parseRetryAfterMs(
          res.headers['retry-after'],
          this.clock.now(),
        );
        const delay =
          retryAfter !== undefined
            ? Math.min(retryAfter, this.policy.capMs)
            : backoffDelayMs(retries, this.policy, this.random);
        this.metrics?.upstreamRetriesTotal
          .labels(this.mode, String(res.status))
          .inc();
        await this.sleep(delay);
        retries++;
        continue;
      }

      return {
        response: res,
        attempts,
        durationMs: this.clock.now() - started,
      };
    }
  }

  private async authorization(): Promise<string | undefined> {
    const tokens = this.endpoint.tokens;
    if (!tokens) return undefined;
    try {
      return await tokens.authorization();
    } catch (err) {
      if (err instanceof TokenError) {
        throw new UpstreamUnavailableError(
          `Token request failed: ${err.message}`,
          {
            cause: err,
          },
        );
      }
      throw err;
    }
  }
}
