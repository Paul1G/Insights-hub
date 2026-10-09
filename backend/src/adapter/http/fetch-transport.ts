// adapter/http/fetch-transport sends one Asset Management v3 request to a
// real Insights Hub gateway using the platform fetch (undici). Redirects are
// never followed (SSRF: a 3xx is returned as is), every attempt has a
// timeout, and network failures are classified so the retry policy knows
// whether a POST may be repeated safely.

import {
  UpstreamNetworkError,
  type UpstreamRequest,
  type UpstreamResponse,
  type UpstreamTransport,
} from '../../domain/upstream/transport.js';

export type FetchFn = typeof fetch;

// Failures that happen before any byte of the request reached the server.
const CONNECT_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function errorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (
    let depth = 0;
    depth < 4 && cur !== null && typeof cur === 'object';
    depth++
  ) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function classifyFetchError(err: unknown): UpstreamNetworkError {
  if (err instanceof UpstreamNetworkError) return err;
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new UpstreamNetworkError('request timed out', false, { cause: err });
  }
  const code = errorCode(err);
  const connect = code !== undefined && CONNECT_FAILURE_CODES.has(code);
  const detail = code ?? (err instanceof Error ? err.message : 'unknown error');
  return new UpstreamNetworkError(
    connect ? `connection failed (${detail})` : `network error (${detail})`,
    connect,
    { cause: err },
  );
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): URL {
  const url = new URL(`${baseUrl}${path === '/' ? '/' : path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return url;
}

export function responseHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export class FetchTransport implements UpstreamTransport {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(o: { baseUrl: string; fetch: FetchFn; timeoutMs: number }) {
    this.baseUrl = o.baseUrl;
    this.fetchFn = o.fetch;
    this.timeoutMs = o.timeoutMs;
  }

  async send(
    req: UpstreamRequest,
    authorization?: string,
  ): Promise<UpstreamResponse> {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (authorization) headers.authorization = authorization;
    let body: string | FormData | undefined;
    if (req.body?.kind === 'json') {
      headers['content-type'] = req.body.contentType;
      body = req.body.text;
    } else if (req.body?.kind === 'multipart') {
      // fetch sets multipart/form-data with the boundary itself.
      body = req.body.form();
    }

    let res: Response;
    try {
      res = await this.fetchFn(buildUrl(this.baseUrl, req.path, req.query), {
        method: req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err);
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      const e = classifyFetchError(err);
      // The server already answered: never treat this as a connect failure.
      throw new UpstreamNetworkError(e.message, false, { cause: err });
    }
    return { status: res.status, headers: responseHeaders(res), body: bytes };
  }
}
