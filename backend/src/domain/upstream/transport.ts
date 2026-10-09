// domain/upstream/transport defines the ports through which services talk to
// an Asset Management v3 API: a raw HTTP transport (real Insights Hub over
// fetch, or the in-process simulator) and a token provider.

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';

export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'PUT',
  'POST',
  'PATCH',
  'DELETE',
];

export type UpstreamBody =
  | { kind: 'json'; contentType: string; text: string }
  /**
   * Multipart form data. A factory (not a FormData instance) so every retry
   * attempt serialises a fresh body.
   */
  | { kind: 'multipart'; form: () => FormData };

export interface UpstreamRequest {
  method: HttpMethod;
  /** Path relative to the AM v3 base, already validated and encoded. */
  path: string;
  query?: Record<string, string>;
  /** Extra request headers (If-Match, If-None-Match, Accept). */
  headers?: Record<string, string>;
  body?: UpstreamBody;
}

export interface UpstreamResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface UpstreamTransport {
  /**
   * Performs exactly one HTTP exchange. Resolves for every HTTP status;
   * rejects with UpstreamNetworkError when no complete response arrived.
   */
  send(req: UpstreamRequest, authorization?: string): Promise<UpstreamResponse>;
}

/**
 * UpstreamNetworkError signals a failed exchange. `connectFailure` is true
 * when the request provably never reached the server (DNS failure, refused
 * connection, connect timeout) — only then is a non-idempotent POST safe to
 * retry.
 */
export class UpstreamNetworkError extends Error {
  readonly connectFailure: boolean;
  constructor(
    message: string,
    connectFailure: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'UpstreamNetworkError';
    this.connectFailure = connectFailure;
  }
}

export interface TokenProvider {
  /** Returns a value for the Authorization header ("Bearer …"). */
  authorization(): Promise<string>;
  /** Drops the cached token so the next call fetches a fresh one. */
  invalidate(): void;
  /** True if invalidate() + authorization() can yield a different token. */
  readonly refreshable: boolean;
}

/** TokenError: the token endpoint failed or returned an unusable response. */
export class TokenError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TokenError';
    if (status !== undefined) this.status = status;
  }
}

/** A connection's ready-to-use upstream pair. */
export interface UpstreamEndpoint {
  transport: UpstreamTransport;
  /** Absent for the simulator (no authentication). */
  tokens?: TokenProvider;
}
