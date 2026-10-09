// Test builders and a deploy helper running the real engine against FakeAm.

import { BUILTIN_CORE_LIBRARY } from "@/domain/coreLibrary";
import {
  ROOT_ASSET_UID,
  createEmptyProject,
  type AspectTypeDef,
  type AssetDef,
  type AssetTypeDef,
  type FileDef,
  type Project,
  type VariableDef,
} from "@/domain/model";
import { ModelIndex } from "@/domain/resolve";
import type { MappingRecord } from "@/storage/db";
import { readTenant } from "@/tenant/read";
import { createRun, executeRun, type ExecuteOptions } from "../executor";
import { emptyMapping } from "../mapping";
import { planDeployment, resolveReferences } from "../planner";
import { MemoryPersistence } from "../store";
import type { DeploymentPlan, DeploymentRun } from "../types";
import type { FakeAm } from "./fakeAm";

let seq = 0;
export const uid = (p: string) => `${p}-${++seq}`;

export function v(name: string, over: Partial<VariableDef> = {}): VariableDef {
  return { uid: uid("v"), name, dataType: "DOUBLE", searchable: false, ...over };
}

export function aspectType(name: string, over: Partial<AspectTypeDef> = {}): AspectTypeDef {
  return { uid: uid("apt"), idSuffix: name, name, category: "dynamic", variables: [v("value")], ...over };
}

export function assetType(name: string, over: Partial<AssetTypeDef> = {}): AssetTypeDef {
  return {
    uid: uid("at"),
    idSuffix: name,
    name,
    parent: { kind: "core", id: "core.basicasset" },
    instantiable: true,
    variables: [],
    aspects: [],
    fileAssignments: [],
    ...over,
  };
}

export function asset(name: string, type: AssetTypeDef | string, parentUid: string = ROOT_ASSET_UID, over: Partial<AssetDef> = {}): AssetDef {
  return {
    uid: uid("a"),
    name,
    type: typeof type === "string" ? { kind: "core", id: type } : { kind: "project", uid: type.uid },
    parentUid,
    twinType: "performance",
    variables: [],
    aspects: [],
    fileAssignments: [],
    ...over,
  };
}

export function file(name: string, blobId: string, sha256: string, over: Partial<FileDef> = {}): FileDef {
  return { uid: uid("f"), name, scope: "private", mimeType: "text/plain", size: 5, sha256, blobId, ...over };
}

export function project(parts: Partial<Pick<Project, "aspectTypes" | "assetTypes" | "assets" | "files">> = {}): Project {
  const p = createEmptyProject("Test project");
  p.aspectTypes = parts.aspectTypes ?? [];
  p.assetTypes = parts.assetTypes ?? [];
  p.assets = [...p.assets, ...(parts.assets ?? [])];
  p.files = parts.files ?? [];
  return p;
}

export const indexOf = (p: Project) => new ModelIndex(p, BUILTIN_CORE_LIBRARY);

export const blobs = new Map<string, Blob>();

export async function analyze(p: Project, fake: FakeAm, mapping?: MappingRecord, mode: "deploy" | "sync" = "deploy"): Promise<DeploymentPlan> {
  const snapshot = await readTenant(fake, { tenant: fake.tenant });
  const references = await resolveReferences(p, snapshot, fake);
  return planDeployment(p, indexOf(p), { tenant: fake.tenant, snapshot, mapping, references }, { mode });
}

export interface DeployResult {
  plan: DeploymentPlan;
  run: DeploymentRun;
  mapping: MappingRecord;
  persistence: MemoryPersistence;
}

export async function execute(
  plan: DeploymentPlan,
  fake: FakeAm,
  mapping: MappingRecord = emptyMapping(plan.projectId, "conn-1", fake.tenant),
  opts: ExecuteOptions & { skipBlocked?: boolean } = {},
): Promise<DeployResult> {
  const persistence = new MemoryPersistence();
  const run = createRun({
    plan,
    projectId: plan.projectId,
    connectionId: "conn-1",
    connectionName: "Fake tenant",
    mode: plan.mode === "sync" ? "sync" : "deploy",
    concurrency: opts.concurrency,
    skipBlocked: opts.skipBlocked,
  });
  await executeRun(run, mapping, { transport: fake, persistence, loadBlob: async (id) => blobs.get(id) }, opts);
  return { plan, run, mapping, persistence };
}

export async function deploy(p: Project, fake: FakeAm, mapping?: MappingRecord, opts: ExecuteOptions = {}): Promise<DeployResult> {
  const plan = await analyze(p, fake, mapping);
  return execute(plan, fake, mapping ?? emptyMapping(p.id, "conn-1", fake.tenant), opts);
}

export function statusOf(run: DeploymentRun, stepId: string) {
  return run.state.items.find((i) => i.stepId === stepId)?.status;
}

export function stepOf(plan: DeploymentPlan, stepId: string) {
  const s = plan.steps.find((x) => x.id === stepId);
  if (!s) throw new Error(`No step ${stepId}; steps: ${plan.steps.map((x) => x.id).join(", ")}`);
  return s;
}
