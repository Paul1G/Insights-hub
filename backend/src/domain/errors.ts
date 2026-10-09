// domain/errors defines the typed errors raised by services. The HTTP layer
// translates them into the `{"error": "..."}` envelope with the status listed
// in docs/api-contract.md ("Proxy-level failures only").

export type AppErrorKind =
  | 'validation'
  | 'not_found'
  | 'payload_too_large'
  | 'rate_limited'
  | 'upstream_unavailable';

const STATUS: Record<AppErrorKind, number> = {
  validation: 400,
  not_found: 404,
  payload_too_large: 413,
  rate_limited: 429,
  upstream_unavailable: 502,
};

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly status: number;
  constructor(
    kind: AppErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AppError';
    this.kind = kind;
    this.status = STATUS[kind];
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super('validation', message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super('not_found', message);
    this.name = 'NotFoundError';
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super('payload_too_large', message);
    this.name = 'PayloadTooLargeError';
  }
}

export class RateLimitedError extends AppError {
  constructor(message: string) {
    super('rate_limited', message);
    this.name = 'RateLimitedError';
  }
}

/** Token endpoint or network failure towards Insights Hub (502). */
export class UpstreamUnavailableError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('upstream_unavailable', message, options);
    this.name = 'UpstreamUnavailableError';
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
