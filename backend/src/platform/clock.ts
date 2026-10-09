// platform/clock abstracts time so retry/backoff, token caching and rate
// limiting are testable without real waiting.

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export type Sleep = (ms: number) => Promise<void>;

export const systemClock: Clock = { now: () => Date.now() };

export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/** Random source in [0, 1); injectable for deterministic jitter in tests. */
export type Random = () => number;
