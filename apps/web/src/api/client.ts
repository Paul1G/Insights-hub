// Typed client for the Asset Model Studio backend proxy (backend/).
// Contract: docs/api-contract.md. All URLs are relative (nginx routes /api).
//
// The proxy never exposes credentials to the browser. Upstream Insights Hub
// responses are returned as AmResponse with their real HTTP status inside the
// envelope; only proxy-level failures (bad request, unknown connection, token
// failure, network) surface as ApiError.

import type { AmErrorBody, AmFileMetadata, AmPage } from "./amTypes";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Upstream (Insights Hub) error after retries. */
export class UpstreamError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly messages: string[];
  constructor(status: number, body: unknown) {
    const messages = upstreamMessages(body);
    super(messages[0] ?? `Insights Hub responded with HTTP ${status}`);
    this.name = "UpstreamError";
    this.status = status;
    this.body = body;
    this.messages = messages;
  }
  get isConflict(): boolean {
    return this.status === 412;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export function upstreamMessages(body: unknown): string[] {
  const errors = (body as AmErrorBody | undefined)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => [e.message, e.errorcode ?? e.code].filter(Boolean).join(" — ")).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export interface Me {
  anonymous: boolean;
  userId: string | null;
  email?: string;
  username?: string;
}

export type AuthMode = "client_credentials" | "app_credentials" | "bearer" | "simulator";

export type AuthInput =
  | { mode: "client_credentials"; tokenUrl: string; clientId: string; clientSecret?: string }
  | {
      mode: "app_credentials";
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      appName: string;
      appVersion: string;
      hostTenant: string;
      userTenant: string;
    }
  | { mode: "bearer"; token?: string }
  | { mode: "simulator" };

export interface ConnectionInput {
  name: string;
  /** Free label, e.g. "dev", "qa", "prod". */
  environment: string;
  /** Tenant name (<= 8 chars) used to compose type ids. */
  tenant: string;
  /** e.g. https://gateway.eu1.mindsphere.io/api/assetmanagement/v3 (not used by the simulator). */
  apiBaseUrl?: string;
  /** Secrets may be omitted on update to keep the stored ones. */
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
  /** Masked client id, e.g. "abcd…wxyz". */
  clientIdHint?: string;
  appName?: string;
  appVersion?: string;
  hostTenant?: string;
  userTenant?: string;
  createdAt: string;
  updatedAt: string;
  lastTest?: { at: string; ok: boolean; message?: string; latencyMs?: number };
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  rootAssetId?: string;
  rootName?: string;
  message?: string;
}

export type HttpMethod = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";

export interface AmRequest {
  method: HttpMethod;
  /** Path relative to the Asset Management v3 base, e.g. "/assettypes/acme.Pump". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  ifMatch?: string | number;
  ifNoneMatch?: string;
  body?: unknown;
  contentType?: "application/json" | "application/merge-patch+json";
}

export interface AmResponse<T = unknown> {
  status: number;
  /** ETag response header (numeric etag as string), when present. */
  etag?: string;
  body: T;
  attempts: number;
  durationMs: number;
}

export type ListResource =
  | "assets"
  | "assettypes"
  | "aspecttypes"
  | "files"
  | "asset-variables"
  | "asset-aspects";

export interface ListRequest {
  resource: ListResource;
  /** Required for asset-variables / asset-aspects. */
  assetId?: string;
  /** JSON filter string (see docs/reference/filtering.txt). */
  filter?: string;
  sort?: string;
  exploded?: boolean;
  basicFieldsOnly?: boolean;
  includeShared?: boolean;
  /** Stop after this many items (still fetched in pages of 200). */
  maxItems?: number;
}

export interface ListResult<T> {
  items: T[];
  totalElements: number;
  totalPages: number;
  /** Pages that failed after retries; the list is then incomplete. */
  partialFailures: { page: number; status: number; message: string }[];
  durationMs: number;
}

export interface FileUploadInput {
  name: string;
  description?: string;
  scope?: "private" | "public";
  /** Original file name (extension used for the content-type check). */
  fileName: string;
  mimeType: string;
  contentBase64: string;
}

export interface FileContent {
  mimeType: string;
  contentBase64: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  userId: string;
  connectionId?: string;
  connectionName?: string;
  /** Upstream call (method + path) or an app-level action. */
  kind: "upstream" | "connection" | "action";
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  attempts?: number;
  action?: string;
  summary?: string;
  details?: Record<string, unknown>;
  error?: string;
}

export interface AuditAppend {
  connectionId?: string;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface Envelope<T> {
  data?: T;
  error?: string;
}

async function call<T>(method: HttpMethod, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "The Asset Model Studio backend is not reachable (offline?).");
  }
  let env: Envelope<T> = {};
  const text = await res.text();
  if (text) {
    try {
      env = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new ApiError(res.status, `Unexpected response from backend (HTTP ${res.status}).`);
    }
  }
  if (!res.ok || env.error) throw new ApiError(res.status, env.error ?? `Backend error (HTTP ${res.status}).`);
  return env.data as T;
}

