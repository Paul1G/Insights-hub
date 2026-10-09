// adapter/http/token-providers obtain access tokens for Insights Hub:
//
//   client_credentials — OAuth 2.0 client credentials (service credentials):
//     POST tokenUrl, Authorization: Basic base64(id:secret),
//     body grant_type=client_credentials (form-encoded).
//   app_credentials — Token Management Service (application credentials):
//     POST tokenUrl, X-SPACE-AUTH-KEY: Basic base64(id:secret),
//     JSON body {appName, appVersion, hostTenant, userTenant}.
//   bearer — a pasted token; cannot be refreshed.
//
// Tokens are cached until expires_in - 60 s; concurrent callers share one
// in-flight token request. Token values never leave this module except as
// the Authorization header value handed to the transport.

import {
  TokenError,
  type TokenProvider,
} from '../../domain/upstream/transport.js';
import type { Clock } from '../../platform/clock.js';

import { classifyFetchError, type FetchFn } from './fetch-transport.js';

const EXPIRY_SAFETY_SECONDS = 60;

interface CachedToken {
  value: string;
  expiresAt: number;
}

interface TokenRequest {
  headers: Record<string, string>;
  body: string;
}

abstract class FetchedTokenProvider implements TokenProvider {
  readonly refreshable = true;
  private readonly tokenUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private cached: CachedToken | undefined;
  private inFlight: Promise<CachedToken> | undefined;

  protected constructor(o: {
    tokenUrl: string;
    fetch: FetchFn;
    clock: Clock;
    timeoutMs: number;
  }) {
    this.tokenUrl = o.tokenUrl;
    this.fetchFn = o.fetch;
    this.clock = o.clock;
    this.timeoutMs = o.timeoutMs;
  }

  protected abstract request(): TokenRequest;

  async authorization(): Promise<string> {
    const now = this.clock.now();
    if (this.cached && now < this.cached.expiresAt)
      return `Bearer ${this.cached.value}`;
    if (!this.inFlight) {
      this.inFlight = this.fetchToken().finally(() => {
        this.inFlight = undefined;
      });
    }
    const token = await this.inFlight;
    return `Bearer ${token.value}`;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<CachedToken> {
    const { headers, body } = this.request();
    let res: Response;
    try {
      res = await this.fetchFn(this.tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', ...headers },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new TokenError(
        `token endpoint is not reachable: ${classifyFetchError(err).message}`,
        undefined,
        {
          cause: err,
        },
      );
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new TokenError(
        'token endpoint response could not be read',
        res.status,
        { cause: err },
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new TokenError(
        `token endpoint responded with HTTP ${res.status}${oauthError(text)}`,
        res.status,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TokenError(
        'token endpoint returned a non-JSON response',
        res.status,
      );
    }
    const doc = parsed as { access_token?: unknown; expires_in?: unknown };
    if (typeof doc.access_token !== 'string' || doc.access_token === '') {
      throw new TokenError(
        'token endpoint response has no access_token',
        res.status,
      );
    }
    const expiresIn =
      typeof doc.expires_in === 'number'
        ? doc.expires_in
        : Number(doc.expires_in);
    const lifetime = Number.isFinite(expiresIn)
      ? expiresIn - EXPIRY_SAFETY_SECONDS
      : 0;
    // A token without a usable lifetime is used for the current call only.
    const token: CachedToken = {
      value: doc.access_token,
      expiresAt: this.clock.now() + Math.max(0, lifetime) * 1000,
    };
    this.cached = token;
    return token;
  }
}

/** Short, safe excerpt of an OAuth error response (error code only). */
function oauthError(text: string): string {
  try {
    const doc = JSON.parse(text) as { error?: unknown };
    if (typeof doc.error === 'string' && /^[\w.-]{1,64}$/.test(doc.error))
      return ` (${doc.error})`;
  } catch {
    // Not JSON: nothing safe to echo.
  }
  return '';
}

function basic(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`, 'utf8').toString('base64')}`;
}

export class ClientCredentialsTokenProvider extends FetchedTokenProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(o: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    fetch: FetchFn;
    clock: Clock;
    timeoutMs: number;
  }) {
    super(o);
    this.clientId = o.clientId;
    this.clientSecret = o.clientSecret;
  }

  protected request(): TokenRequest {
    return {
      headers: {
        authorization: basic(this.clientId, this.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    };
  }
}

export class AppCredentialsTokenProvider extends FetchedTokenProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly app: {
    appName: string;
    appVersion: string;
    hostTenant: string;
    userTenant: string;
  };

  constructor(o: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    appName: string;
    appVersion: string;
    hostTenant: string;
    userTenant: string;
    fetch: FetchFn;
    clock: Clock;
    timeoutMs: number;
  }) {
    super(o);
    this.clientId = o.clientId;
    this.clientSecret = o.clientSecret;
    this.app = {
      appName: o.appName,
      appVersion: o.appVersion,
      hostTenant: o.hostTenant,
      userTenant: o.userTenant,
    };
  }

  protected request(): TokenRequest {
    return {
      headers: {
        'x-space-auth-key': basic(this.clientId, this.clientSecret),
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.app),
    };
  }
}

export class StaticBearerTokenProvider implements TokenProvider {
  readonly refreshable = false;
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  authorization(): Promise<string> {
    return Promise.resolve(`Bearer ${this.token}`);
  }

  invalidate(): void {
    // A pasted token cannot be refreshed.
  }
}
