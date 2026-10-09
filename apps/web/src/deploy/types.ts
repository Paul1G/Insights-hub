// Deployment engine data model: plans, steps, runs and reports.
//
// Everything a run persists (Dexie `deployments`, DeploymentRunRecord.plan /
// .steps / .report) is described by the Zod schemas below, so a reload can
// parse it back safely. Types are inferred from the schemas (single source).

import { z } from "zod";

export const PHASES = [
  "aspectTypes",
  "assetTypes",
  "assets",
  "locations",
  "files",
  "fileAssignments",
  "deletions",
] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

export const PHASE_LABELS: Record<Phase, string> = {
  aspectTypes: "Aspect types",
  assetTypes: "Asset types",
  assets: "Assets",
  locations: "Locations",
  files: "Files",
  fileAssignments: "File assignments",
  deletions: "Sync deletions",
};

export const STEP_OPS = [
  "create",
  "update",
  "skip",
  "move",
  "delete",
  "upload",
  "assign",
  "unassign",
  "location",
] as const;
export const StepOpSchema = z.enum(STEP_OPS);
export type StepOp = z.infer<typeof StepOpSchema>;

export const PlanEntityKindSchema = z.enum(["aspectType", "assetType", "asset", "file"]);
export type PlanEntityKind = z.infer<typeof PlanEntityKindSchema>;

export const ENTITY_KIND_LABELS: Record<PlanEntityKind, string> = {
  aspectType: "Aspect type",
  assetType: "Asset type",
  asset: "Asset",
  file: "File",
};

export const ChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(["added", "removed", "changed"]),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

export const MemberUpdateSchema = z.object({
  kind: z.enum(["variable", "aspect"]),
  uid: z.string(),
  /** Name in the tenant after the request; null when the member was removed. */
  name: z.string().nullable(),
});
export type MemberUpdate = z.infer<typeof MemberUpdateSchema>;

export const UploadSpecSchema = z.object({
  fileUid: z.string(),
  blobId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  scope: z.enum(["private", "public"]),
  mimeType: z.string(),
  size: z.number(),
});
export type UploadSpec = z.infer<typeof UploadSpecSchema>;

/**
 * One request of a step. `transport` "am" goes through the proxied Asset
 * Management call; "upload" / "replace" use the multipart files endpoints.
 * Path and body strings may contain `{{asset:<uid>}}` / `{{file:<uid>}}`
 * tokens for tenant ids created earlier in the same run. A defined `ifMatch`
 * is replaced by the executor with the fresh ETag it reads before the step.
 */
export const PlannedRequestSchema = z.object({
  method: z.enum(["GET", "PUT", "POST", "PATCH", "DELETE"]),
  path: z.string(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  ifMatch: z.union([z.string(), z.number()]).optional(),
  ifNoneMatch: z.string().optional(),
  body: z.unknown().optional(),
  contentType: z.enum(["application/json", "application/merge-patch+json"]).optional(),
  transport: z.enum(["am", "upload", "replace"]).optional(),
  upload: UploadSpecSchema.optional(),
  /** Human-readable purpose shown in the request preview. */
  purpose: z.string().optional(),
  /** Mapping bookkeeping applied right after this request succeeded. */
  memberUpdates: z.array(MemberUpdateSchema).optional(),
});
export type PlannedRequest = z.infer<typeof PlannedRequestSchema>;

export const EXPECT_KINDS = ["aspectType", "assetType", "asset", "assetParent", "file", "assignments", "exists"] as const;
export const ExpectKindSchema = z.enum(EXPECT_KINDS);
export type ExpectKind = z.infer<typeof ExpectKindSchema>;

export const StepMappingSchema = z.object({
  kind: PlanEntityKindSchema,
  uid: z.string(),
  name: z.string(),
  /** Tenant id or a `{{asset:<uid>}}` / `{{file:<uid>}}` token. */
  tenantId: z.string(),
  variables: z.array(z.object({ uid: z.string(), name: z.string() })).optional(),
  aspects: z.array(z.object({ uid: z.string(), name: z.string(), aspectId: z.string().optional() })).optional(),
  sha256: z.string().optional(),
  /** Mapping keys removed after success (deleted members / entities). */
  remove: z.array(z.string()).optional(),
  /** Delete steps: remove the entity entry and all of its member entries. */
  removeEntity: z.boolean().optional(),
});
export type StepMapping = z.infer<typeof StepMappingSchema>;

export const ReconcileSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("aspectType"), id: z.string() }),
  z.object({ kind: z.literal("assetType"), id: z.string() }),
  z.object({ kind: z.literal("asset"), parentId: z.string(), name: z.string() }),
  z.object({ kind: z.literal("file"), name: z.string() }),
]);
export type Reconcile = z.infer<typeof ReconcileSchema>;

