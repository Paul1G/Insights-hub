// platform/rate-limiter implements a keyed token bucket: each key (user
// scope) may burst up to `burst` requests and refills at `perSecond` tokens
// per second. Idle, full buckets are evicted to bound memory.

import type { Clock } from './clock.js';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class KeyedRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perSecond: number;
  private readonly burst: number;
  private readonly clock: Clock;
  private lastSweep: number;

  constructor(opts: { perSecond: number; burst: number; clock: Clock }) {
    this.perSecond = opts.perSecond;
    this.burst = opts.burst;
    this.clock = opts.clock;
    this.lastSweep = opts.clock.now();
  }

  /** Consumes one token for `key`; false when the caller must be throttled. */
  tryTake(key: string): boolean {
    const now = this.clock.now();
    this.sweep(now);
    const b = this.buckets.get(key) ?? { tokens: this.burst, updatedAt: now };
    const elapsed = Math.max(0, now - b.updatedAt) / 1000;
    b.tokens = Math.min(this.burst, b.tokens + elapsed * this.perSecond);
    b.updatedAt = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const refillMs = (this.burst / this.perSecond) * 1000;
    for (const [key, b] of this.buckets) {
      if (now - b.updatedAt > refillMs) this.buckets.delete(key);
    }
  }
}
