// Best-effort rollback of a run.
//
// Reverts, in reverse dependency order:
//   - file assignments changed on pre-existing entities (restored from the
//     pre-image),
//   - asset value updates (PATCH from the pre-image), moves (moved back) and
//     location changes,
//   - created assets (deepest first), asset types (children first), aspect
//     types and uploaded files (DELETE with a fresh ETag).
// Changes that cannot be reverted are listed in plan.notRevertible: type
// definition updates (variable renames / additions / deletions that were
// applied), replaced file contents and deleted objects.

import type { AmAssetResource, AmFileAssignment } from "@/api/amTypes";
import { newUid } from "@/domain/model";
import { blankToUndefined, normalizeLocation, ownAssignments, sortedAspects } from "./comparable";
import { summarize } from "./planner";
import { seg } from "./transport";
import type { DeploymentPlan, DeploymentRun, PlanStep, PlannedRequest } from "./types";

const JSON_TYPE = "application/json" as const;
const MERGE_PATCH = "application/merge-patch+json" as const;

const collectionOf = (kind: PlanStep["entity"]["kind"]): string =>
  kind === "aspectType" ? "aspecttypes" : kind === "assetType" ? "assettypes" : kind === "asset" ? "assets" : "files";

export function planRollback(run: DeploymentRun, opts: { now?: () => string } = {}): DeploymentPlan {
  const items = new Map(run.state.items.map((i) => [i.stepId, i]));
  const original = run.plan.steps;
  const out: PlanStep[] = [];
  const notRevertible: { stepId: string; label: string; reason: string }[] = [];
  const created = new Map<string, string>(); // original step id → created tenant id

  for (const s of original) {
    const item = items.get(s.id);
    if (!item) continue;
    const applied = item.status === "succeeded" || item.completedRequests > 0;
    if (!applied) continue;
    if ((s.op === "create" || s.op === "upload") && item.createdIds[0]) created.set(s.id, item.createdIds[0]);
  }
  const maxAssetLevel = Math.max(0, ...original.filter((s) => s.phase === "assets").map((s) => s.level));
  const maxTypeLevel = Math.max(0, ...original.filter((s) => s.phase === "assetTypes").map((s) => s.level));
  const typeBase = maxAssetLevel + 1;
  const aspectLevel = typeBase + maxTypeLevel + 1;
  const fileLevel = aspectLevel + 1;

  for (const s of original) {
    const item = items.get(s.id);
    if (!item) continue;
    const fullyApplied = item.status === "succeeded";
    const partiallyApplied = !fullyApplied && item.completedRequests > 0;
    if (!fullyApplied && !partiallyApplied) continue;
    const label = s.entity.label;
    const pre = item.preImage as (AmAssetResource & { fileAssignments?: AmFileAssignment[] }) | undefined;

    if (s.op === "create" || s.op === "upload") {
      const id = created.get(s.id);
      if (!id) continue;
      const path = `/${collectionOf(s.entity.kind)}/${seg(id)}`;
      const level =
        s.entity.kind === "asset"
          ? maxAssetLevel - s.level
          : s.entity.kind === "assetType"
            ? typeBase + (maxTypeLevel - s.level)
            : s.entity.kind === "aspectType"
              ? aspectLevel
              : fileLevel;
      out.push({
        id: `rollback:delete:${s.id}`,
        phase: "deletions",
        level,
        dependsOn: [],
        op: "delete",
        entity: s.entity,
        tenantId: id,
        requests: [{ method: "DELETE", path, ifMatch: 0, purpose: "Delete the object created by the run" }],
        changes: [{ path: "", kind: "removed", before: label }],
        reason: "Created by the run.",
        destructive: true,
        resourcePath: path,
        mapping: { kind: s.entity.kind, uid: s.entity.uid, name: label, tenantId: id, removeEntity: true },
        revertsStepId: s.id,
      });
      continue;
    }

    if (s.op === "update" && s.entity.kind === "asset" && pre) {
      const body: Record<string, unknown> = {
        name: pre.name,
        externalId: blankToUndefined(pre.externalId) ?? null,
        description: blankToUndefined(pre.description) ?? null,
        variables: (pre.variables ?? []).map((v) => ({ name: v.name, value: v.value })),
        aspects: sortedAspects(pre.aspects),
      };
      out.push(revertStep(s, "assets", s.level, "update", [
        { method: "PATCH", path: `/assets/${seg(s.tenantId)}`, ifMatch: 0, contentType: MERGE_PATCH, body, purpose: "Restore the asset's previous values" },
      ], "Restore the values before the run."));
      continue;
    }

    if (s.op === "move" && pre?.parentId) {
      out.push(revertStep(s, "assets", s.level, "move", [
        { method: "POST", path: `/assets/${seg(s.tenantId)}/move`, ifMatch: 0, contentType: JSON_TYPE, body: { newParentId: pre.parentId }, purpose: "Move the asset back" },
      ], "Move back to the previous parent."));
      continue;
    }

    if (s.op === "location" && pre) {
      const loc = normalizeLocation(pre.location);
      const req: PlannedRequest =
        s.hadOwnLocation && loc
          ? { method: "PUT", path: `/assets/${seg(s.tenantId)}/location`, ifMatch: 0, contentType: JSON_TYPE, body: loc, purpose: "Restore the previous location" }
          : { method: "DELETE", path: `/assets/${seg(s.tenantId)}/location`, ifMatch: 0, purpose: "Remove the location set by the run (inherits again)" };
      out.push(revertStep(s, "locations", s.level, "location", [req], "Restore the location before the run."));
      continue;
    }

    if ((s.op === "assign" || s.op === "unassign") && s.tenantId !== "pending" && pre) {
      const before = new Map(ownAssignments(pre.fileAssignments).map((a) => [a.key.toLowerCase(), a]));
      const base = s.entity.kind === "assetType" ? `/assettypes/${seg(s.tenantId)}` : `/assets/${seg(s.tenantId)}`;
      const requests: PlannedRequest[] = [];
      const done = s.requests.slice(0, fullyApplied ? s.requests.length : item.completedRequests);
      for (const r of done) {
        const key = decodeURIComponent(r.path.split("/fileAssignments/")[1] ?? "");
        if (!key) continue;
        const prev = before.get(key.toLowerCase());
        requests.push(
          prev
            ? { method: "PUT", path: `${base}/fileAssignments/${seg(key)}`, ifMatch: 0, contentType: JSON_TYPE, body: { fileId: prev.fileId }, purpose: `Restore assignment "${key}"` }
            : { method: "DELETE", path: `${base}/fileAssignments/${seg(key)}`, ifMatch: 0, purpose: `Remove assignment "${key}"` },
        );
      }
      if (requests.length) out.push(revertStep(s, "fileAssignments", 0, requests.some((r) => r.method === "PUT") ? "assign" : "unassign", requests, "Restore the file assignments before the run."));
      continue;
    }

    if (s.op === "update" && (s.entity.kind === "aspectType" || s.entity.kind === "assetType")) {
      notRevertible.push({
        stepId: s.id,
        label,
        reason: partiallyApplied
          ? `Partially applied (${item.completedRequests} of ${s.requests.length} requests); type definition changes such as variable renames, additions and deletions are not reverted automatically.`
          : "Type definition changes (variable renames, additions, deletions, aspects) are not reverted automatically.",
      });
      continue;
    }
    if (s.op === "update" && s.entity.kind === "file") {
      notRevertible.push({ stepId: s.id, label, reason: "The previous file content is not retained and cannot be restored." });
      continue;
    }
    if (s.op === "delete") {
      notRevertible.push({ stepId: s.id, label, reason: "Deleted objects cannot be restored." });
    }
  }

  // Dependencies: delete children / instances / assigned files after their dependents are gone.
  const byRevert = new Map(out.map((s) => [s.revertsStepId!, s]));
  for (const s of original) {
    const mine = byRevert.get(s.id);
    if (!mine) continue;
    for (const d of s.dependsOn) {
      const depRevert = byRevert.get(d);
      // The original step `s` depended on `d`; the revert of `d` must wait for the revert of `s`.
      if (depRevert && depRevert.id !== mine.id) depRevert.dependsOn.push(mine.id);
    }
  }
  for (const s of out) s.dependsOn = [...new Set(s.dependsOn)];

  return {
    version: 1,
    id: newUid(),
    createdAt: opts.now?.() ?? new Date().toISOString(),
    projectId: run.projectId,
    projectName: run.plan.projectName,
    tenant: run.tenant,
    mode: "rollback",
    steps: out,
    summary: summarize(out),
    blockers: [],
    targetOnly: [],
    removedFromProject: [],
    notes: [],
    validation: { errors: 0, warnings: 0 },
    notRevertible,
  };
}

function revertStep(
  s: PlanStep,
  phase: PlanStep["phase"],
  level: number,
  op: PlanStep["op"],
  requests: PlannedRequest[],
  reason: string,
): PlanStep {
  return {
    id: `rollback:${s.id}`,
    phase,
    level,
    dependsOn: [],
    op,
    entity: s.entity,
    tenantId: s.tenantId,
    requests,
    changes: [],
    reason,
    destructive: false,
    resourcePath: s.entity.kind === "assetType" ? `/assettypes/${seg(s.tenantId)}` : `/assets/${seg(s.tenantId)}`,
    revertsStepId: s.id,
  };
}

/** After a rollback run: mark the reverted steps of the original run. */
export function markRolledBack(original: DeploymentRun, rollback: DeploymentRun): void {
  const revertedOk = new Set(
    rollback.plan.steps
      .filter((s) => rollback.state.items.find((i) => i.stepId === s.id)?.status === "succeeded")
      .map((s) => s.revertsStepId!),
  );
  for (const item of original.state.items) if (revertedOk.has(item.stepId)) item.status = "rolled-back";
  original.state.rolledBackBy = rollback.id;
  if (rollback.status === "completed") original.status = "rolled-back";
}
