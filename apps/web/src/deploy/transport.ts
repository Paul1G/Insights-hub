// Transport abstraction for everything that talks to a tenant.
//
// The production implementation wraps the backend proxy client (api.am,
// api.listAll, api.files.*) for one connection; tests inject an in-memory
// fake. `request` never throws for upstream HTTP errors — callers inspect
// `status` (412 conflicts, 404s and 400 validation errors stay inspectable).

import {
  api,
  type AmRequest,
  type AmResponse,
  type FileContent,
  type FileUploadInput,
  type ListRequest,
  type ListResult,
} from "@/api/client";
import type { AmFileMetadata } from "@/api/amTypes";

export interface Transport {
  request<T = unknown>(req: AmRequest): Promise<AmResponse<T>>;
  listAll<T = unknown>(req: ListRequest): Promise<ListResult<T>>;
  /** Multipart POST /files. */
  uploadFile(input: FileUploadInput): Promise<AmResponse<AmFileMetadata>>;
  /** Multipart PUT /files/{fileId} with If-Match. */
  replaceFile(fileId: string, ifMatch: string | number, input: FileUploadInput): Promise<AmResponse<AmFileMetadata>>;
  /** GET /files/{fileId}/file as base64. */
  downloadFile(fileId: string): Promise<AmResponse<FileContent>>;
}

export function createApiTransport(connectionId: string): Transport {
  return {
    request: <T,>(req: AmRequest) => api.am<T>(connectionId, req),
    listAll: <T,>(req: ListRequest) => api.listAll<T>(connectionId, req),
    uploadFile: (input) => api.files.upload(connectionId, input),
    replaceFile: (fileId, ifMatch, input) => api.files.replace(connectionId, fileId, ifMatch, input),
    downloadFile: (fileId) => api.files.download(connectionId, fileId),
  };
}

/** Path segment encoding for ids and file-assignment keys. */
export const seg = (s: string): string => encodeURIComponent(s);

/** Numeric ETag from a response (header first, then the resource body). */
export function etagOf(res: AmResponse<unknown>): string | undefined {
  if (res.etag !== undefined && res.etag !== "") return String(res.etag).replace(/^W\//, "").replace(/"/g, "");
  const body = res.body as { etag?: unknown } | null | undefined;
  if (body && typeof body === "object" && (typeof body.etag === "number" || typeof body.etag === "string")) {
    return String(body.etag);
  }
  return undefined;
}