export const BlockedSchema = z.object({
  code: z.string(),
  reason: z.string(),
  hint: z.string().optional(),
});
export type Blocked = z.infer<typeof BlockedSchema>;

export const PlanStepSchema = z.object({
  id: z.string(),
  phase: PhaseSchema,
  level: z.number().int(),
  dependsOn: z.array(z.string()),
  op: StepOpSchema,
  entity: z.object({ kind: PlanEntityKindSchema, uid: z.string(), label: z.string() }),
  /** Tenant id of the entity, or "pending" when it is created in this run. */
  tenantId: z.string(),
  requests: z.array(PlannedRequestSchema),
  changes: z.array(ChangeSchema),
  reason: z.string(),
  blocked: BlockedSchema.optional(),
  destructive: z.boolean(),
  /** GET path read before the step for a fresh ETag and the drift check. */
  resourcePath: z.string().optional(),
  expectKind: ExpectKindSchema.optional(),
  /** Plan-time view of the resource (see comparable.ts) the requests were computed from. */
  expect: z.unknown().optional(),
  /** Token under which the created tenant id is registered (e.g. "asset:<uid>"). */
  createsToken: z.string().optional(),
  reconcile: ReconcileSchema.optional(),
  mapping: StepMappingSchema.optional(),
  /** Locations: whether the asset had its own (not inherited) location at plan time. */
  hadOwnLocation: z.boolean().optional(),
  /** Rollback steps: id of the original step they revert. */
  revertsStepId: z.string().optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const BlockerSchema = z.object({
  kind: z.enum(["validation", "reference", "conflict"]),
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  entity: z.object({ kind: z.string(), uid: z.string(), label: z.string() }).optional(),
  stepId: z.string().optional(),
});
export type Blocker = z.infer<typeof BlockerSchema>;

export const TargetOnlyItemSchema = z.object({
  kind: PlanEntityKindSchema,
  tenantId: z.string(),
  label: z.string(),
  detail: z.string().optional(),
});
export type TargetOnlyItem = z.infer<typeof TargetOnlyItemSchema>;

export const PlanSummarySchema = z.object({
  create: z.number(),
  update: z.number(),
  skip: z.number(),
  delete: z.number(),
  move: z.number(),
  blocked: z.number(),
});
export type PlanSummary = z.infer<typeof PlanSummarySchema>;

export const PlanModeSchema = z.enum(["deploy", "sync", "rollback"]);
export type PlanMode = z.infer<typeof PlanModeSchema>;

export const DeploymentPlanSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  createdAt: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  tenant: z.string(),
  mode: PlanModeSchema,
  steps: z.array(PlanStepSchema),
  summary: PlanSummarySchema,
  blockers: z.array(BlockerSchema),
  /** Objects in the tenant that the project does not know (never deleted). */
  targetOnly: z.array(TargetOnlyItemSchema),
  /** Deploy mode: previously deployed objects removed from the project (deleted only in sync mode). */
  removedFromProject: z.array(TargetOnlyItemSchema),
  /** Informational notes (partial tenant reads, preserved foreign members, …). */
  notes: z.array(z.string()),
  validation: z.object({ errors: z.number(), warnings: z.number() }),
  snapshotReadAt: z.string().optional(),
  /** Rollback plans: things that cannot be reverted automatically. */
  notRevertible: z.array(z.object({ stepId: z.string(), label: z.string(), reason: z.string() })).optional(),
});
export type DeploymentPlan = z.infer<typeof DeploymentPlanSchema>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const STEP_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "conflict",
  "skipped",
  "skipped-dependency",
  "rolled-back",
] as const;
export const StepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const StepRunSchema = z.object({
  stepId: z.string(),
  status: StepStatusSchema,
  attempts: z.number().int(),
  httpStatus: z.number().int().optional(),
  durationMs: z.number().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  errors: z.array(z.string()),
  /** Tenant ids created by this step (used for rollback). */
  createdIds: z.array(z.string()),
  /** The resource as read right before the first modifying request. */
  preImage: z.unknown().optional(),
  /** Drift between plan time and execution (412 or pre-check). */
  conflict: z.array(ChangeSchema).optional(),
  /** Requests already applied (multi-request steps resume after the last one). */
  completedRequests: z.number().int(),
  /** Retry with the fresh ETag even though the resource drifted. */
  acceptDrift: z.boolean().optional(),
  note: z.string().optional(),
});
export type StepRun = z.infer<typeof StepRunSchema>;

