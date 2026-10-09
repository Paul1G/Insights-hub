// Batch operations with preview, concurrency limit and per-item results.
//
// A batch is planned first (one BatchItem per selected object, carrying the
// exact request that will be sent, or the reason it is blocked), shown to the
// user as a preview, and executed only after confirmation with at most
// `concurrency` requests in flight (default 4). Every item yields a result;
// the summary is recorded as an app-level audit entry.

import type { AmRequest, AmResponse } from "@/api/client";
import type { AmAssetResource, AmVariable } from "@/api/amTypes";
import { errorText, responseMessages } from "./errors";
import { amPath, type AmTransport, type AuditSink } from "./transport";

export const BATCH_CONCURRENCY = 4;

export interface BatchItem {
  key: string;
  label: string;
  /** The request that will be sent; null when blocked. */
  request: AmRequest | null;
  /** Why the item will not be executed. */
  blockedReason?: string;
}

export type BatchOutcome = "succeeded" | "failed" | "skipped";

export interface BatchItemResult {
  key: string;
  label: string;
  outcome: BatchOutcome;
  /** Upstream HTTP status when a request was sent. */
  status?: number;
  message: string;
  attempts?: number;
  durationMs?: number;
}

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/** Run `fn` over `items` with at most `limit` concurrent calls; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** "PATCH /assets/abc · If-Match 3" — one line per previewed request. */
export function describeRequest(req: AmRequest): string {
  const parts = [`${req.method} ${req.path}`];
  if (req.ifMatch !== undefined) parts.push(`If-Match ${req.ifMatch}`);
  if (req.ifNoneMatch !== undefined) parts.push(`If-None-Match ${req.ifNoneMatch}`);
  return parts.join(" · ");
}

/** Compact JSON of the request body for the preview (undefined when there is none). */
export function describeBody(req: AmRequest, max = 300): string | undefined {
  if (req.body === undefined) return undefined;
  const s = JSON.stringify(req.body);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface RunBatchOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onResult?: (result: BatchItemResult, done: number, total: number) => void;
}

export async function runBatch(
  t: AmTransport,
  connectionId: string,
  items: readonly BatchItem[],
  opts: RunBatchOptions = {},
): Promise<{ results: BatchItemResult[]; summary: BatchSummary }> {
  let done = 0;
  const total = items.length;
  const report = (r: BatchItemResult) => {
    done += 1;
    opts.onResult?.(r, done, total);
    return r;
  };
  const results = await mapWithConcurrency(items, opts.concurrency ?? BATCH_CONCURRENCY, async (item) => {
    if (!item.request) {
      return report({ key: item.key, label: item.label, outcome: "skipped", message: item.blockedReason ?? "Blocked" });
    }
    if (opts.signal?.aborted) {
      return report({ key: item.key, label: item.label, outcome: "skipped", message: "Cancelled before it was sent" });
    }
    try {
      const res: AmResponse = await t.am(connectionId, item.request, opts.signal);
      if (res.status >= 400) {
        const hint = res.status === 412 ? " (changed on the server since the preview — refresh and retry)" : "";
        return report({
          key: item.key,
          label: item.label,
          outcome: "failed",
          status: res.status,
          message: `${responseMessages(res.status, res.body).join("; ")}${hint}`,
          attempts: res.attempts,
          durationMs: res.durationMs,
        });
      }
      return report({
        key: item.key,
        label: item.label,
        outcome: "succeeded",
        status: res.status,
        message: `HTTP ${res.status}`,
        attempts: res.attempts,
        durationMs: res.durationMs,
      });
    } catch (e) {
      return report({ key: item.key, label: item.label, outcome: "failed", message: errorText(e) });
    }
  });
  return { results, summary: summarize(results) };
}

export function summarize(results: readonly BatchItemResult[]): BatchSummary {
  const s: BatchSummary = { total: results.length, succeeded: 0, failed: 0, skipped: 0 };
  for (const r of results) s[r.outcome] += 1;
  return s;
}

export function summaryText(action: string, s: BatchSummary): string {
  return `${action}: ${s.succeeded} succeeded, ${s.failed} failed, ${s.skipped} skipped (of ${s.total}).`;
}

/** App-level audit entry with counts only (never bodies or secrets). */
export async function recordBatchAudit(
  sink: AuditSink,
  connectionId: string,
  action: string,
  title: string,
  summary: BatchSummary,
): Promise<void> {
  await sink.append({
    connectionId,
    action,
    summary: summaryText(title, summary),
    details: { ...summary },
  });
}

// ---------------------------------------------------------------------------
// Batch planners
// ---------------------------------------------------------------------------

export interface AssetChildInfo {
  /** Number of direct children (from listAll filter {"parentId": id}). */
  childCount: number;
}

