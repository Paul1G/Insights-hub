// After a run: record baselines on the entities that now exist in the target,
// so the validator enforces the platform's immutability rules from then on.

import type { Project } from "@/domain/model";
import type { DeploymentRun } from "./types";

const MAIN_PHASES = new Set(["aspectTypes", "assetTypes", "assets"]);

/** Edits `draft` in place; returns the number of entities whose baseline was set. */
export function applyRunBaselines(draft: Project, run: DeploymentRun): number {
  const items = new Map(run.state.items.map((i) => [i.stepId, i]));
  const done = new Set<string>();
  for (const s of run.plan.steps) {
    if (!MAIN_PHASES.has(s.phase) || s.blocked) continue;
    if (s.op !== "create" && s.op !== "update" && s.op !== "skip") continue;
    const status = items.get(s.id)?.status;
    if (status !== "succeeded" && status !== "skipped") continue;
    done.add(`${s.entity.kind}:${s.entity.uid}`);
  }
  let count = 0;
  for (const t of draft.aspectTypes) {
    if (!done.has(`aspectType:${t.uid}`)) continue;
    t.baseline = { idSuffix: t.idSuffix, name: t.name, category: t.category };
    for (const v of t.variables) v.baseline = { dataType: v.dataType, searchable: v.searchable, ...(v.length !== undefined ? { length: v.length } : {}) };
    count++;
  }
  for (const t of draft.assetTypes) {
    if (!done.has(`assetType:${t.uid}`)) continue;
    t.baseline = { idSuffix: t.idSuffix, instantiable: t.instantiable };
    for (const v of t.variables) v.baseline = { dataType: v.dataType, searchable: v.searchable, ...(v.length !== undefined ? { length: v.length } : {}) };
    count++;
  }
  for (const a of draft.assets) {
    if (!done.has(`asset:${a.uid}`)) continue;
    a.baseline = { twinType: a.twinType, ...(a.timezone !== undefined ? { timezone: a.timezone } : {}) };
    count++;
  }
  return count;
}

export function runChangelogSummary(run: DeploymentRun): string {
  const items = run.state.items;
  const ok = items.filter((i) => i.status === "succeeded").length;
  const failed = items.filter((i) => i.status === "failed" || i.status === "conflict").length;
  const verb = run.mode === "sync" ? "Synchronised with" : run.mode === "copy" ? "Copied to" : "Deployed to";
  return `${verb} ${run.connectionName} (${run.tenant}): ${ok} change(s) applied${failed ? `, ${failed} failed` : ""}`;
}
