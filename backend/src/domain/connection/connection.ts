// domain/connection defines a tenant connection: where the Asset Management
// v3 API lives and how to authenticate against it. The complete
// ConnectionConfig (URLs and secrets) is what gets encrypted at rest.
//
// Wire shapes (ConnectionInput, ConnectionSummary, ConnectionTestResult)
// match apps/web/src/api/client.ts exactly.

export type AuthMode =
  | 'client_credentials'
  | 'app_credentials'
  | 'bearer'
  | 'simulator';

export const AUTH_MODES: readonly AuthMode[] = [
  'client_credentials',
  'app_credentials',
  'bearer',
  'simulator',
];

/** Stored authentication settings, secrets included. */
export type StoredAuth =
  | {
      mode: 'client_credentials';
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
    }
  | {
      mode: 'app_credentials';
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      appName: string;
      appVersion: string;
      hostTenant: string;
      userTenant: string;
    }
  | { mode: 'bearer'; token: string }
  | { mode: 'simulator' };

export interface LastTest {
  at: string;
  ok: boolean;
  message?: string;
  latencyMs?: number;
}

/** The encrypted part of a connection. */
export interface ConnectionConfig {
  name: string;
  environment: string;
  tenant: string;
  apiBaseUrl?: string;
  auth: StoredAuth;
  lastTest?: LastTest;
}

export interface ConnectionRecord {
  id: string;
  /** Owner scope (user id or "anonymous"). */
  userId: string;
  createdAt: string;
  updatedAt: string;
  config: ConnectionConfig;
}

/** Incoming auth settings; secrets may be omitted on update to keep them. */
export type AuthInput =
  | {
      mode: 'client_credentials';
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
    }
  | {
      mode: 'app_credentials';
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      appName: string;
      appVersion: string;
      hostTenant: string;
      userTenant: string;
    }
  | { mode: 'bearer'; token?: string }
  | { mode: 'simulator' };

export interface ConnectionInput {
  name: string;
  environment: string;
  tenant: string;
  apiBaseUrl?: string;
  auth: AuthInput;
}

export interface ConnectionSummary {
  id: string;
  name: string;
  environment: string;
  tenant: string;
  apiBaseUrl?: string;
  authMode: AuthMode;
  tokenUrl?: string;
  clientIdHint?: string;
  appName?: string;
  appVersion?: string;
  hostTenant?: string;
  userTenant?: string;
  createdAt: string;
  updatedAt: string;
  lastTest?: LastTest;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  rootAssetId?: string;
  rootName?: string;
  message?: string;
}

/**
 * maskClientId keeps just enough of a client id to recognise it:
 * "abcd…wxyz" for long ids, "ab…yz" for medium ids, "…" for very short ones
 * (where showing any characters would reveal most of the id).
 */
export function maskClientId(clientId: string): string {
  const id = clientId.trim();
  if (id.length >= 12) return `${id.slice(0, 4)}…${id.slice(-4)}`;
  if (id.length >= 6) return `${id.slice(0, 2)}…${id.slice(-2)}`;
  return '…';
}

/** toSummary projects a record onto the secret-free wire shape. */
export function toSummary(rec: ConnectionRecord): ConnectionSummary {
  const c = rec.config;
  const a = c.auth;
  const summary: ConnectionSummary = {
    id: rec.id,
    name: c.name,
    environment: c.environment,
    tenant: c.tenant,
    authMode: a.mode,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  if (c.apiBaseUrl !== undefined && a.mode !== 'simulator') {
    summary.apiBaseUrl = c.apiBaseUrl;
  }
  if (a.mode === 'client_credentials' || a.mode === 'app_credentials') {
    summary.tokenUrl = a.tokenUrl;
    summary.clientIdHint = maskClientId(a.clientId);
  }
  if (a.mode === 'app_credentials') {
    summary.appName = a.appName;
    summary.appVersion = a.appVersion;
    summary.hostTenant = a.hostTenant;
    summary.userTenant = a.userTenant;
  }
  if (c.lastTest) summary.lastTest = { ...c.lastTest };
  return summary;
}
