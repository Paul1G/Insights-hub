// The subset of the backend client the online CRUD helpers depend on. Pages
// pass `defaultTransport` (the real proxy client); unit tests inject fakes, so
// every helper in src/online is testable without a network.

import {
  api,
  type AmRequest,
  type AmResponse,
  type AuditAppend,
  type AuditEntry,
  type ListRequest,
  type ListResult,
} from "@/api/client";

export interface AmTransport {
  /** Raw proxied call: never throws for upstream HTTP errors (inspect `status`). */
  am<T = unknown>(connectionId: string, req: AmRequest, signal?: AbortSignal): Promise<AmResponse<T>>;
  /** All pages of a list endpoint (size=200, fetched concurrently by the proxy). */
  listAll<T = unknown>(connectionId: string, req: ListRequest, signal?: AbortSignal): Promise<ListResult<T>>;
}

export interface AuditSink {
  append(entry: AuditAppend): Promise<AuditEntry>;
}

export const defaultTransport: AmTransport = {
  am: (connectionId, req, signal) => api.am(connectionId, req, signal),
  listAll: (connectionId, req, signal) => api.listAll(connectionId, req, signal),
};

export const defaultAuditSink: AuditSink = {
  append: (entry) => api.audit.append(entry),
};

const enc = encodeURIComponent;

/** Path builders for the Asset Management v3 operations used by the explorer. */
export const amPath = {
  aspectType: (id: string) => `/aspecttypes/${enc(id)}`,
  aspectTypeVariables: (id: string) => `/aspecttypes/${enc(id)}/variables`,
  assetType: (id: string) => `/assettypes/${enc(id)}`,
  assetTypeVariables: (id: string) => `/assettypes/${enc(id)}/variables`,
  assetTypeFileAssignment: (id: string, key: string) => `/assettypes/${enc(id)}/fileAssignments/${enc(key)}`,
  assets: () => "/assets",
  rootAsset: () => "/assets/root",
  asset: (id: string) => `/assets/${enc(id)}`,
  assetMove: (id: string) => `/assets/${enc(id)}/move`,
  assetLocation: (id: string) => `/assets/${enc(id)}/location`,
  assetFileAssignment: (id: string, key: string) => `/assets/${enc(id)}/fileAssignments/${enc(key)}`,
  file: (id: string) => `/files/${enc(id)}`,
} as const;
