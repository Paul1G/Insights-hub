// Deployment planner: project + tenant snapshot (+ mapping) → DeploymentPlan.
//
// Pure and deterministic for a given input. Phases (docs/ARCHITECTURE.md):
// aspect types → asset types (parents first) → assets (by hierarchy level) →
// locations → files → file assignments → sync deletions (reverse order).
//
// Update rules follow docs/reference/assetmanagement-v3.yaml and the
// modelling guidelines:
//   - aspect type variables are added / updated / renamed / deleted via
//     PATCH /aspecttypes/{id}/variables (merge-patch map, null deletes);
//     the description via PATCH /aspecttypes/{id};
//   - asset type variable name/unit/length/defaultValue via
//     PATCH /assettypes/{id}/variables (no name interchange per request);
//     adding/removing variables and aspects, name, description and
//     instantiable via PATCH /assettypes/{id} with complete arrays;
//   - asset values via PATCH /assets/{id}; parent changes via
//     POST /assets/{id}/move; locations via PUT/DELETE /assets/{id}/location;
//   - immutable fields (dataType, searchable, qualityCode, string length
//     decrease, dynamic string length, category, aspect type name, parent
//     type, instantiable true→false, asset type / timezone / twin type) block
//     the step with the documented reason.

import type {
  AmAspect,
  AmAspectTypeResource,
  AmAssetResource,
  AmAssetTypeResource,
  AmFileAssignment,
  AmFileMetadata,
  AmVariable,
  AmVariableDefinition,
} from "@/api/amTypes";
import type { Change } from "@/domain/diff";
import { diffValues } from "@/domain/diff";
import {
  ROOT_ASSET_UID,
  composeTypeId,
  newUid,
  type AspectCategory,
  type AspectTypeDef,
  type AssetDef,
  type AssetTypeDef,
  type Project,
  type TypeRef,
  type VariableDef,
} from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";
import { DEFAULT_GUARDRAILS, supportsLength, type GuardrailSettings } from "@/domain/rules";
import { validateProject, type ValidationResult } from "@/domain/validator";
import type { MappingRecord } from "@/storage/db";
import {
  assetCreateBody,
  assetTypeBody,
  aspectTypeBody,
  locationBody,
  mergedAspects,
  mergedValues,
  patchField,
  resolveTypeId,
  staticAspectValues,
  variableBody,
  type TypeIdContext,
} from "@/tenant/convert";
import { allTypes, classifyTypeId, type TenantSnapshot } from "@/tenant/read";
import {
  blankToUndefined,
  comparableAspectType,
  comparableAsset,
  comparableAssetType,
  comparableFile,
  comparableVariable,
  effectiveLength,
  isOwn,
  lc,
  normalizeLocation,
  ownAssignments,
  sameJson,
  sortedAspects,
  sortedValues,
} from "./comparable";
import { MappingView, memberKey } from "./mapping";
import { RenamePlanError, batchBody, splitVariableChanges, type VariableChange } from "./renames";
import { seg, type Transport } from "./transport";
import {
  PHASES,
  type Blocked,
  type Blocker,
  type DeploymentPlan,
  type PlanEntityKind,
  type PlanStep,
  type PlanSummary,
  type PlannedRequest,
  type TargetOnlyItem,
  type UploadSpec,
} from "./types";

export interface ReferenceLookup {
  /** lower-case id → resource, or null when the GET returned 404. */
  assetTypes: Record<string, AmAssetTypeResource | null>;
  aspectTypes: Record<string, AmAspectTypeResource | null>;
}

export interface PlanTarget {
  tenant: string;
  snapshot: TenantSnapshot;
  mapping?: MappingRecord;
  references?: ReferenceLookup;
}

export interface PlanOptions {
  mode: "deploy" | "sync";
  guardrails?: GuardrailSettings;
  /** Precomputed validation (defaults to validateProject(index, guardrails)). */
  validation?: ValidationResult;
  now?: () => string;
  id?: string;
}

const MERGE_PATCH = "application/merge-patch+json" as const;
const JSON_TYPE = "application/json" as const;
/** Upper bound of target-only objects kept in a plan (plans are persisted per run). */
const MAX_LISTED = 10000;
const RECREATE_HINT = "Delete and recreate it in the project (existing values are lost), or revert the change.";

interface Conflict {
  code: string;
  reason: string;
  hint?: string;
}

function blockedOf(conflicts: Conflict[]): Blocked | undefined {
  if (conflicts.length === 0) return undefined;
  return {
    code: conflicts[0]!.code,
    reason: conflicts.map((c) => c.reason).join(" "),
    hint: conflicts.find((c) => c.hint)?.hint,
  };
}

function withoutName(v: AmVariableDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = { ...v };
  delete out.name;
  return out;
}

function prefixChanges(prefix: string, changes: Change[]): Change[] {
  return changes.map((c) => ({ ...c, path: c.path ? `${prefix}.${c.path}` : prefix }));
}

/** Variable definition as sent in complete arrays (nulls stripped, links dropped). */
function cleanVariable(v: AmVariableDefinition): AmVariableDefinition {
  const out: AmVariableDefinition = { name: v.name, dataType: v.dataType, searchable: !!v.searchable };
  if (blankToUndefined(v.unit) !== undefined) out.unit = v.unit;
  if (v.length !== null && v.length !== undefined) out.length = v.length;
  if (blankToUndefined(v.defaultValue) !== undefined) out.defaultValue = v.defaultValue;
  return out;
}

function variableConflicts(
  v: VariableDef,
  x: AmVariableDefinition,
  owner: "aspectType" | "assetType",
  category?: AspectCategory,
): Conflict[] {
  const out: Conflict[] = [];
  const label = `Variable "${v.name}"`;
  if (x.dataType !== v.dataType) {
    out.push({ code: "VAR_DATATYPE_IMMUTABLE", reason: `${label}: dataType cannot be changed after creation (target ${x.dataType}, project ${v.dataType}).`, hint: RECREATE_HINT });
    return out;
  }
  if (!!x.searchable !== v.searchable) {
    out.push({ code: "VAR_SEARCHABLE_IMMUTABLE", reason: `${label}: searchable cannot be changed after creation (target ${String(!!x.searchable)}).`, hint: RECREATE_HINT });
  }
  if (owner === "aspectType" && !!x.qualityCode !== !!v.qualityCode) {
    out.push({ code: "VAR_QUALITY_CODE_IMMUTABLE", reason: `${label}: qualityCode cannot be changed after creation (target ${String(!!x.qualityCode)}).`, hint: RECREATE_HINT });
  }
  if (supportsLength(v.dataType)) {
    const pl = effectiveLength(v.dataType, v.length);
    const tl = effectiveLength(x.dataType, x.length);
    if (owner === "aspectType" && category === "dynamic" && pl !== tl) {
      out.push({ code: "VAR_LENGTH_DYNAMIC_IMMUTABLE", reason: `${label}: the length of a dynamic string variable cannot be changed (target ${tl ?? "default"}).`, hint: RECREATE_HINT });
    } else if (tl !== undefined && (pl ?? 0) < tl) {
      out.push({ code: "VAR_LENGTH_DECREASE", reason: `${label}: the length can only be increased (target ${tl}, project ${pl ?? "default"}).`, hint: RECREATE_HINT });
    }
  }
  return out;
}

/** Field updates (unit, length, defaultValue) for a matched variable. */
function variableFieldUpdates(
  v: VariableDef,
  x: AmVariableDefinition,
  owner: "aspectType" | "assetType",
  category?: AspectCategory,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const unit = patchField(v.unit, x.unit);
  if (unit !== undefined) fields.unit = unit;
  if (supportsLength(v.dataType) && x.dataType === v.dataType && !(owner === "aspectType" && category === "dynamic")) {
    const pl = effectiveLength(v.dataType, v.length);
    const tl = effectiveLength(x.dataType, x.length);
    if (pl !== undefined && (tl === undefined || pl > tl)) fields.length = pl;
  }
  const isStatic = owner === "assetType" || category === "static";
  if (isStatic) {
    const dv = patchField(v.defaultValue, x.defaultValue);
    if (dv !== undefined) fields.defaultValue = dv;
  }
  return fields;
}

/** Pair project variables with target variables: mapping (deployed name) first, then by name. */
function pairVariables(
  vars: VariableDef[],
  targetVars: AmVariableDefinition[],
  deployedName: (uid: string) => string | undefined,
): { pairs: Map<string, AmVariableDefinition>; unclaimed: AmVariableDefinition[] } {
  const byName = new Map(targetVars.map((v) => [lc(v.name), v]));
  const claimed = new Set<string>();
  const pairs = new Map<string, AmVariableDefinition>();
  for (const v of vars) {
    const name = deployedName(v.uid);
    const x = name ? byName.get(lc(name)) : undefined;
    if (x && !claimed.has(lc(x.name))) {
      pairs.set(v.uid, x);
      claimed.add(lc(x.name));
    }
  }
  for (const v of vars) {
    if (pairs.has(v.uid)) continue;
    const x = byName.get(lc(v.name));
    if (x && !claimed.has(lc(x.name))) {
      pairs.set(v.uid, x);
      claimed.add(lc(x.name));
    }
  }
  return { pairs, unclaimed: targetVars.filter((x) => !claimed.has(lc(x.name))) };
}

class TargetIndex {
  readonly aspectTypes = new Map<string, AmAspectTypeResource>();
  readonly assetTypes = new Map<string, AmAssetTypeResource>();
  readonly tenantAspectTypeByName = new Map<string, AmAspectTypeResource>();
  readonly assets = new Map<string, AmAssetResource>();
  readonly files = new Map<string, AmFileMetadata>();
  readonly filesByName = new Map<string, AmFileMetadata[]>();
  readonly root: AmAssetResource;
  private readonly children = new Map<string, AmAssetResource[]>();
  private readonly depths = new Map<string, number>();

