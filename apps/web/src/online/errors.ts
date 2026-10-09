// User-facing description of failures from the proxy (ApiError) and from
// Insights Hub (UpstreamError, messages taken from the upstream error body).

import { ApiError, UpstreamError, upstreamMessages } from "@/api/client";

export interface ErrorInfo {
  title: string;
  /** Upstream / proxy messages, most specific first. */
  messages: string[];
  /** HTTP status (upstream status for UpstreamError, proxy status for ApiError). */
  status?: number;
  /** Actionable hint (roles, offline, token endpoint …). */
  hint?: string;
  /** True when the backend itself is not reachable. */
  offline: boolean;
}

export const ROLE_HINT =
  "The technical user (service or application credentials) needs Asset Management roles, " +
  "e.g. mdsp:core:assetmanagement.admin as used in the official samples.";

export const OFFLINE_HINT =
  "Tenant features need the Asset Model Studio backend. Projects, modelling, validation and " +
  "exports keep working offline.";

/** Upstream error for an AmResponse with status >= 400. */
export function upstreamError(status: number, body: unknown): UpstreamError {
  return new UpstreamError(status, body);
}

export function isOfflineError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 0;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

export function describeError(e: unknown): ErrorInfo {
  if (e instanceof UpstreamError) {
    const messages = e.messages.length ? e.messages : [e.message];
    let hint: string | undefined;
    if (e.status === 401 || e.status === 403) hint = ROLE_HINT;
    else if (e.status === 412) hint = "The resource was changed on the server since it was loaded (ETag mismatch).";
    else if (e.status === 404) hint = "The resource no longer exists on the tenant. Refresh the list.";
    else if (e.status === 429) hint = "Insights Hub rate limit reached. Wait a moment and retry.";
    return { title: `Insights Hub responded with HTTP ${e.status}`, messages, status: e.status, hint, offline: false };
  }
  if (e instanceof ApiError) {
    if (e.status === 0) {
      return { title: "Backend not reachable", messages: [e.message], status: 0, hint: OFFLINE_HINT, offline: true };
    }
    let hint: string | undefined;
    if (e.status === 502) {
      hint = "The proxy could not reach Insights Hub or the token endpoint. Check the URLs and credentials, then test the connection.";
    } else if (e.status === 404) {
      hint = "The connection does not exist (anymore). Open the tenant connections page.";
    } else if (e.status === 429) {
      hint = "Too many requests. Wait a moment and retry.";
    } else if (e.status === 401 || e.status === 403) {
      hint = ROLE_HINT;
    }
    return { title: `Backend error (HTTP ${e.status})`, messages: [e.message], status: e.status, hint, offline: false };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { title: "Unexpected error", messages: [message], offline: false };
}

/** One-line text for toasts and batch results. */
export function errorText(e: unknown): string {
  const info = describeError(e);
  const head = info.messages[0] ?? info.title;
  return info.status !== undefined && info.status > 0 && !head.includes(String(info.status))
    ? `HTTP ${info.status}: ${head}`
    : head;
}

/** Message list for an upstream response body (falls back to the status). */
export function responseMessages(status: number, body: unknown): string[] {
  const msgs = upstreamMessages(body);
  return msgs.length ? msgs : [`Insights Hub responded with HTTP ${status}`];
}
