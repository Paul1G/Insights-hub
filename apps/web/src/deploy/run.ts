// Run orchestration around the executor: automatic snapshot before the run,
// audit entries (counts only), baselines + changelog afterwards, rollback.

import type { AuditAppend } from "@/api/client";
import type { MappingRecord } from "@/storage/db";
import { executeRun, createRun, type ExecuteOptions, type ExecutorDeps } from "./executor";
import { markRolledBack, planRollback } from "./rollback";
import type { DeploymentRun } from "./types";

export interface RunServices extends ExecutorDeps {
  /** App-level audit entry (api.audit.append); failures are recorded as warnings. */
  audit?: (entry: AuditAppend) => Promise<unknown>;
  /** Take an automatic project snapshot before the first execution. */
  snapshot?: (label: string) => Promise<void>;
  /** Apply baselines + changelog to the project after the run. */
  applyBaselines?: (run: DeploymentRun) => Promise<void>;
}

function counts(run: DeploymentRun): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of run.state.items) out[i.status] = (out[i.status] ?? 0) + 1;
  return out;
}

async function audit(run: DeploymentRun, services: RunServices, action: string, summary: string, details: Record<string, unknown>) {
  if (!services.audit) return;
  try {
    await services.audit({ connectionId: run.connectionId, action, summary, details: { runId: run.id, mode: run.mode, ...details } });
  } catch (e) {
    run.state.warnings.push(`Audit entry "${action}" could not be written: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Execute (or resume) a run with snapshot, audit and baselines around it. */
export async function startRun(
  run: DeploymentRun,
  mapping: MappingRecord,
  services: RunServices,
  opts: ExecuteOptions = {},
): Promise<DeploymentRun> {
  const firstStart = !run.startedAt;
  if (firstStart && run.mode !== "rollback" && services.snapshot) {
    try {
      await services.snapshot(`Before deploying to ${run.connectionName}`);
    } catch (e) {
      run.state.warnings.push(`The automatic snapshot could not be taken: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const action = run.mode === "rollback" ? "rollback" : "deployment";
  await audit(run, services, `${action}.${firstStart ? "start" : "resume"}`, `${firstStart ? "Started" : "Resumed"} ${action} to ${run.connectionName}`, {
    plan: run.plan.summary,
    steps: run.plan.steps.length,
  });
  await executeRun(run, mapping, services, opts);
  const finished = run.status === "completed" || run.status === "completed-with-errors" || run.status === "failed";
  if (finished && run.mode !== "rollback" && services.applyBaselines && !run.state.baselinesApplied) {
    try {
      await services.applyBaselines(run);
      run.state.baselinesApplied = true;
    } catch (e) {
      run.state.warnings.push(`Baselines could not be applied to the project: ${e instanceof Error ? e.message : String(e)}`);
    }
    await services.persistence.saveRun(run);
  }
  await audit(run, services, `${action}.${run.status === "paused" ? "pause" : "finish"}`, `${action} to ${run.connectionName}: ${run.status}`, {
    status: run.status,
    counts: counts(run),
  });
  return run;
}

/** Plan and execute a best-effort rollback of `original`. */
export async function rollbackRun(
  original: DeploymentRun,
  mapping: MappingRecord,
  services: RunServices,
  opts: ExecuteOptions = {},
): Promise<DeploymentRun> {
  const plan = planRollback(original);
  const rollback = createRun({
    plan,
    projectId: original.projectId,
    connectionId: original.connectionId,
    connectionName: original.connectionName,
    mode: "rollback",
    concurrency: original.state.concurrency,
    rollbackOf: original.id,
  });
  await services.persistence.saveRun(rollback);
  await startRun(rollback, mapping, services, opts);
  markRolledBack(original, rollback);
  await services.persistence.saveRun(original);
  return rollback;
}