  constructor(snapshot: TenantSnapshot, refs?: ReferenceLookup) {
    this.root = snapshot.root;
    for (const t of allTypes(snapshot.aspectTypes)) this.aspectTypes.set(lc(t.id), t);
    for (const t of allTypes(snapshot.assetTypes)) this.assetTypes.set(lc(t.id), t);
    for (const t of snapshot.aspectTypes.tenant) this.tenantAspectTypeByName.set(lc(t.name), t);
    for (const [id, t] of Object.entries(refs?.aspectTypes ?? {})) if (t && !this.aspectTypes.has(id)) this.aspectTypes.set(id, t);
    for (const [id, t] of Object.entries(refs?.assetTypes ?? {})) if (t && !this.assetTypes.has(id)) this.assetTypes.set(id, t);
    this.assets.set(snapshot.root.assetId, snapshot.root);
    for (const a of snapshot.assets) {
      this.assets.set(a.assetId, a);
      if (a.parentId) {
        const list = this.children.get(a.parentId) ?? [];
        list.push(a);
        this.children.set(a.parentId, list);
      }
    }
    for (const f of snapshot.files) {
      this.files.set(f.id, f);
      const list = this.filesByName.get(lc(f.name)) ?? [];
      list.push(f);
      this.filesByName.set(lc(f.name), list);
    }
  }

  get rootId(): string {
    return this.root.assetId;
  }

  childrenOf(id: string): AmAssetResource[] {
    return this.children.get(id) ?? [];
  }

  depthOf(id: string): number {
    const cached = this.depths.get(id);
    if (cached !== undefined) return cached;
    let d = 0;
    let cur = this.assets.get(id);
    const seen = new Set<string>();
    while (cur && cur.parentId && !seen.has(cur.assetId)) {
      seen.add(cur.assetId);
      d++;
      cur = this.assets.get(cur.parentId);
    }
    this.depths.set(id, d);
    return d;
  }

  locationOf(id: string | undefined) {
    return id ? normalizeLocation(this.assets.get(id)?.location) : undefined;
  }
}

interface AssetSlot {
  /** Tenant id or `{{asset:<uid>}}` token. */
  id: string;
  existing?: AmAssetResource;
  created: boolean;
  /** Step children should wait for (create or move). */
  stepId?: string;
  label: string;
}

interface FileSlot {
  id: string;
  created: boolean;
  stepId: string;
}

class PlanBuilder {
  readonly steps: PlanStep[] = [];
  readonly blockers: Blocker[] = [];
  readonly notes: string[] = [];
  readonly targetOnly: TargetOnlyItem[] = [];
  readonly removedFromProject: TargetOnlyItem[] = [];
  private readonly T: TargetIndex;
  private readonly M: MappingView;
  private readonly tenant: string;
  private readonly typeCtx: TypeIdContext;
  private readonly claimedAspectTypes = new Set<string>();
  private readonly claimedAssetTypes = new Map<string, string>(); // lc id → project uid
  private readonly claimedAssets = new Map<string, string>(); // asset id → project uid
  private readonly claimedFiles = new Map<string, string>(); // file id → project uid
  private readonly assetSlots = new Map<string, AssetSlot>();
  private readonly fileSlots = new Map<string, FileSlot>();
  private readonly assetTypeIds = new Map<string, string>(); // uid → tenant id
  private readonly missingRefs = new Set<string>();
  private readonly validation: ValidationResult;
  /** Planned variable renames per owner (asset type or aspect type uid): lc old name → new name. */
  private readonly varRenames = new Map<string, Map<string, string>>();
  /** Planned aspect renames per asset type uid: lc old name → new name. */
  private readonly aspectRenames = new Map<string, Map<string, string>>();
  /** Members removed by this plan (their values disappear from assets): owner uid → lc names. */
  private readonly removedVarNames = new Map<string, Set<string>>();
  private readonly removedAspectNames = new Map<string, Set<string>>();
  /** Planned default value changes: owner uid → lc final variable name → {from, to}. */
  private readonly defaultChanges = new Map<string, Map<string, { from?: string; to?: string }>>();

  constructor(
    private readonly project: Project,
    private readonly index: ModelIndex,
    private readonly target: PlanTarget,
    private readonly options: PlanOptions,
  ) {
    this.T = new TargetIndex(target.snapshot, target.references);
    this.M = new MappingView(target.mapping);
    this.tenant = target.tenant;
    this.typeCtx = { tenant: target.tenant, index };
    this.validation = options.validation ?? validateProject(index, options.guardrails ?? DEFAULT_GUARDRAILS);
  }

  build(): DeploymentPlan {
    this.collectValidation();
    if (this.target.snapshot.partialFailures.length) {
      const n = this.target.snapshot.partialFailures.length;
      this.blockers.push({
        kind: "reference",
        code: "TARGET_READ_INCOMPLETE",
        message: `${n} page(s) of the target could not be read; objects on those pages are unknown and could be duplicated.`,
        hint: "Analyze the target again; proceed only if you accept the risk.",
      });
    }
    this.planAspectTypes();
    this.planAssetTypes();
    this.planAssets();
    this.planFiles();
    this.planFileAssignments();
    if (this.options.mode === "sync") this.planDeletions();
    this.collectTargetOnly();
    this.finalize();
    const steps = this.sortedSteps();
    return {
      version: 1,
      id: this.options.id ?? newUid(),
      createdAt: this.options.now?.() ?? new Date().toISOString(),
      projectId: this.project.id,
      projectName: this.project.name,
      tenant: this.tenant,
      mode: this.options.mode,
      steps,
      summary: summarize(steps),
      blockers: this.blockers,
      targetOnly: this.targetOnly,
      removedFromProject: this.removedFromProject,
      notes: this.notes,
      validation: { errors: this.validation.errors, warnings: this.validation.warnings },
      snapshotReadAt: this.target.snapshot.readAt,
    };
  }

  // -------------------------------------------------------------------------

  private collectValidation(): void {
    for (const i of this.validation.issues) {
      if (i.severity !== "error") continue;
      this.blockers.push({
        kind: "validation",
        code: i.code,
        message: `${i.target.label}: ${i.message}`,
        hint: i.hint,
        entity: { kind: i.target.kind, uid: i.target.uid, label: i.target.label },
      });
    }
  }

  private add(step: Omit<PlanStep, "destructive"> & { destructive?: boolean }): PlanStep {
    const full: PlanStep = { ...step, destructive: step.destructive ?? false };
    this.steps.push(full);
    if (full.blocked) {
      this.blockers.push({
        kind: "conflict",
        code: full.blocked.code,
        message: `${full.entity.label}: ${full.blocked.reason}`,
        hint: full.blocked.hint,
        entity: { kind: full.entity.kind, uid: full.entity.uid, label: full.entity.label },
        stepId: full.id,
      });
    }
    return full;
  }

  /** Verify that a core / external type exists in the target. */
  private checkRef(kind: "assetType" | "aspectType", ref: TypeRef, owner: string): Conflict | undefined {
    if (ref.kind === "project") return undefined;
    const found = kind === "assetType" ? this.T.assetTypes.get(lc(ref.id)) : this.T.aspectTypes.get(lc(ref.id));
    if (found) return undefined;
    const looked = kind === "assetType" ? this.target.references?.assetTypes : this.target.references?.aspectTypes;
    const verified = looked !== undefined && lc(ref.id) in looked;
    const what = kind === "assetType" ? "Asset type" : "Aspect type";
    const reason = verified
      ? `${what} ${ref.id} (${ref.kind}) does not exist in the target tenant.`
      : `${what} ${ref.id} (${ref.kind}) was not found in the target tenant's lists.`;
    const key = `${kind}:${lc(ref.id)}`;
    if (!this.missingRefs.has(key)) {
      this.missingRefs.add(key);
      this.blockers.push({
        kind: "reference",
        code: "REFERENCE_MISSING",
        message: `${reason} Referenced by ${owner}.`,
        hint: ref.kind === "core" ? "Sync the core library from the target or choose another type." : "Create or share the type in the target tenant first.",
      });
    }
    return { code: "REFERENCE_MISSING", reason };
  }

  private aspectTypeId(ref: TypeRef): string {
    return resolveTypeId(ref, "aspectType", this.typeCtx);
  }

  private assetTypeId(ref: TypeRef): string {
    if (ref.kind === "project") return this.assetTypeIds.get(ref.uid) ?? resolveTypeId(ref, "assetType", this.typeCtx);
    return ref.id;
  }

  // -------------------------------------------------------------------------
  // Aspect types
  // -------------------------------------------------------------------------

  private planAspectTypes(): void {
    for (const t of this.project.aspectTypes) {
      const id = composeTypeId(this.tenant, t.idSuffix);
      const mapped = this.M.entity("aspectType", t.uid);
      const existing =
        (mapped ? this.T.aspectTypes.get(lc(mapped.tenantId)) : undefined) ?? this.T.aspectTypes.get(lc(id));
      const entity = { kind: "aspectType" as const, uid: t.uid, label: t.name || t.idSuffix };
      const stepId = `aspectTypes:${t.uid}`;
      if (!existing) {
        const body = aspectTypeBody(t);
        const conflicts: Conflict[] = [];
        const sameName = this.T.tenantAspectTypeByName.get(lc(t.name));
        if (sameName) {
          conflicts.push({
            code: "ASPECT_TYPE_NAME_TAKEN",
            reason: `An aspect type named "${sameName.name}" already exists in the target (${sameName.id}); aspect type names are unique per tenant (case-insensitive).`,
            hint: "Rename the aspect type or change its id so it matches the existing one.",
          });
        }
        this.add({
          id: stepId,
          phase: "aspectTypes",
          level: 0,
          dependsOn: [],
          op: "create",
          entity,
          tenantId: id,
          requests: [
            { method: "PUT", path: `/aspecttypes/${seg(id)}`, ifNoneMatch: "*", contentType: JSON_TYPE, body, purpose: "Create the aspect type" },
          ],
          changes: [{ path: "", kind: "added", after: body }],
          reason: mapped ? "Previously deployed aspect type no longer exists in the target; it will be created again." : "Not present in the target.",
          blocked: blockedOf(conflicts),
          reconcile: { kind: "aspectType", id },
          mapping: { kind: "aspectType", uid: t.uid, name: t.name, tenantId: id, variables: t.variables.map((v) => ({ uid: v.uid, name: v.name })) },
        });
        continue;
      }
      this.claimedAspectTypes.add(lc(existing.id));
      this.planAspectTypeUpdate(t, existing, stepId, entity, !!mapped);
    }
  }

