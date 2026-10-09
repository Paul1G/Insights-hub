// platform/semaphore is a FIFO counting semaphore used to cap concurrent
// upstream requests per connection; callers beyond the limit queue.

export class Semaphore {
  private readonly max: number;
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error('semaphore: max must be a positive integer');
    }
    this.max = max;
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // The releasing caller handed its slot over; `active` is unchanged.
    return this.releaser();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.active--;
      }
    };
  }
}

/**
 * mapPool maps `items` through `fn` with at most `limit` calls in flight,
 * preserving input order in the result.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