/** DELETE /assets/{id} with If-Match; blocked for the root and for assets with children. */
export function planDeleteAssets(
  assets: readonly AmAssetResource[],
  children: ReadonlyMap<string, AssetChildInfo>,
): BatchItem[] {
  return assets.map((a) => {
    const base = { key: a.assetId, label: a.name };
    if (!a.parentId) return { ...base, request: null, blockedReason: "The root asset cannot be deleted." };
    const info = children.get(a.assetId);
    if (!info) return { ...base, request: null, blockedReason: "Child count unknown — refresh and retry." };
    if (info.childCount > 0) {
      return {
        ...base,
        request: null,
        blockedReason: `Has ${info.childCount} child asset${info.childCount === 1 ? "" : "s"}; delete or move them first.`,
      };
    }
    return { ...base, request: { method: "DELETE", path: amPath.asset(a.assetId), ifMatch: a.etag } };
  });
}

export type VariableTarget = { kind: "variable"; name: string } | { kind: "aspect"; aspect: string; name: string };

function upsert(vars: readonly AmVariable[], name: string, value: string): AmVariable[] {
  const out = vars.map((v) => ({ name: v.name, value: v.value }));
  const hit = out.find((v) => v.name === name);
  if (hit) hit.value = value;
  else out.push({ name, value });
  return out;
}

/**
 * PATCH /assets/{id} (merge patch) setting one asset variable or one static
 * aspect variable. Merge patch replaces arrays (RFC 7396), so the complete
 * `variables` / `aspects` array of the asset is sent with the one value changed.
 * `applicable(asset)` returns a reason when the asset does not have the variable.
 */
export function planSetVariable(
  assets: readonly AmAssetResource[],
  target: VariableTarget,
  value: string,
  applicable: (asset: AmAssetResource) => string | undefined,
): BatchItem[] {
  return assets.map((a) => {
    const base = { key: a.assetId, label: a.name };
    const reason = applicable(a);
    if (reason) return { ...base, request: null, blockedReason: reason };
    let body: Record<string, unknown>;
    if (target.kind === "variable") {
      const current = a.variables.find((v) => v.name === target.name);
      if (current?.value === value) return { ...base, request: null, blockedReason: "Already has this value." };
      body = { variables: upsert(a.variables, target.name, value) };
    } else {
      const aspects = a.aspects.map((asp) => ({ name: asp.name, variables: asp.variables.map((v) => ({ ...v })) }));
      let asp = aspects.find((x) => x.name === target.aspect);
      if (!asp) {
        asp = { name: target.aspect, variables: [] };
        aspects.push(asp);
      }
      if (asp.variables.find((v) => v.name === target.name)?.value === value) {
        return { ...base, request: null, blockedReason: "Already has this value." };
      }
      asp.variables = upsert(asp.variables, target.name, value);
      body = { aspects };
    }
    return {
      ...base,
      request: {
        method: "PATCH",
        path: amPath.asset(a.assetId),
        ifMatch: a.etag,
        contentType: "application/merge-patch+json",
        body,
      },
    };
  });
}

/**
 * POST /assets/{id}/move {newParentId} with If-Match. Blocked when the target
 * is the asset itself, one of its descendants, or already its parent.
 */
export function planMoveAssets(assets: readonly AmAssetResource[], newParent: AmAssetResource): BatchItem[] {
  const targetPath = new Set((newParent.hierarchyPath ?? []).map((p) => p.assetId));
  return assets.map((a) => {
    const base = { key: a.assetId, label: a.name };
    if (!a.parentId) return { ...base, request: null, blockedReason: "The root asset cannot be moved." };
    if (a.assetId === newParent.assetId) return { ...base, request: null, blockedReason: "An asset cannot be its own parent." };
    if (targetPath.has(a.assetId)) {
      return { ...base, request: null, blockedReason: "The target is a descendant of this asset." };
    }
    if (a.parentId === newParent.assetId) return { ...base, request: null, blockedReason: "Already below the target." };
    return {
      ...base,
      request: {
        method: "POST",
        path: amPath.assetMove(a.assetId),
        ifMatch: a.etag,
        body: { newParentId: newParent.assetId },
      },
    };
  });
}

export interface TypeForDelete {
  id: string;
  name: string;
  etag: number;
  /** Reason the delete is blocked (core type, in use, has children/instances). */
  blockedReason?: string;
}

/** DELETE /aspecttypes/{id} or /assettypes/{id} with If-Match. */
export function planDeleteTypes(kind: "aspecttypes" | "assettypes", types: readonly TypeForDelete[]): BatchItem[] {
  return types.map((x) => ({
    key: x.id,
    label: `${x.name} (${x.id})`,
    request: x.blockedReason
      ? null
      : {
          method: "DELETE",
          path: kind === "aspecttypes" ? amPath.aspectType(x.id) : amPath.assetType(x.id),
          ifMatch: x.etag,
        },
    blockedReason: x.blockedReason,
  }));
}