  private planAspectTypeUpdate(
    t: AspectTypeDef,
    existing: AmAspectTypeResource,
    stepId: string,
    entity: PlanStep["entity"],
    mapped: boolean,
  ): void {
    const id = existing.id;
    const conflicts: Conflict[] = [];
    const changes: Change[] = [];
    let destructive = false;
    if (existing.name !== t.name) {
      conflicts.push({ code: "ASPECT_TYPE_NAME_IMMUTABLE", reason: `The aspect type name cannot be changed (target "${existing.name}").`, hint: "Revert the name, or create a new aspect type." });
    }
    if (existing.category !== t.category) {
      conflicts.push({ code: "ASPECT_TYPE_CATEGORY_IMMUTABLE", reason: `The category cannot be changed (target ${existing.category}).`, hint: "Revert the category, or create a new aspect type." });
    }
    const targetVars = existing.variables ?? [];
    const { pairs, unclaimed } = pairVariables(t.variables, targetVars, (uid) => this.M.variable(t.uid, uid)?.name);
    const ops: VariableChange[] = [];
    for (const v of t.variables) {
      const desired = variableBody(v, "aspectType", t.category);
      const x = pairs.get(v.uid);
      if (!x) {
        ops.push({ uid: v.uid, to: v.name, fields: withoutName(desired) });
        changes.push({ path: `variables.${v.name}`, kind: "added", after: desired });
        continue;
      }
      conflicts.push(...variableConflicts(v, x, "aspectType", t.category));
      const fields = variableFieldUpdates(v, x, "aspectType", t.category);
      this.recordDefaultChange(t.uid, v, x, fields);
      if (x.name !== v.name || Object.keys(fields).length) ops.push({ uid: v.uid, from: x.name, to: v.name, fields });
      if (x.name !== v.name) this.recordRename(this.varRenames, t.uid, x.name, v.name);
      changes.push(...prefixChanges(`variables.${x.name}`, diffValues(comparableVariable(x, true), comparableVariable(desired, true))));
    }
    const deployedRemoved = this.removedMembers("variable", t.uid, new Set(t.variables.map((v) => v.uid)));
    const otherNames: string[] = [];
    for (const x of unclaimed) {
      const removed = deployedRemoved.get(lc(x.name));
      if (removed) {
        ops.push({ uid: removed, from: x.name });
        this.recordRemoval(this.removedVarNames, t.uid, x.name);
        changes.push({ path: `variables.${x.name}`, kind: "removed", before: comparableVariable(x, true) });
        destructive = true;
      } else {
        otherNames.push(x.name);
        this.notes.push(`Aspect type ${id}: variable "${x.name}" exists only in the target and is kept.`);
      }
    }
    const requests: PlannedRequest[] = [];
    try {
      const batches = splitVariableChanges(ops, { otherNames });
      batches.forEach((b, i) => {
        requests.push({
          method: "PATCH",
          path: `/aspecttypes/${seg(id)}/variables`,
          ifMatch: existing.etag,
          contentType: MERGE_PATCH,
          body: batchBody(b),
          purpose: batches.length > 1 ? `Update variables (${i + 1} of ${batches.length}, names are never interchanged within one request)` : "Update variables",
          memberUpdates: b.map((e) => ({ kind: "variable" as const, uid: e.uid, name: e.resultName })),
        });
      });
    } catch (e) {
      if (!(e instanceof RenamePlanError)) throw e;
      conflicts.push({ code: "VAR_NAME_TAKEN", reason: e.message, hint: "Choose a variable name that is not used in the target." });
    }
    const description = patchField(t.description, existing.description);
    if (description !== undefined) {
      requests.push({ method: "PATCH", path: `/aspecttypes/${seg(id)}`, ifMatch: existing.etag, contentType: MERGE_PATCH, body: { description }, purpose: "Update the description" });
      changes.push({ path: "description", kind: "changed", before: blankToUndefined(existing.description), after: t.description });
    }
    const removeKeys = [...deployedRemoved.values()].map((uid) => memberKey("variable", t.uid, uid));
    this.add({
      id: stepId,
      phase: "aspectTypes",
      level: 0,
      dependsOn: [],
      op: requests.length ? "update" : "skip",
      entity,
      tenantId: id,
      requests,
      changes,
      reason: requests.length
        ? `Differs from the target${mapped ? "" : " (matched by id)"}.`
        : `Unchanged${mapped ? "" : " (matched by id)"}.`,
      blocked: blockedOf(conflicts),
      destructive,
      resourcePath: `/aspecttypes/${seg(id)}`,
      expectKind: "aspectType",
      expect: comparableAspectType(existing),
      mapping: { kind: "aspectType", uid: t.uid, name: t.name, tenantId: id, variables: t.variables.map((v) => ({ uid: v.uid, name: v.name })), remove: removeKeys },
    });
  }

