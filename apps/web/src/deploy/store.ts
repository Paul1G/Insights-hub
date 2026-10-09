// Dexie persistence for deployment runs and mappings.

import { db, type DeploymentRunRecord, type MappingRecord } from "@/storage/db";
import { mappingId } from "./mapping";
import type { RunPersistence } from "./executor";
import { DeploymentPlanSchema, RunReportSchema, StepsStateSchema, type DeploymentRun } from "./types";

export function toRecord(run: DeploymentRun): DeploymentRunRecord {
  return {
    id: run.id,
    projectId: run.projectId,
    connectionId: run.connectionId,
    connectionName: run.connectionName,
    tenant: run.tenant,
    mode: run.mode,
    status: run.status,
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    plan: run.plan,
    steps: run.state,
    ...(run.report ? { report: run.report } : {}),
  };
}

export class RunRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRecordError";
  }
}

export function fromRecord(rec: DeploymentRunRecord): DeploymentRun {
  const plan = DeploymentPlanSchema.safeParse(rec.plan);
  const state = StepsStateSchema.safeParse(rec.steps);
  if (!plan.success || !state.success) throw new RunRecordError(`Deployment run ${rec.id} could not be read (unexpected format).`);
  const report = rec.report === undefined ? undefined : RunReportSchema.safeParse(rec.report);
  return {
    id: rec.id,
    projectId: rec.projectId,
    connectionId: rec.connectionId,
    connectionName: rec.connectionName,
    tenant: rec.tenant,
    mode: rec.mode,
    status: rec.status,
    createdAt: rec.createdAt,
    ...(rec.startedAt ? { startedAt: rec.startedAt } : {}),
    ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
    plan: plan.data,
    state: state.data,
    ...(report?.success ? { report: report.data } : {}),
  };
}

/** Lightweight listing (no plan parsing) for history tables. */
export interface RunSummary {
  id: string;
  projectId: string;
  connectionId: string;
  connectionName: string;
  tenant: string;
  mode: DeploymentRunRecord["mode"];
  status: DeploymentRunRecord["status"];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: DeploymentRun["plan"]["summary"];
  rollbackOf?: string;
}

export function summaryOf(rec: DeploymentRunRecord): RunSummary {
  const plan = rec.plan as { summary?: RunSummary["summary"] } | undefined;
  const steps = rec.steps as { rollbackOf?: string } | undefined;
  return {
    id: rec.id,
    projectId: rec.projectId,
    connectionId: rec.connectionId,
    connectionName: rec.connectionName,
    tenant: rec.tenant,
    mode: rec.mode,
    status: rec.status,
    createdAt: rec.createdAt,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    summary: plan?.summary,
    rollbackOf: steps?.rollbackOf,
  };
}

export async function listRunRecords(projectId: string): Promise<DeploymentRunRecord[]> {
  const list = await db.deployments.where("projectId").equals(projectId).toArray();
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadRun(id: string): Promise<DeploymentRun | undefined> {
  const rec = await db.deployments.get(id);
  return rec ? fromRecord(rec) : undefined;
}

export async function saveRun(run: DeploymentRun): Promise<void> {
  await db.deployments.put(toRecord(run));
}

export async function loadMapping(projectId: string, connectionId: string): Promise<MappingRecord | undefined> {
  return db.mappings.get(mappingId(projectId, connectionId));
}

export async function saveMapping(mapping: MappingRecord): Promise<void> {
  await db.mappings.put(structuredClone(mapping));
}

export const dexiePersistence: RunPersistence = {
  saveRun,
  saveMapping,
};

/** Keeps runs and mappings in memory (cross-tenant copy before "Save as project"). */
export class MemoryPersistence implements RunPersistence {
  readonly runs = new Map<string, DeploymentRunRecord>();
  mapping: MappingRecord | undefined;
  async saveRun(run: DeploymentRun): Promise<void> {
    this.runs.set(run.id, structuredClone(toRecord(run)));
  }
  async saveMapping(mapping: MappingRecord): Promise<void> {
    this.mapping = structuredClone(mapping);
  }
}