export const RunModeSchema = z.enum(["deploy", "sync", "rollback", "copy"]);
export type RunMode = z.infer<typeof RunModeSchema>;

export const RunStatusSchema = z.enum([
  "planned",
  "running",
  "paused",
  "completed",
  "completed-with-errors",
  "failed",
  "rolled-back",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StepsStateSchema = z.object({
  version: z.literal(1),
  items: z.array(StepRunSchema),
  /** Token → tenant id for objects created in this run. */
  ids: z.record(z.string(), z.string()),
  concurrency: z.number().int(),
  skipBlocked: z.boolean(),
  rollbackOf: z.string().optional(),
  rolledBackBy: z.string().optional(),
  warnings: z.array(z.string()),
  baselinesApplied: z.boolean().optional(),
});
export type StepsState = z.infer<typeof StepsStateSchema>;

export const StepReportSchema = z.object({
  stepId: z.string(),
  phase: PhaseSchema,
  op: StepOpSchema,
  entity: z.string(),
  status: StepStatusSchema,
  attempts: z.number(),
  httpStatus: z.number().optional(),
  durationMs: z.number().optional(),
  errors: z.array(z.string()),
});

export const RunReportSchema = z.object({
  runId: z.string(),
  mode: RunModeSchema,
  status: RunStatusSchema,
  projectName: z.string(),
  connectionName: z.string(),
  tenant: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number(),
  plan: PlanSummarySchema,
  byStatus: z.record(z.string(), z.number()),
  byPhase: z.array(
    z.object({ phase: PhaseSchema, total: z.number(), succeeded: z.number(), failed: z.number(), durationMs: z.number() }),
  ),
  steps: z.array(StepReportSchema),
  warnings: z.array(z.string()),
  notRevertible: z.array(z.object({ stepId: z.string(), label: z.string(), reason: z.string() })),
});
export type RunReport = z.infer<typeof RunReportSchema>;

/** In-memory form of a run (DeploymentRunRecord with parsed plan/steps). */
export interface DeploymentRun {
  id: string;
  projectId: string;
  connectionId: string;
  connectionName: string;
  tenant: string;
  mode: RunMode;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  plan: DeploymentPlan;
  state: StepsState;
  report?: RunReport;
}

export const TERMINAL_STEP_STATUSES: ReadonlySet<StepStatus> = new Set([
  "succeeded",
  "failed",
  "conflict",
  "skipped",
  "skipped-dependency",
  "rolled-back",
]);

/** Steps that count as "done" for their dependents. */
export const SATISFIED_STEP_STATUSES: ReadonlySet<StepStatus> = new Set(["succeeded", "skipped"]);