const enc = encodeURIComponent;

export const api = {
  me: (signal?: AbortSignal) => call<Me>("GET", "/api/me", undefined, signal),

  connections: {
    list: () => call<ConnectionSummary[]>("GET", "/api/connections"),
    create: (input: ConnectionInput) => call<ConnectionSummary>("POST", "/api/connections", input),
    update: (id: string, input: ConnectionInput) => call<ConnectionSummary>("PUT", `/api/connections/${enc(id)}`, input),
    remove: (id: string) => call<{ deleted: true }>("DELETE", `/api/connections/${enc(id)}`),
    test: (id: string) => call<ConnectionTestResult>("POST", `/api/connections/${enc(id)}/test`),
  },

  /** Raw proxied call. Never throws for upstream HTTP errors — inspect `status`. */
  am: <T = unknown>(connectionId: string, req: AmRequest, signal?: AbortSignal) =>
    call<AmResponse<T>>("POST", `/api/connections/${enc(connectionId)}/am`, req, signal),

  /** Proxied call that throws UpstreamError for status >= 400. */
  async amOk<T = unknown>(connectionId: string, req: AmRequest, signal?: AbortSignal): Promise<AmResponse<T>> {
    const res = await api.am<T>(connectionId, req, signal);
    if (res.status >= 400) throw new UpstreamError(res.status, res.body);
    return res;
  },

  /** Read all pages (size=200, concurrent) of a list endpoint. */
  listAll: <T = unknown>(connectionId: string, req: ListRequest, signal?: AbortSignal) =>
    call<ListResult<T>>("POST", `/api/connections/${enc(connectionId)}/list`, req, signal),

  files: {
    upload: (connectionId: string, input: FileUploadInput) =>
      call<AmResponse<AmFileMetadata>>("POST", `/api/connections/${enc(connectionId)}/files`, input),
    replace: (connectionId: string, fileId: string, ifMatch: string | number, input: FileUploadInput) =>
      call<AmResponse<AmFileMetadata>>("PUT", `/api/connections/${enc(connectionId)}/files/${enc(fileId)}`, {
        ...input,
        ifMatch: String(ifMatch),
      }),
    download: (connectionId: string, fileId: string) =>
      call<AmResponse<FileContent>>("GET", `/api/connections/${enc(connectionId)}/files/${enc(fileId)}/content`),
  },

  audit: {
    list: (q: { connectionId?: string; limit?: number; before?: string } = {}) => {
      const params = new URLSearchParams();
      if (q.connectionId) params.set("connectionId", q.connectionId);
      if (q.limit) params.set("limit", String(q.limit));
      if (q.before) params.set("before", q.before);
      const qs = params.toString();
      return call<AuditEntry[]>("GET", `/api/audit${qs ? `?${qs}` : ""}`);
    },
    append: (entry: AuditAppend) => call<AuditEntry>("POST", "/api/audit", entry),
  },
};

/** Page shape of list endpoints, for callers that page manually. */
export type { AmPage };

/** Base64 helpers for file transfer through the JSON proxy. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBlob(b64: string, mimeType: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}
