// Audit log paging ("load older" via the `before` cursor) and CSV export.

import type { AuditEntry } from "@/api/client";
import { toCsv } from "@/portability/csv";

export const AUDIT_PAGE_SIZE = 100;

/** Cursor for the next (older) page: the timestamp of the oldest loaded entry. */
export function olderCursor(entries: readonly AuditEntry[]): string | undefined {
  let oldest: string | undefined;
  for (const e of entries) if (!oldest || e.at < oldest) oldest = e.at;
  return oldest;
}

/** Append an older page, dropping duplicates (same id), newest first. */
export function mergeOlder(current: readonly AuditEntry[], older: readonly AuditEntry[]): AuditEntry[] {
  const seen = new Set(current.map((e) => e.id));
  const out = [...current, ...older.filter((e) => !seen.has(e.id))];
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** "Method + path" for upstream calls, the action name for app-level entries. */
export function auditOperation(e: AuditEntry): string {
  if (e.method || e.path) return [e.method, e.path].filter(Boolean).join(" ");
  return e.action ?? "";
}

export function auditOutcome(e: AuditEntry): "ok" | "failed" | "info" {
  if (e.error) return "failed";
  if (e.status === undefined) return "info";
  return e.status >= 400 ? "failed" : "ok";
}

export const AUDIT_CSV_HEADERS = [
  "time",
  "user",
  "connection",
  "connectionId",
  "kind",
  "method",
  "path",
  "action",
  "status",
  "durationMs",
  "attempts",
  "summary",
  "error",
] as const;

/** Neutralise spreadsheet formulas in free-text cells (CSV injection). */
export function safeCell(value: string | undefined): string {
  const v = value ?? "";
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export function auditCsv(entries: readonly AuditEntry[]): string {
  return toCsv(
    [...AUDIT_CSV_HEADERS],
    entries.map((e) => ({
      time: e.at,
      user: safeCell(e.userId),
      connection: safeCell(e.connectionName),
      connectionId: safeCell(e.connectionId),
      kind: e.kind,
      method: e.method ?? "",
      path: safeCell(e.path),
      action: safeCell(e.action),
      status: e.status ?? "",
      durationMs: e.durationMs ?? "",
      attempts: e.attempts ?? "",
      summary: safeCell(e.summary),
      error: safeCell(e.error),
    })),
  );
}

export function auditCsvFileName(now = new Date(), connectionName?: string): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const scope = connectionName ? `-${connectionName.replace(/[^A-Za-z0-9_-]+/g, "_")}` : "";
  return `audit-log${scope}-${stamp}.csv`;
}