  /** Members this project deployed earlier that are no longer in the project: lc deployed name → member uid. */
  private removedMembers(kind: "variable" | "aspect", ownerUid: string, present: Set<string>): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of this.M.membersOf(kind, ownerUid)) {
      if (!present.has(m.uid) && m.name) out.set(lc(m.name), m.uid);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Asset types
  // -------------------------------------------------------------------------

  private typeLevels(): Map<string, number> {
    const levels = new Map<string, number>();
    const visit = (uid: string, seen: Set<string>): number => {
      const cached = levels.get(uid);
      if (cached !== undefined) return cached;
      const t = this.index.assetTypes.get(uid);
      if (!t || t.parent.kind !== "project" || seen.has(uid)) return 0;
      seen.add(uid);
      const lvl = this.index.assetTypes.has(t.parent.uid) ? visit(t.parent.uid, seen) + 1 : 0;
      levels.set(uid, lvl);
      return lvl;
    };
    for (const t of this.project.assetTypes) levels.set(t.uid, visit(t.uid, new Set()));
    return levels;
  }

  private planAssetTypes(): void {
    const levels = this.typeLevels();
    const ordered = [...this.project.assetTypes].sort((a, b) => (levels.get(a.uid) ?? 0) - (levels.get(b.uid) ?? 0));
    for (const t of ordered) {
      const id = composeTypeId(this.tenant, t.idSuffix);
      const mapped = this.M.entity("assetType", t.uid);
      let existing = (mapped ? this.T.assetTypes.get(lc(mapped.tenantId)) : undefined) ?? this.T.assetTypes.get(lc(id));
      if (existing && classifyTypeId(existing.id, this.tenant) !== "tenant") existing = undefined;
      this.assetTypeIds.set(t.uid, existing?.id ?? id);
      if (existing) this.claimedAssetTypes.set(lc(existing.id), t.uid);
    }
    for (const t of ordered) {
      const tenantId = this.assetTypeIds.get(t.uid)!;
      const existing = this.claimedAssetTypes.get(lc(tenantId)) === t.uid ? this.T.assetTypes.get(lc(tenantId)) : undefined;
      const entity = { kind: "assetType" as const, uid: t.uid, label: t.name || t.idSuffix };
      const stepId = `assetTypes:${t.uid}`;
      const dependsOn: string[] = [];
      const refConflicts: Conflict[] = [];
      if (t.parent.kind === "project") dependsOn.push(`assetTypes:${t.parent.uid}`);
      else {
        const c = this.checkRef("assetType", t.parent, `asset type "${entity.label}"`);
        if (c) refConflicts.push(c);
      }
      for (const a of t.aspects) {
        if (a.aspectType.kind === "project") dependsOn.push(`aspectTypes:${a.aspectType.uid}`);
        else {
          const c = this.checkRef("aspectType", a.aspectType, `aspect "${a.name}" of "${entity.label}"`);
          if (c) refConflicts.push(c);
        }
      }
      const level = levels.get(t.uid) ?? 0;
      const mappedEntry = this.M.entity("assetType", t.uid);
      if (!existing) {
        const body = assetTypeBody(t, this.typeCtx);
        this.add({
          id: stepId,
          phase: "assetTypes",
          level,
          dependsOn,
          op: "create",
          entity,
          tenantId,
          requests: [{ method: "PUT", path: `/assettypes/${seg(tenantId)}`, ifNoneMatch: "*", contentType: JSON_TYPE, body, purpose: "Create the asset type" }],
          changes: [{ path: "", kind: "added", after: body }],
          reason: mappedEntry ? "Previously deployed asset type no longer exists in the target; it will be created again." : "Not present in the target.",
          blocked: blockedOf(refConflicts),
          reconcile: { kind: "assetType", id: tenantId },
          mapping: {
            kind: "assetType",
            uid: t.uid,
            name: t.name,
            tenantId,
            variables: t.variables.map((v) => ({ uid: v.uid, name: v.name })),
            aspects: t.aspects.map((a) => ({ uid: a.uid, name: a.name })),
          },
        });
        continue;
      }
      this.planAssetTypeUpdate(t, existing, { stepId, entity, level, dependsOn, refConflicts, mapped: !!mappedEntry });
    }
  }

  private planAssetTypeUpdate(
    t: AssetTypeDef,
    existing: AmAssetTypeResource,
    ctx: { stepId: string; entity: PlanStep["entity"]; level: number; dependsOn: string[]; refConflicts: Conflict[]; mapped: boolean },
  ): void {
    const id = existing.id;
    const conflicts: Conflict[] = [...ctx.refConflicts];
    const changes: Change[] = [];
    let destructive = false;
    const parentId = this.assetTypeId(t.parent);
    if (lc(existing.parentTypeId ?? "") !== lc(parentId)) {
      conflicts.push({
        code: "PARENT_TYPE_IMMUTABLE",
        reason: `The parent type cannot be changed (target ${existing.parentTypeId}, project ${parentId}).`,
        hint: "Delete and recreate the asset type (its assets must be recreated as well), or revert the parent.",
      });
    }
    const targetInstantiable = existing.instantiable !== false;
    if (targetInstantiable && !t.instantiable) {
      conflicts.push({ code: "INSTANTIABLE_IMMUTABLE", reason: "An instantiable type cannot be changed to be non-instantiable.", hint: "Revert the change, or create a new abstract type." });
    }

    // Variables (own only; inherited ones carry _links.origin)
    const targetVars = (existing.variables ?? []).filter(isOwn);
    const { pairs, unclaimed } = pairVariables(t.variables, targetVars, (uid) => this.M.variable(t.uid, uid)?.name);
    const renameOps: VariableChange[] = [];
    const adds: VariableDef[] = [];
    for (const v of t.variables) {
      const desired = variableBody(v, "assetType");
      const x = pairs.get(v.uid);
      if (!x) {
        adds.push(v);
        changes.push({ path: `variables.${v.name}`, kind: "added", after: desired });
        continue;
      }
      conflicts.push(...variableConflicts(v, x, "assetType"));
      const fields = variableFieldUpdates(v, x, "assetType");
      this.recordDefaultChange(t.uid, v, x, fields);
      if (x.name !== v.name || Object.keys(fields).length) renameOps.push({ uid: v.uid, from: x.name, to: v.name, fields });
      if (x.name !== v.name) this.recordRename(this.varRenames, t.uid, x.name, v.name);
      changes.push(...prefixChanges(`variables.${x.name}`, diffValues(comparableVariable(x, false), comparableVariable(desired, false))));
    }
    const deployedRemoved = this.removedMembers("variable", t.uid, new Set(t.variables.map((v) => v.uid)));
    const deletes: { uid: string; name: string }[] = [];
    const foreign: AmVariableDefinition[] = [];
    for (const x of unclaimed) {
      const removed = deployedRemoved.get(lc(x.name));
      if (removed) {
        deletes.push({ uid: removed, name: x.name });
        this.recordRemoval(this.removedVarNames, t.uid, x.name);
        changes.push({ path: `variables.${x.name}`, kind: "removed", before: comparableVariable(x, false) });
        destructive = true;
      } else {
        foreign.push(x);
        this.notes.push(`Asset type ${id}: variable "${x.name}" exists only in the target and is kept.`);
      }
    }
    const foreignNames = new Set(foreign.map((x) => lc(x.name)));
    for (const v of adds) {
      if (foreignNames.has(lc(v.name))) {
        conflicts.push({ code: "VAR_NAME_TAKEN", reason: `Variable "${v.name}" is already used by a variable that exists only in the target.`, hint: "Choose another variable name." });
      }
    }

    // Aspects (own only)
    const targetAspects = (existing.aspects ?? []).filter(isOwn);
    const aspectClaimed = new Set<number>();
    const aspectPairs = new Map<string, number>();
    t.aspects.forEach((a) => {
      const m = this.M.aspect(t.uid, a.uid);
      if (!m?.aspectId) return;
      const i = targetAspects.findIndex((x, idx) => !aspectClaimed.has(idx) && x.aspectId === m.aspectId);
      if (i >= 0) {
        aspectPairs.set(a.uid, i);
        aspectClaimed.add(i);
      }
    });
    t.aspects.forEach((a) => {
      if (aspectPairs.has(a.uid)) return;
      const m = this.M.aspect(t.uid, a.uid);
      const names = [m?.name, a.name].filter((n): n is string => !!n).map(lc);
      const i = targetAspects.findIndex((x, idx) => !aspectClaimed.has(idx) && names.includes(lc(x.name)));
      if (i >= 0) {
        aspectPairs.set(a.uid, i);
        aspectClaimed.add(i);
      }
    });
    const finalAspects: { name: string; aspectId?: string; aspectTypeId: string }[] = [];
    const mappingAspects: { uid: string; name: string; aspectId?: string }[] = [];
    for (const a of t.aspects) {
      const aspectTypeId = this.aspectTypeId(a.aspectType);
      const i = aspectPairs.get(a.uid);
      const x = i === undefined ? undefined : targetAspects[i];
      if (x && lc(x.aspectType?.id ?? "") === lc(aspectTypeId)) {
        finalAspects.push({ name: a.name, aspectId: x.aspectId, aspectTypeId });
        mappingAspects.push({ uid: a.uid, name: a.name, aspectId: x.aspectId });
        if (x.name !== a.name) {
          changes.push({ path: `aspects.${x.name}.name`, kind: "changed", before: x.name, after: a.name });
          this.recordRename(this.aspectRenames, t.uid, x.name, a.name);
        }
      } else {
        if (x) {
          destructive = true;
          changes.push({ path: `aspects.${x.name}`, kind: "removed", before: { name: x.name, aspectTypeId: x.aspectType?.id } });
          this.recordRemoval(this.removedAspectNames, t.uid, x.name);
        }
        finalAspects.push({ name: a.name, aspectTypeId });
        mappingAspects.push({ uid: a.uid, name: a.name });
        changes.push({ path: `aspects.${a.name}`, kind: "added", after: { name: a.name, aspectTypeId } });
      }
    }
    const removedAspects = this.removedMembers("aspect", t.uid, new Set(t.aspects.map((a) => a.uid)));
    const removedAspectIds = new Map<string, string>();
    for (const m of this.M.membersOf("aspect", t.uid)) if (!t.aspects.some((a) => a.uid === m.uid) && m.aspectId) removedAspectIds.set(m.aspectId, m.uid);
    const removedAspectUids: string[] = [];
    targetAspects.forEach((x, idx) => {
      if (aspectClaimed.has(idx)) return;
      const removedUid = (x.aspectId ? removedAspectIds.get(x.aspectId) : undefined) ?? removedAspects.get(lc(x.name));
      if (removedUid) {
        destructive = true;
        removedAspectUids.push(removedUid);
        this.recordRemoval(this.removedAspectNames, t.uid, x.name);
        changes.push({ path: `aspects.${x.name}`, kind: "removed", before: { name: x.name, aspectTypeId: x.aspectType?.id } });
      } else {
        finalAspects.push({ name: x.name, ...(x.aspectId ? { aspectId: x.aspectId } : {}), aspectTypeId: x.aspectType?.id ?? "" });
        this.notes.push(`Asset type ${id}: aspect "${x.name}" exists only in the target and is kept.`);
      }
    });
    const currentAspects = targetAspects.map((x) => ({ name: x.name, aspectId: x.aspectId, aspectTypeId: x.aspectType?.id ?? "" }));
    const aspectKey = (l: { name: string; aspectId?: string; aspectTypeId: string }[]) =>
      JSON.stringify(l.map((a) => [a.name, a.aspectId ?? "", lc(a.aspectTypeId)]).sort());
    const aspectsChanged = aspectKey(currentAspects) !== aspectKey(finalAspects);

    // Requests
    const requests: PlannedRequest[] = [];
    const finalNames = new Set([...renameOps.map((r) => lc(r.to!)), ...adds.map((v) => lc(v.name))]);
    const preDelete = deletes.length > 0 && deletes.some((d) => finalNames.has(lc(d.name)));
    const deletedNames = new Set(deletes.map((d) => lc(d.name)));
    if (preDelete) {
      requests.push({
        method: "PATCH",
        path: `/assettypes/${seg(id)}`,
        ifMatch: existing.etag,
        contentType: MERGE_PATCH,
        body: { variables: targetVars.filter((x) => !deletedNames.has(lc(x.name))).map(cleanVariable) },
        purpose: "Remove deleted variables first (their names are reused)",
        memberUpdates: deletes.map((d) => ({ kind: "variable" as const, uid: d.uid, name: null })),
      });
    }
    try {
      const batches = splitVariableChanges(renameOps, {
        otherNames: [...foreign.map((x) => x.name), ...(preDelete ? [] : deletes.map((d) => d.name))],
      });
      batches.forEach((b, i) => {
        requests.push({
          method: "PATCH",
          path: `/assettypes/${seg(id)}/variables`,
          ifMatch: existing.etag,
          contentType: MERGE_PATCH,
          body: batchBody(b),
          purpose: batches.length > 1 ? `Update variables (${i + 1} of ${batches.length}, names are never interchanged within one request)` : "Update variables",
          memberUpdates: b.map((e) => ({ kind: "variable" as const, uid: e.uid, name: e.resultName })),
        });
      });
    } catch (e) {
      if (!(e instanceof RenamePlanError)) throw e;
      conflicts.push({ code: "VAR_NAME_TAKEN", reason: e.message, hint: "Choose a variable name that is not used in the target." });
    }
    const typePatch: Record<string, unknown> = {};
    if (existing.name !== t.name) {
      typePatch.name = t.name;
      changes.push({ path: "name", kind: "changed", before: existing.name, after: t.name });
    }
    const description = patchField(t.description, existing.description);
    if (description !== undefined) {
      typePatch.description = description;
      changes.push({ path: "description", kind: "changed", before: blankToUndefined(existing.description), after: t.description });
    }
    if (!targetInstantiable && t.instantiable) {
      typePatch.instantiable = true;
      changes.push({ path: "instantiable", kind: "changed", before: false, after: true });
    }
    const variablesChanged = adds.length > 0 || (deletes.length > 0 && !preDelete);
    if (variablesChanged || aspectsChanged) {
      // Merge patch replaces arrays entirely: always send the complete lists.
      typePatch.variables = [...t.variables.map((v) => variableBody(v, "assetType")), ...foreign.map(cleanVariable)];
      typePatch.aspects = finalAspects;
    }
    if (Object.keys(typePatch).length) {
      requests.push({
        method: "PATCH",
        path: `/assettypes/${seg(id)}`,
        ifMatch: existing.etag,
        contentType: MERGE_PATCH,
        body: typePatch,
        purpose: "Update the asset type (complete variable and aspect lists)",
        memberUpdates: [
          ...adds.map((v) => ({ kind: "variable" as const, uid: v.uid, name: v.name })),
          ...(preDelete ? [] : deletes.map((d) => ({ kind: "variable" as const, uid: d.uid, name: null }))),
          ...removedAspectUids.map((uid) => ({ kind: "aspect" as const, uid, name: null })),
        ],
      });
    }
    this.add({
      id: ctx.stepId,
      phase: "assetTypes",
      level: ctx.level,
      dependsOn: ctx.dependsOn,
      op: requests.length ? "update" : "skip",
      entity: ctx.entity,
      tenantId: id,
      requests,
      changes,
      reason: requests.length ? `Differs from the target${ctx.mapped ? "" : " (matched by id)"}.` : `Unchanged${ctx.mapped ? "" : " (matched by id)"}.`,
      blocked: blockedOf(conflicts),
      destructive,
      resourcePath: `/assettypes/${seg(id)}`,
      expectKind: "assetType",
      expect: comparableAssetType(existing),
      mapping: {
        kind: "assetType",
        uid: t.uid,
        name: t.name,
        tenantId: id,
        variables: t.variables.map((v) => ({ uid: v.uid, name: v.name })),
        aspects: mappingAspects,
        remove: [
          ...deletes.map((d) => memberKey("variable", t.uid, d.uid)),
          ...removedAspectUids.map((uid) => memberKey("aspect", t.uid, uid)),
        ],
      },
    });
  }

  // -------------------------------------------------------------------------
  // Assets & locations
  // -------------------------------------------------------------------------

  private recordDefaultChange(owner: string, v: VariableDef, x: AmVariableDefinition, fields: Record<string, unknown>): void {
    if (!("defaultValue" in fields)) return;
    const m = this.defaultChanges.get(owner) ?? new Map<string, { from?: string; to?: string }>();
    m.set(lc(v.name), { from: blankToUndefined(x.defaultValue), to: blankToUndefined(v.defaultValue) });
    this.defaultChanges.set(owner, m);
  }

  /** Default values of the asset's desired type: variables and static aspect variables. */
  private defaultsOf(a: AssetDef): { vars: Map<string, string>; aspects: Map<string, Map<string, string>> } {
    const resolved = this.index.resolveAssetType(a.type);
    const vars = new Map<string, string>();
    for (const x of resolved?.variables ?? []) if (x.defaultValue) vars.set(lc(x.name), x.defaultValue);
    const aspects = new Map<string, Map<string, string>>();
    for (const asp of resolved?.aspects ?? []) {
      if (asp.aspectType.category !== "static") continue;
      const m = new Map<string, string>();
      for (const x of asp.aspectType.variables) if (x.defaultValue) m.set(lc(x.name), x.defaultValue);
      aspects.set(lc(asp.name), m);
    }
    return { vars, aspects };
  }

  private recordRemoval(store: Map<string, Set<string>>, owner: string, name: string): void {
    const set = store.get(owner) ?? new Set<string>();
    set.add(lc(name));
    store.set(owner, set);
  }

  private recordRename(store: Map<string, Map<string, string>>, owner: string, from: string, to: string): void {
    const m = store.get(owner) ?? new Map<string, string>();
    m.set(lc(from), to);
    store.set(owner, m);
  }

  /**
   * The asset's values after the type steps: variable / aspect renames of
   * project types are applied and values of variables or aspects this plan
   * removes from the types are dropped (the platform removes them as well).
   */
  private valuesAfterTypeSteps(a: AssetDef, existing: AmAssetResource): Pick<AmAssetResource, "variables" | "aspects"> {
    const resolved = this.index.resolveAssetType(a.type);
    const varMap = new Map<string, string>();
    const aspMap = new Map<string, string>();
    const removedVars = new Set<string>();
    const removedAspects = new Set<string>();
    for (const ref of resolved?.chain ?? []) {
      if (ref.kind !== "project") continue;
      for (const [k, val] of this.varRenames.get(ref.uid) ?? []) varMap.set(k, val);
      for (const [k, val] of this.aspectRenames.get(ref.uid) ?? []) aspMap.set(k, val);
      for (const n of this.removedVarNames.get(ref.uid) ?? []) removedVars.add(n);
      for (const n of this.removedAspectNames.get(ref.uid) ?? []) removedAspects.add(n);
    }
    const aspectDefs = new Map((resolved?.aspects ?? []).map((x) => [lc(x.name), x]));
    const defaultChange = new Map<string, { from?: string; to?: string }>();
    for (const ref of resolved?.chain ?? []) {
      if (ref.kind === "project") for (const [k, val] of this.defaultChanges.get(ref.uid) ?? []) defaultChange.set(k, val);
    }
    // A shown value equal to the old default follows the new default (or disappears).
    const followDefault = (changes: Map<string, { from?: string; to?: string }> | undefined) => (x: { name: string; value: string }) => {
      const dc = changes?.get(lc(x.name));
      if (!dc || x.value !== dc.from) return [x];
      return dc.to === undefined ? [] : [{ name: x.name, value: dc.to }];
    };
    const variables = (existing.variables ?? [])
      .filter((x) => !removedVars.has(lc(x.name)))
      .map((x) => ({ name: varMap.get(lc(x.name)) ?? x.name, value: x.value }))
      .flatMap(followDefault(defaultChange));
    const aspects = (existing.aspects ?? []).flatMap((asp) => {
      if (removedAspects.has(lc(asp.name))) return [];
      const name = aspMap.get(lc(asp.name)) ?? asp.name;
      const ref = aspectDefs.get(lc(name))?.aspectType.ref;
      const owner = ref?.kind === "project" ? ref.uid : undefined;
      const vr = owner ? this.varRenames.get(owner) : undefined;
      const gone = owner ? this.removedVarNames.get(owner) : undefined;
      const vars = (asp.variables ?? [])
        .filter((x) => !gone?.has(lc(x.name)))
        .map((x) => ({ name: vr?.get(lc(x.name)) ?? x.name, value: x.value }))
        .flatMap(followDefault(owner ? this.defaultChanges.get(owner) : undefined));
      return [{ name, variables: vars }];
    });
    return { variables, aspects };
  }

  private planAssets(): void {
    const T = this.T;
    this.assetSlots.set(ROOT_ASSET_UID, { id: T.rootId, existing: T.root, created: false, label: "Tenant root" });
    const projectUids = new Set(this.project.assets.map((a) => a.uid));
    const mappedElsewhere = new Map<string, string>();
    for (const [uid, entry] of this.M.entities("asset")) if (projectUids.has(uid)) mappedElsewhere.set(entry.tenantId, uid);

    const queue: AssetDef[] = [...this.index.childrenOf(ROOT_ASSET_UID)];
    const seen = new Set<string>([ROOT_ASSET_UID]);
    while (queue.length) {
      const a = queue.shift()!;
      if (seen.has(a.uid)) continue;
      seen.add(a.uid);
      queue.push(...this.index.childrenOf(a.uid));
      const parent = a.parentUid ? this.assetSlots.get(a.parentUid) : undefined;
      if (!parent) continue;
      this.planAsset(a, parent, mappedElsewhere);
    }
  }

  private planAsset(a: AssetDef, parent: AssetSlot, mappedElsewhere: Map<string, string>): void {
    const T = this.T;
    const level = this.index.levelOf(a.uid);
    const entity = { kind: "asset" as const, uid: a.uid, label: a.name };
    const typeId = this.assetTypeId(a.type);
    const typeDeps = a.type.kind === "project" ? [`assetTypes:${a.type.uid}`] : [];
    const refConflict = a.type.kind === "project" ? undefined : this.checkRef("assetType", a.type, `asset "${a.name}"`);
    const mapped = this.M.entity("asset", a.uid);
    let existing = mapped ? T.assets.get(mapped.tenantId) : undefined;
    if (existing && (existing.assetId === T.rootId || this.claimedAssets.has(existing.assetId))) existing = undefined;
    let matchedByName = false;
    if (!existing && !parent.created) {
      existing = T.childrenOf(parent.id).find(
        (c) =>
          lc(c.name) === lc(a.name) &&
          !this.claimedAssets.has(c.assetId) &&
          (mappedElsewhere.get(c.assetId) ?? a.uid) === a.uid,
      );
      matchedByName = !!existing;
    }
    const parentDeps = parent.stepId ? [parent.stepId] : [];

    if (!existing) {
      const conflicts: Conflict[] = refConflict ? [refConflict] : [];
      if (!parent.created && T.childrenOf(parent.id).some((c) => lc(c.name) === lc(a.name))) {
        conflicts.push({
          code: "ASSET_NAME_TAKEN",
          reason: `Another asset named "${a.name}" already exists under "${parent.label}" in the target and belongs to a different project asset.`,
          hint: "Rename one of the assets.",
        });
      }
      const token = `{{asset:${a.uid}}}`;
      const body = assetCreateBody(a, typeId, parent.id, this.index);
      const stepId = `assets:${a.uid}`;
      this.add({
        id: stepId,
        phase: "assets",
        level,
        dependsOn: [...typeDeps, ...parentDeps],
        op: "create",
        entity,
        tenantId: "pending",
        requests: [{ method: "POST", path: "/assets", contentType: JSON_TYPE, body, purpose: "Create the asset" }],
        changes: [{ path: "", kind: "added", after: body }],
        reason: mapped ? "Previously deployed asset no longer exists in the target; it will be created again." : "Not present in the target.",
        blocked: blockedOf(conflicts),
        createsToken: `asset:${a.uid}`,
        reconcile: { kind: "asset", parentId: parent.id, name: a.name },
        mapping: { kind: "asset", uid: a.uid, name: a.name, tenantId: token },
      });
      this.assetSlots.set(a.uid, { id: token, created: true, stepId, label: a.name });
      return;
    }

    this.claimedAssets.set(existing.assetId, a.uid);
    const id = existing.assetId;
    const conflicts: Conflict[] = refConflict ? [refConflict] : [];
    if (lc(existing.typeId) !== lc(typeId)) {
      conflicts.push({
        code: "ASSET_TYPE_IMMUTABLE",
        reason: `The type of an existing asset cannot be changed (target ${existing.typeId}, project ${typeId}).`,
        hint: "Delete the asset in the tenant and recreate it (its data is lost), or revert the type.",
      });
    }
    const targetTwin = existing.twinType ?? "performance";
    if (targetTwin !== a.twinType) {
      conflicts.push({ code: "TWIN_TYPE_IMMUTABLE", reason: `The twin type can only be set at creation (target ${targetTwin}).`, hint: "Delete and recreate the asset, or revert the twin type." });
    }
    if (a.timezone !== undefined && a.timezone !== existing.timezone) {
      conflicts.push({
        code: "TIMEZONE_IMMUTABLE",
        reason: `The timezone can only be set at creation (target ${existing.timezone ?? "tenant default"}, project ${a.timezone}).`,
        hint: "Delete and recreate the asset, or revert the timezone.",
      });
    }

    let moveStepId: string | undefined;
    if (existing.parentId !== parent.id) {
      moveStepId = `assets:move:${a.uid}`;
      this.add({
        id: moveStepId,
        phase: "assets",
        level,
        dependsOn: parentDeps,
        op: "move",
        entity,
        tenantId: id,
        requests: [
          { method: "POST", path: `/assets/${seg(id)}/move`, ifMatch: existing.etag, contentType: JSON_TYPE, body: { newParentId: parent.id }, purpose: "Move the asset (and its children)" },
        ],
        changes: [{ path: "parent", kind: "changed", before: T.assets.get(existing.parentId ?? "")?.name ?? existing.parentId, after: parent.label }],
        reason: `Parent changed to "${parent.label}".`,
        resourcePath: `/assets/${seg(id)}`,
        expectKind: "assetParent",
        expect: { parentId: existing.parentId },
      });
    }

    // Values as they will be once the type steps ran (renames propagate,
    // removed variables / aspects lose their values on the platform).
    const view: AmAssetResource = { ...existing, ...this.valuesAfterTypeSteps(a, existing) };
    const patch: Record<string, unknown> = {};
    if (existing.name !== a.name) patch.name = a.name;
    const externalId = patchField(a.externalId, existing.externalId);
    if (externalId !== undefined) patch.externalId = externalId;
    const description = patchField(a.description, existing.description);
    if (description !== undefined) patch.description = description;
    // Tenants may show effective values (defaults included); values equal to
    // the type's default are treated as "not set" so patches never pin defaults.
    const defaults = this.defaultsOf(a);
    const stripVars = (list: AmVariable[] | undefined) => (list ?? []).filter((x) => defaults.vars.get(lc(x.name)) !== x.value);
    const stripAspects = (list: AmAspect[] | undefined) =>
      (list ?? []).map((asp) => ({ name: asp.name, variables: asp.variables.filter((x) => defaults.aspects.get(lc(asp.name))?.get(lc(x.name)) !== x.value) }));
    const viewVars = stripVars(view.variables);
    const viewAspects = stripAspects(view.aspects);
    const desiredVars = mergedValues(a.variables, viewVars);
    if (!sameJson(sortedValues(stripVars(desiredVars)), sortedValues(viewVars))) patch.variables = desiredVars;
    const desiredAspects = mergedAspects(staticAspectValues(a, this.index), viewAspects);
    if (!sameJson(sortedAspects(stripAspects(desiredAspects)), sortedAspects(viewAspects))) patch.aspects = desiredAspects;
    const current = comparableAsset(view);
    const before = { ...current, variables: sortedValues(viewVars), aspects: sortedAspects(viewAspects) };
    const desired = {
      ...before,
      name: a.name,
      externalId: blankToUndefined(a.externalId),
      description: blankToUndefined(a.description),
      variables: sortedValues(stripVars(desiredVars)),
      aspects: sortedAspects(stripAspects(desiredAspects)),
    };
    const changes = diffValues(before, desired);
    const hasPatch = Object.keys(patch).length > 0;
    this.add({
      id: `assets:${a.uid}`,
      phase: "assets",
      level,
      dependsOn: [...typeDeps, ...(moveStepId ? [moveStepId] : [])],
      op: hasPatch ? "update" : "skip",
      entity,
      tenantId: id,
      requests: hasPatch
        ? [{ method: "PATCH", path: `/assets/${seg(id)}`, ifMatch: existing.etag, contentType: MERGE_PATCH, body: patch, purpose: "Update the asset's values" }]
        : [],
      changes,
      reason: hasPatch
        ? `Values differ from the target${matchedByName ? " (matched by parent and name)" : ""}.`
        : `Unchanged${matchedByName ? " (matched by parent and name)" : ""}.`,
      blocked: blockedOf(conflicts),
      resourcePath: `/assets/${seg(id)}`,
      expectKind: "asset",
      expect: current,
      mapping: { kind: "asset", uid: a.uid, name: a.name, tenantId: id },
    });
    this.assetSlots.set(a.uid, { id, existing, created: false, stepId: moveStepId, label: a.name });

    // Location (existing assets; new assets get theirs in the POST body)
    const desiredLoc = normalizeLocation(a.location);
    const currentLoc = normalizeLocation(existing.location);
    const own = currentLoc !== undefined && !sameJson(currentLoc, T.locationOf(existing.parentId));
    const moved = moveStepId !== undefined;
    let locRequest: PlannedRequest | undefined;
    let locChange: Change | undefined;
    if (desiredLoc && (!sameJson(desiredLoc, currentLoc) || (!own && moved))) {
      locRequest = { method: "PUT", path: `/assets/${seg(id)}/location`, ifMatch: existing.etag, contentType: JSON_TYPE, body: locationBody(desiredLoc), purpose: "Set the asset's own location" };
      locChange = { path: "location", kind: currentLoc ? "changed" : "added", before: currentLoc, after: desiredLoc };
    } else if (!desiredLoc && own) {
      locRequest = { method: "DELETE", path: `/assets/${seg(id)}/location`, ifMatch: existing.etag, purpose: "Remove the asset's own location (inherits again)" };
      locChange = { path: "location", kind: "removed", before: currentLoc };
    }
    if (locRequest && locChange) {
      this.add({
        id: `locations:${a.uid}`,
        phase: "locations",
        level,
        dependsOn: moveStepId ? [moveStepId] : [],
        op: "location",
        entity,
        tenantId: id,
        requests: [locRequest],
        changes: [locChange],
        reason: locRequest.method === "DELETE" ? "The project has no own location for this asset." : "Location differs from the target.",
        resourcePath: `/assets/${seg(id)}`,
        hadOwnLocation: own,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Files & assignments
  // -------------------------------------------------------------------------

  private planFiles(): void {
    const T = this.T;
    const projectUids = new Set(this.project.files.map((f) => f.uid));
    const mappedElsewhere = new Map<string, string>();
    for (const [uid, entry] of this.M.entities("file")) if (projectUids.has(uid)) mappedElsewhere.set(entry.tenantId, uid);
    for (const f of this.project.files) {
      const entity = { kind: "file" as const, uid: f.uid, label: f.name };
      const stepId = `files:${f.uid}`;
      const mapped = this.M.entity("file", f.uid);
      let existing = mapped ? T.files.get(mapped.tenantId) : undefined;
      if (existing && this.claimedFiles.has(existing.id)) existing = undefined;
      if (!existing) {
        existing = (T.filesByName.get(lc(f.name)) ?? []).find(
          (x) => !this.claimedFiles.has(x.id) && (mappedElsewhere.get(x.id) ?? f.uid) === f.uid,
        );
      }
      const hasContent = f.blobId !== "" && f.sha256 !== "";
      const spec: UploadSpec = {
        fileUid: f.uid,
        blobId: f.blobId,
        name: f.name,
        ...(f.description ? { description: f.description } : {}),
        scope: f.scope,
        mimeType: f.mimeType,
        size: f.size,
      };
      const preview = { name: f.name, fileName: f.name, description: f.description, scope: f.scope, mimeType: f.mimeType, content: `${f.size} bytes from the local file` };
      const noContent: Conflict = {
        code: "FILE_CONTENT_MISSING",
        reason: "The file content is not available locally (the backup was taken without file contents).",
        hint: "Upload the file content in the Files page.",
      };
      if (!existing) {
        const token = `{{file:${f.uid}}}`;
        this.add({
          id: stepId,
          phase: "files",
          level: 0,
          dependsOn: [],
          op: "upload",
          entity,
          tenantId: "pending",
          requests: [{ method: "POST", path: "/files", transport: "upload", upload: spec, body: preview, purpose: "Upload the file (multipart)" }],
          changes: [{ path: "", kind: "added", after: { name: f.name, scope: f.scope, mimeType: f.mimeType, size: f.size } }],
          reason: mapped ? "Previously deployed file no longer exists in the target; it will be uploaded again." : "Not present in the target.",
          blocked: hasContent ? undefined : noContent,
          createsToken: `file:${f.uid}`,
          reconcile: { kind: "file", name: f.name },
          mapping: { kind: "file", uid: f.uid, name: f.name, tenantId: token, ...(f.sha256 ? { sha256: f.sha256 } : {}) },
        });
        this.fileSlots.set(f.uid, { id: token, created: true, stepId });
        continue;
      }
      this.claimedFiles.set(existing.id, f.uid);
      this.fileSlots.set(f.uid, { id: existing.id, created: false, stepId });
      const metaChanges = diffValues(
        { name: existing.name, description: blankToUndefined(existing.description), scope: existing.scope ?? "private" },
        { name: f.name, description: blankToUndefined(f.description), scope: f.scope },
      );
      const contentChanged = mapped ? (mapped.sha256 ? mapped.sha256 !== f.sha256 : hasContent) : hasContent;
      const needsUpload = metaChanges.length > 0 || contentChanged;
      const changes = [...metaChanges];
      if (contentChanged) changes.push({ path: "content", kind: "changed", before: mapped?.sha256 ? `sha256 ${mapped.sha256.slice(0, 12)}…` : "unknown", after: `sha256 ${f.sha256.slice(0, 12)}…` });
      this.add({
        id: stepId,
        phase: "files",
        level: 0,
        dependsOn: [],
        op: needsUpload ? "update" : "skip",
        entity,
        tenantId: existing.id,
        requests: needsUpload
          ? [{ method: "PUT", path: `/files/${seg(existing.id)}`, transport: "replace", ifMatch: existing.etag, upload: spec, body: preview, purpose: "Replace the file (multipart)" }]
          : [],
        changes,
        reason: !needsUpload
          ? hasContent || mapped ? "Unchanged." : "Matched by name; no local content to compare — kept as it is."
          : mapped
            ? "Content or metadata changed since the last deployment."
            : "Matched by name; the content cannot be compared without downloading it, so it will be replaced with the local content.",
        blocked: needsUpload && !hasContent ? noContent : undefined,
        destructive: needsUpload && !mapped,
        resourcePath: `/files/${seg(existing.id)}`,
        expectKind: "file",
        expect: comparableFile(existing),
        mapping: { kind: "file", uid: f.uid, name: f.name, tenantId: existing.id, ...(f.sha256 ? { sha256: f.sha256 } : mapped?.sha256 ? { sha256: mapped.sha256 } : {}) },
      });
    }
  }

  private planFileAssignments(): void {
    const ownFileIds = new Set<string>([...this.fileSlots.values()].map((s) => s.id));
    for (const [, entry] of this.M.entities("file")) ownFileIds.add(entry.tenantId);

    const plan = (
      kind: "assetType" | "asset",
      uid: string,
      label: string,
      entityId: string,
      created: boolean,
      existing: { fileAssignments?: AmFileAssignment[]; etag: number } | undefined,
      desiredList: { key: string; fileUid: string }[],
      entityStepId: string,
    ) => {
      const current = existing ? ownAssignments(existing.fileAssignments) : [];
      const currentByKey = new Map(current.map((c) => [lc(c.key), c]));
      const desired = desiredList.flatMap((d) => {
        const slot = this.fileSlots.get(d.fileUid);
        return slot ? [{ key: d.key, fileId: slot.id, fileUid: d.fileUid, slot }] : [];
      });
      const desiredKeys = new Set(desired.map((d) => lc(d.key)));
      const unassign = current.filter((c) => !desiredKeys.has(lc(c.key)) && ownFileIds.has(c.fileId));
      const assign = desired.filter((d) => currentByKey.get(lc(d.key))?.fileId !== d.fileId);
      if (!assign.length && !unassign.length) return;
      const base = kind === "assetType" ? `/assettypes/${seg(entityId)}` : `/assets/${created ? entityId : seg(entityId)}`;
      const etag = existing?.etag ?? 0;
      const requests: PlannedRequest[] = [
        ...unassign.map((c) => ({ method: "DELETE" as const, path: `${base}/fileAssignments/${seg(c.key)}`, ifMatch: etag, purpose: `Remove assignment "${c.key}"` })),
        ...assign.map((d) => ({
          method: "PUT" as const,
          path: `${base}/fileAssignments/${seg(d.key)}`,
          ifMatch: etag,
          contentType: JSON_TYPE,
          body: { fileId: d.fileId },
          purpose: `Assign "${d.key}"`,
        })),
      ];
      const changes: Change[] = [
        ...unassign.map((c) => ({ path: `fileAssignments.${c.key}`, kind: "removed" as const, before: c.fileId })),
        ...assign.map((d) => {
          const before = currentByKey.get(lc(d.key))?.fileId;
          const fileName = this.index.files.get(d.fileUid)?.name ?? d.fileId;
          return before
            ? { path: `fileAssignments.${d.key}`, kind: "changed" as const, before, after: fileName }
            : { path: `fileAssignments.${d.key}`, kind: "added" as const, after: fileName };
        }),
      ];
      this.add({
        id: `fileAssignments:${kind}:${uid}`,
        phase: "fileAssignments",
        level: 0,
        dependsOn: [entityStepId, ...assign.map((d) => d.slot.stepId)],
        op: assign.length ? "assign" : "unassign",
        entity: { kind, uid, label },
        tenantId: created ? "pending" : entityId,
        requests,
        changes,
        reason: assign.length ? "File assignments differ from the target." : "Assignments removed from the project.",
        destructive: unassign.length > 0,
        resourcePath: base,
        ...(existing && !created ? { expectKind: "assignments" as const, expect: { fileAssignments: current } } : {}),
      });
    };

    for (const t of this.project.assetTypes) {
      const id = this.assetTypeIds.get(t.uid)!;
      const existing = this.claimedAssetTypes.get(lc(id)) === t.uid ? this.T.assetTypes.get(lc(id)) : undefined;
      plan("assetType", t.uid, t.name, id, false, existing, t.fileAssignments, `assetTypes:${t.uid}`);
    }
    for (const a of this.project.assets) {
      if (a.uid === ROOT_ASSET_UID) continue;
      const slot = this.assetSlots.get(a.uid);
      if (!slot) continue;
      plan("asset", a.uid, a.name, slot.id, slot.created, slot.existing, a.fileAssignments, `assets:${a.uid}`);
    }
  }

  // -------------------------------------------------------------------------
  // Sync deletions
  // -------------------------------------------------------------------------

  /**
   * Mapped entities that were removed from the project. Entries that were only
   * read from the tenant (backup / import, `imported`) are never deleted: the
   * project did not create them, and removing them from the project (or
   * undoing an import) must not delete existing tenant objects.
   */
  private removedEntities(kind: PlanEntityKind, present: Set<string>, exists: (tenantId: string) => boolean, claimed: (tenantId: string) => boolean) {
    return this.M.entities(kind).filter(
      ([uid, e]) => !present.has(uid) && !e.imported && exists(e.tenantId) && !claimed(e.tenantId),
    );
  }

  private planDeletions(): void {
    const T = this.T;
    const projAssets = new Set(this.project.assets.map((a) => a.uid));
    const assets = this.removedEntities("asset", projAssets, (id) => T.assets.has(id) && id !== T.rootId, (id) => this.claimedAssets.has(id));
    const projTypes = new Set(this.project.assetTypes.map((t) => t.uid));
    const assetTypes = this.removedEntities("assetType", projTypes, (id) => T.assetTypes.has(lc(id)), (id) => this.claimedAssetTypes.has(lc(id)));
    const projAspects = new Set(this.project.aspectTypes.map((t) => t.uid));
    const aspectTypes = this.removedEntities("aspectType", projAspects, (id) => T.aspectTypes.has(lc(id)), (id) => this.claimedAspectTypes.has(lc(id)));
    const projFiles = new Set(this.project.files.map((f) => f.uid));
    const files = this.removedEntities("file", projFiles, (id) => T.files.has(id), (id) => this.claimedFiles.has(id));

    const assetCand = new Map(assets.map(([uid, e]) => [e.tenantId, uid]));
    const typeCand = new Map(assetTypes.map(([uid, e]) => [lc(e.tenantId), uid]));

    const maxDepth = Math.max(0, ...assets.map(([, e]) => T.depthOf(e.tenantId)));
    const typeDepth = (id: string): number => {
      let d = 0;
      let cur = T.assetTypes.get(lc(id));
      const seen = new Set<string>();
      while (cur && typeCand.has(lc(cur.parentTypeId ?? "")) && !seen.has(lc(cur.id))) {
        seen.add(lc(cur.id));
        d++;
        cur = T.assetTypes.get(lc(cur.parentTypeId));
      }
      return d;
    };
    const maxTypeDepth = Math.max(0, ...assetTypes.map(([, e]) => typeDepth(e.tenantId)));
    const typeBase = maxDepth + 1;
    const aspectLevel = typeBase + maxTypeDepth + 1;
    const fileLevel = aspectLevel + 1;

    const del = (kind: PlanEntityKind, uid: string, label: string, tenantId: string, path: string, level: number, dependsOn: string[], conflicts: Conflict[], etag: number) => {
      this.add({
        id: `deletions:${kind}:${uid}`,
        phase: "deletions",
        level,
        dependsOn,
        op: "delete",
        entity: { kind, uid, label },
        tenantId,
        requests: [{ method: "DELETE", path, ifMatch: etag, purpose: "Delete physically" }],
        changes: [{ path: "", kind: "removed", before: label }],
        reason: "Removed from the project since the last deployment (sync mode).",
        blocked: blockedOf(conflicts),
        destructive: true,
        resourcePath: path,
        expectKind: "exists",
        expect: {},
        mapping: { kind, uid, name: label, tenantId, removeEntity: true },
      });
    };

    for (const [uid, e] of assets) {
      const res = T.assets.get(e.tenantId)!;
      const conflicts: Conflict[] = [];
      const deps: string[] = [];
      for (const c of T.childrenOf(e.tenantId)) {
        const candUid = assetCand.get(c.assetId);
        if (candUid) {
          deps.push(`deletions:asset:${candUid}`);
          continue;
        }
        const ownerUid = this.claimedAssets.get(c.assetId);
        const owner = ownerUid ? this.index.assets.get(ownerUid) : undefined;
        if (owner && owner.parentUid && this.assetSlots.get(owner.parentUid)?.id !== e.tenantId) {
          deps.push(`assets:move:${owner.uid}`);
          continue;
        }
        conflicts.push({ code: "DELETE_HAS_CHILDREN", reason: `Child asset "${c.name}" stays in the target; assets with children cannot be deleted.` });
      }
      del("asset", uid, e.name ?? res.name, e.tenantId, `/assets/${seg(e.tenantId)}`, maxDepth - T.depthOf(e.tenantId), deps, conflicts, res.etag);
    }

    for (const [uid, e] of assetTypes) {
      const res = T.assetTypes.get(lc(e.tenantId))!;
      const conflicts: Conflict[] = [];
      const deps: string[] = [];
      for (const a of T.assets.values()) {
        if (lc(a.typeId) !== lc(res.id)) continue;
        const candUid = assetCand.get(a.assetId);
        if (candUid) deps.push(`deletions:asset:${candUid}`);
        else conflicts.push({ code: "DELETE_HAS_INSTANCES", reason: `Asset "${a.name}" still instantiates this type.` });
      }
      for (const t of T.assetTypes.values()) {
        if (lc(t.parentTypeId ?? "") !== lc(res.id)) continue;
        const candUid = typeCand.get(lc(t.id));
        if (candUid) deps.push(`deletions:assetType:${candUid}`);
        else conflicts.push({ code: "DELETE_HAS_CHILD_TYPES", reason: `Asset type ${t.id} inherits from this type.` });
      }
      del("assetType", uid, e.name ?? res.name, res.id, `/assettypes/${seg(res.id)}`, typeBase + (maxTypeDepth - typeDepth(res.id)), deps, conflicts.slice(0, 5), res.etag);
    }

    for (const [uid, e] of aspectTypes) {
      const res = T.aspectTypes.get(lc(e.tenantId))!;
      const conflicts: Conflict[] = [];
      const deps: string[] = [];
      for (const t of T.assetTypes.values()) {
        if (!(t.aspects ?? []).some((x) => isOwn(x) && lc(x.aspectType?.id ?? "") === lc(res.id))) continue;
        const candUid = typeCand.get(lc(t.id));
        if (candUid) {
          deps.push(`deletions:assetType:${candUid}`);
          continue;
        }
        const ownerUid = this.claimedAssetTypes.get(lc(t.id));
        const owner = ownerUid ? this.index.assetTypes.get(ownerUid) : undefined;
        if (owner && !owner.aspects.some((x) => lc(this.aspectTypeId(x.aspectType)) === lc(res.id))) {
          deps.push(`assetTypes:${owner.uid}`);
          continue;
        }
        conflicts.push({ code: "DELETE_IN_USE", reason: `Asset type ${t.id} still uses this aspect type.` });
      }
      del("aspectType", uid, e.name ?? res.name, res.id, `/aspecttypes/${seg(res.id)}`, aspectLevel, deps, conflicts.slice(0, 5), res.etag);
    }

    const holders: { kind: "asset" | "assetType"; tenantId: string; label: string; assignments: { key: string; fileId: string }[] }[] = files.length
      ? [
          ...[...T.assets.values()].map((a) => ({ kind: "asset" as const, tenantId: a.assetId, label: a.name, assignments: ownAssignments(a.fileAssignments) })),
          ...[...T.assetTypes.values()].map((t) => ({ kind: "assetType" as const, tenantId: t.id, label: t.name, assignments: ownAssignments(t.fileAssignments) })),
        ].filter((h) => h.assignments.length > 0)
      : [];
    for (const [uid, e] of files) {
      const res = T.files.get(e.tenantId)!;
      const conflicts: Conflict[] = [];
      const deps: string[] = [];
      for (const h of holders) {
        if (!h.assignments.some((x) => x.fileId === res.id)) continue;
        const cand = h.kind === "asset" ? assetCand.get(h.tenantId) : typeCand.get(lc(h.tenantId));
        if (cand) {
          deps.push(`deletions:${h.kind}:${cand}`);
          continue;
        }
        const ownerUid = h.kind === "asset" ? this.claimedAssets.get(h.tenantId) : this.claimedAssetTypes.get(lc(h.tenantId));
        if (ownerUid) {
          deps.push(`fileAssignments:${h.kind}:${ownerUid}`);
          continue;
        }
        conflicts.push({ code: "DELETE_FILE_ASSIGNED", reason: `"${h.label}" still has this file assigned.` });
      }
      del("file", uid, e.name ?? res.name, res.id, `/files/${seg(res.id)}`, fileLevel, deps, conflicts.slice(0, 5), res.etag);
    }
  }

  // -------------------------------------------------------------------------

  private collectTargetOnly(): void {
    const deleting = new Set(this.steps.filter((s) => s.op === "delete").map((s) => lc(s.tenantId)));
    const removed = (kind: PlanEntityKind, present: Set<string>) =>
      this.M.entities(kind).filter(([uid]) => !present.has(uid)).map(([, e]) => lc(e.tenantId));
    const removedIds = new Set([
      ...removed("aspectType", new Set(this.project.aspectTypes.map((t) => t.uid))),
      ...removed("assetType", new Set(this.project.assetTypes.map((t) => t.uid))),
      ...removed("asset", new Set(this.project.assets.map((a) => a.uid))),
      ...removed("file", new Set(this.project.files.map((f) => f.uid))),
    ]);
    const push = (kind: PlanEntityKind, tenantId: string, label: string, detail?: string) => {
      if (deleting.has(lc(tenantId))) return;
      const item = { kind, tenantId, label, ...(detail ? { detail } : {}) };
      if (removedIds.has(lc(tenantId))) this.removedFromProject.push(item);
      else this.targetOnly.push(item);
    };
    for (const t of this.target.snapshot.aspectTypes.tenant) if (!this.claimedAspectTypes.has(lc(t.id))) push("aspectType", t.id, t.name, t.category);
    for (const t of this.target.snapshot.assetTypes.tenant) if (!this.claimedAssetTypes.has(lc(t.id))) push("assetType", t.id, t.name, `parent ${t.parentTypeId}`);
    for (const a of this.target.snapshot.assets) {
      if (!this.claimedAssets.has(a.assetId)) push("asset", a.assetId, a.name, a.typeId);
    }
    for (const f of this.target.snapshot.files) if (!this.claimedFiles.has(f.id)) push("file", f.id, f.name);
    if (this.targetOnly.length > MAX_LISTED) {
      this.notes.push(`${this.targetOnly.length} objects exist only in the target; the first ${MAX_LISTED} are listed.`);
      this.targetOnly.length = MAX_LISTED;
    }
  }

  private finalize(): void {
    const ids = new Set(this.steps.map((s) => s.id));
    const byId = new Map(this.steps.map((s) => [s.id, s]));
    for (const s of this.steps) s.dependsOn = [...new Set(s.dependsOn)].filter((d) => ids.has(d) && d !== s.id);
    // Steps that depend on a blocked step cannot run either; say so up front.
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of this.steps) {
        if (s.blocked) continue;
        const dep = s.dependsOn.map((d) => byId.get(d)).find((d) => d?.blocked);
        if (dep) {
          s.blocked = { code: "DEPENDENCY_BLOCKED", reason: `Depends on "${dep.entity.label}" (${dep.phase}), which is blocked.` };
          changed = true;
        }
      }
    }
  }

  private sortedSteps(): PlanStep[] {
    const phaseIndex = new Map(PHASES.map((p, i) => [p, i]));
    return this.steps
      .map((s, i) => ({ s, i }))
      .sort((a, b) => phaseIndex.get(a.s.phase)! - phaseIndex.get(b.s.phase)! || a.s.level - b.s.level || a.i - b.i)
      .map((x) => x.s);
  }
}

export function summarize(steps: PlanStep[]): PlanSummary {
  const summary: PlanSummary = { create: 0, update: 0, skip: 0, delete: 0, move: 0, blocked: 0 };
  for (const s of steps) {
    if (s.blocked) {
      summary.blocked++;
      continue;
    }
    switch (s.op) {
      case "create":
      case "upload":
        summary.create++;
        break;
      case "update":
      case "assign":
      case "unassign":
      case "location":
        summary.update++;
        break;
      case "skip":
        summary.skip++;
        break;
      case "delete":
        summary.delete++;
        break;
      case "move":
        summary.move++;
        break;
    }
  }
  return summary;
}

/** Plan a deployment of `project` to the target described by `target`. */
export function planDeployment(project: Project, index: ModelIndex, target: PlanTarget, options: PlanOptions): DeploymentPlan {
  return new PlanBuilder(project, index, target, options).build();
}

// ---------------------------------------------------------------------------
// Execution gate
// ---------------------------------------------------------------------------

export interface ExecutionGate {
  ok: boolean;
  reasons: string[];
}

/**
 * Validation errors always block. Conflicts and missing references block
 * unless the user chose to skip blocked steps (and everything depending on them).
 */
export function executionGate(plan: DeploymentPlan, skipBlocked: boolean): ExecutionGate {
  const reasons: string[] = [];
  const validation = plan.blockers.filter((b) => b.kind === "validation").length;
  if (validation) reasons.push(`${validation} validation error(s) in the project must be fixed first.`);
  const other = plan.blockers.filter((b) => b.kind !== "validation").length;
  if (other && !skipBlocked) reasons.push(`${other} blocker(s) — resolve them or choose to skip blocked steps.`);
  const runnable = plan.steps.filter((s) => !s.blocked && s.op !== "skip").length;
  if (runnable === 0) reasons.push("Nothing to deploy — every step is unchanged or blocked.");
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Reference resolution (async, before planning)
// ---------------------------------------------------------------------------

/** Core / external type ids the project references. */
export function referencedTypeIds(project: Project): { assetTypes: string[]; aspectTypes: string[] } {
  const assetTypes = new Set<string>();
  const aspectTypes = new Set<string>();
  const addAsset = (r: TypeRef) => {
    if (r.kind !== "project") assetTypes.add(r.id);
  };
  for (const t of project.assetTypes) {
    addAsset(t.parent);
    for (const a of t.aspects) if (a.aspectType.kind !== "project") aspectTypes.add(a.aspectType.id);
  }
  for (const a of project.assets) if (a.uid !== ROOT_ASSET_UID) addAsset(a.type);
  return { assetTypes: [...assetTypes], aspectTypes: [...aspectTypes] };
}

/** GET referenced core / external types that are not in the snapshot's lists. */
export async function resolveReferences(project: Project, snapshot: TenantSnapshot, transport: Transport): Promise<ReferenceLookup> {
  const refs = referencedTypeIds(project);
  const knownAsset = new Set(allTypes(snapshot.assetTypes).map((t) => lc(t.id)));
  const knownAspect = new Set(allTypes(snapshot.aspectTypes).map((t) => lc(t.id)));
  const out: ReferenceLookup = { assetTypes: {}, aspectTypes: {} };
  const jobs: (() => Promise<void>)[] = [];
  for (const id of refs.assetTypes) {
    if (knownAsset.has(lc(id))) continue;
    jobs.push(async () => {
      const res = await transport.request<AmAssetTypeResource>({ method: "GET", path: `/assettypes/${seg(id)}` });
      if (res.status < 400) out.assetTypes[lc(id)] = res.body;
      else if (res.status === 404) out.assetTypes[lc(id)] = null;
    });
  }
  for (const id of refs.aspectTypes) {
    if (knownAspect.has(lc(id))) continue;
    jobs.push(async () => {
      const res = await transport.request<AmAspectTypeResource>({ method: "GET", path: `/aspecttypes/${seg(id)}` });
      if (res.status < 400) out.aspectTypes[lc(id)] = res.body;
      else if (res.status === 404) out.aspectTypes[lc(id)] = null;
    });
  }
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      await job();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  return out;
}
