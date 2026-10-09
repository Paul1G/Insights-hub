// Cross-tenant copy: selection with dependency closure, extraction of the
// selected part into a stand-alone project, conflict detection against the
// target tenant and the per-type resolutions (rename / map to an existing
// target type, validated for compatibility).

import type { AmAspectTypeResource, AmAssetTypeResource, AmVariableDefinition } from "@/api/amTypes";
import { base64ToBlob } from "@/api/client";
import {
  ROOT_ASSET_UID,
  composeTypeId,
  createRootAsset,
  newUid,
  nowIso,
  type AssetDef,
  type FileDef,
  type Project,
  type TypeRef,
  type VariableDef,
} from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";
import { LIMITS, PATTERNS } from "@/domain/rules";
import { MAX_ID_SUFFIX } from "@/domain/validator";
import { effectiveLength, isOwn, lc } from "@/deploy/comparable";
import type { Transport } from "@/deploy/transport";
import { sha256Hex } from "@/storage/repository";
import { allTypes, type TenantSnapshot } from "./read";

export interface CopySelection {
  aspectTypes: ReadonlySet<string>;
  assetTypes: ReadonlySet<string>;
  /** Roots of asset subtrees to copy (each with all descendants). */
  assetRoots: ReadonlySet<string>;
}

export interface CopyClosure {
  aspectTypes: Set<string>;
  assetTypes: Set<string>;
  assets: Set<string>;
  files: Set<string>;
  /** Entities added automatically because selected entities depend on them. */
  added: { aspectTypes: number; assetTypes: number; files: number };
}

/** Selected entities plus everything they depend on (parents, aspect types, asset types of assets, files). */
export function selectionClosure(index: ModelIndex, selection: CopySelection): CopyClosure {
  const assets = new Set<string>();
  for (const root of selection.assetRoots) {
    if (root === ROOT_ASSET_UID || !index.assets.has(root)) continue;
    assets.add(root);
    for (const d of index.descendantsOf(root)) assets.add(d);
  }
  const assetTypes = new Set<string>(selection.assetTypes);
  for (const uid of assets) {
    const a = index.assets.get(uid)!;
    if (a.type.kind === "project") assetTypes.add(a.type.uid);
  }
  for (const uid of [...assetTypes]) for (const anc of index.ancestorTypesOf(uid)) assetTypes.add(anc.uid);
  const aspectTypes = new Set<string>(selection.aspectTypes);
  for (const uid of assetTypes) {
    for (const a of index.assetTypes.get(uid)?.aspects ?? []) if (a.aspectType.kind === "project") aspectTypes.add(a.aspectType.uid);
  }
  const files = new Set<string>();
  for (const uid of assetTypes) for (const fa of index.assetTypes.get(uid)?.fileAssignments ?? []) files.add(fa.fileUid);
  for (const uid of assets) for (const fa of index.assets.get(uid)?.fileAssignments ?? []) files.add(fa.fileUid);
  return {
    aspectTypes,
    assetTypes,
    assets,
    files,
    added: {
      aspectTypes: [...aspectTypes].filter((u) => !selection.aspectTypes.has(u)).length,
      assetTypes: [...assetTypes].filter((u) => !selection.assetTypes.has(u)).length,
      files: files.size,
    },
  };
}

function stripVariable(v: VariableDef): VariableDef {
  const out = { ...v };
  delete out.baseline;
  return out;
}

/**
 * A new project with only the closure. Copied subtree roots are attached to
 * the tenant root; baselines are dropped (the entities are new to the target).
 */
export function extractProject(project: Project, closure: CopyClosure, name: string): Project {
  const at = nowIso();
  const assets: AssetDef[] = [createRootAsset()];
  for (const a of project.assets) {
    if (!closure.assets.has(a.uid)) continue;
    const copy = structuredClone(a);
    delete copy.baseline;
    if (!copy.parentUid || !closure.assets.has(copy.parentUid)) copy.parentUid = ROOT_ASSET_UID;
    assets.push(copy);
  }
  return {
    schemaVersion: project.schemaVersion,
    id: newUid(),
    name,
    description: `Copied from ${project.name}`,
    createdAt: at,
    updatedAt: at,
    aspectTypes: project.aspectTypes
      .filter((t) => closure.aspectTypes.has(t.uid))
      .map((t) => {
        const copy = structuredClone(t);
        delete copy.baseline;
        copy.variables = copy.variables.map(stripVariable);
        return copy;
      }),
    assetTypes: project.assetTypes
      .filter((t) => closure.assetTypes.has(t.uid))
      .map((t) => {
        const copy = structuredClone(t);
        delete copy.baseline;
        copy.variables = copy.variables.map(stripVariable);
        return copy;
      }),
    assets,
    files: project.files.filter((f) => closure.files.has(f.uid)).map((f) => structuredClone(f)),
    changelog: [{ at, summary: `Copied from “${project.name}”` }],
  };
}

// ---------------------------------------------------------------------------
// Conflicts and resolutions
// ---------------------------------------------------------------------------

export interface TypeConflict {
  kind: "aspectType" | "assetType";
  uid: string;
  name: string;
  idSuffix: string;
  /** Composed id in the target. */
  id: string;
  /** Which property collides (case-insensitive). */
  collision: "id" | "name" | "id+name";
  existingId: string;
  existingName: string;
}

export type Resolution =
  | { action: "rename"; idSuffix: string; name: string }
  | { action: "map"; targetId: string };

/** Type id / name collisions (case-insensitive) with the target tenant's own types. */
export function findConflicts(project: Project, tenant: string, target: TenantSnapshot): TypeConflict[] {
  const out: TypeConflict[] = [];
  const check = <T extends { id: string; name: string }>(kind: TypeConflict["kind"], defs: { uid: string; name: string; idSuffix: string }[], existing: T[]) => {
    const byId = new Map(existing.map((t) => [lc(t.id), t]));
    const byName = new Map(existing.map((t) => [lc(t.name), t]));
    for (const d of defs) {
      const id = composeTypeId(tenant, d.idSuffix);
      const sameId = byId.get(lc(id));
      const sameName = byName.get(lc(d.name));
      const hit = sameId ?? sameName;
      if (!hit) continue;
      out.push({
        kind,
        uid: d.uid,
        name: d.name,
        idSuffix: d.idSuffix,
        id,
        collision: sameId && sameName === sameId ? "id+name" : sameId ? "id" : "name",
        existingId: hit.id,
        existingName: hit.name,
      });
    }
  };
  check("aspectType", project.aspectTypes, target.aspectTypes.tenant);
  check("assetType", project.assetTypes, target.assetTypes.tenant);
  return out;
}

function varsCompatible(source: VariableDef[], target: AmVariableDefinition[], what: string): string[] {
  const problems: string[] = [];
  const byName = new Map(target.map((v) => [lc(v.name), v]));
  for (const v of source) {
    const t = byName.get(lc(v.name));
    if (!t) {
      problems.push(`${what}: variable "${v.name}" does not exist in the target type.`);
      continue;
    }
    if (t.dataType !== v.dataType) problems.push(`${what}: variable "${v.name}" is ${t.dataType} in the target (source ${v.dataType}).`);
    const sl = effectiveLength(v.dataType, v.length);
    const tl = effectiveLength(t.dataType, t.length);
    if (sl !== undefined && tl !== undefined && tl < sl) problems.push(`${what}: variable "${v.name}" is shorter in the target (${tl} < ${sl}).`);
  }
  return problems;
}

function targetChain(id: string, target: TenantSnapshot): AmAssetTypeResource[] {
  const types = new Map(allTypes(target.assetTypes).map((t) => [lc(t.id), t]));
  const out: AmAssetTypeResource[] = [];
  const seen = new Set<string>();
  let cur = types.get(lc(id));
  while (cur && !seen.has(lc(cur.id))) {
    out.push(cur);
    seen.add(lc(cur.id));
    cur = cur.parentTypeId ? types.get(lc(cur.parentTypeId)) : undefined;
  }
  return out;
}

/**
 * Problems that prevent mapping a source type onto an existing target type
 * (empty = compatible). `resolutions` lets aspect references of asset types
 * follow other mappings.
 */
export function compatibilityProblems(
  kind: "aspectType" | "assetType",
  uid: string,
  targetId: string,
  project: Project,
  index: ModelIndex,
  target: TenantSnapshot,
  resolutions: ReadonlyMap<string, Resolution>,
): string[] {
  if (kind === "aspectType") {
    const def = index.aspectTypes.get(uid);
    const t: AmAspectTypeResource | undefined = allTypes(target.aspectTypes).find((x) => lc(x.id) === lc(targetId));
    if (!def || !t) return ["The target aspect type does not exist."];
    const problems: string[] = [];
    if (t.category !== def.category) problems.push(`Category differs (target ${t.category}, source ${def.category}).`);
    problems.push(...varsCompatible(def.variables, t.variables ?? [], def.name));
    return problems;
  }
  const def = index.assetTypes.get(uid);
  const chain = targetChain(targetId, target);
  if (!def || chain.length === 0) return ["The target asset type does not exist."];
  const problems: string[] = [];
  const usedByAssets = project.assets.some((a) => a.type.kind === "project" && a.type.uid === uid);
  if (usedByAssets && chain[0]!.instantiable === false) problems.push("The target type is not instantiable, but copied assets use it.");
  const sourceVars = index.ancestorTypesOf(uid).reduce((list, t) => [...list, ...t.variables], def.variables);
  const targetVars = chain.flatMap((t) => (t.variables ?? []).filter(isOwn));
  problems.push(...varsCompatible(sourceVars, targetVars, def.name));
  const targetAspects = new Map(chain.flatMap((t) => (t.aspects ?? []).filter(isOwn)).map((a) => [lc(a.name), a]));
  const sourceAspects = [def, ...index.ancestorTypesOf(uid)].flatMap((t) => t.aspects);
  for (const a of sourceAspects) {
    const ta = targetAspects.get(lc(a.name));
    if (!ta) {
      problems.push(`Aspect "${a.name}" does not exist in the target type.`);
      continue;
    }
    const expected = aspectTargetId(a.aspectType, resolutions);
    if (expected === undefined) {
      problems.push(`Aspect "${a.name}" uses an aspect type that would be newly created; it cannot match the existing target aspect.`);
    } else if (lc(ta.aspectType?.id ?? "") !== lc(expected)) {
      problems.push(`Aspect "${a.name}" uses ${ta.aspectType?.id} in the target (source ${expected}).`);
    }
  }
  return problems;
}

function aspectTargetId(ref: TypeRef, resolutions: ReadonlyMap<string, Resolution>): string | undefined {
  if (ref.kind !== "project") return ref.id;
  const r = resolutions.get(ref.uid);
  return r?.action === "map" ? r.targetId : undefined;
}

/**
 * Apply resolutions: renamed types get the new id/name; mapped types are
 * removed and every reference to them points at the existing target type.
 */
export function applyResolutions(project: Project, resolutions: ReadonlyMap<string, Resolution>): Project {
  const p = structuredClone(project);
  const mapped = new Map<string, string>();
  for (const [uid, r] of resolutions) if (r.action === "map") mapped.set(uid, r.targetId);
  const remap = (ref: TypeRef): TypeRef => {
    if (ref.kind !== "project") return ref;
    const id = mapped.get(ref.uid);
    if (!id) return ref;
    return lc(id).startsWith("core.") ? { kind: "core", id } : { kind: "external", id };
  };
  for (const t of p.aspectTypes) {
    const r = resolutions.get(t.uid);
    if (r?.action === "rename") {
      t.idSuffix = r.idSuffix;
      t.name = r.name;
    }
  }
  for (const t of p.assetTypes) {
    const r = resolutions.get(t.uid);
    if (r?.action === "rename") {
      t.idSuffix = r.idSuffix;
      t.name = r.name;
    }
    t.parent = remap(t.parent);
    for (const a of t.aspects) a.aspectType = remap(a.aspectType);
  }
  for (const a of p.assets) a.type = remap(a.type);
  p.aspectTypes = p.aspectTypes.filter((t) => !mapped.has(t.uid));
  p.assetTypes = p.assetTypes.filter((t) => !mapped.has(t.uid));
  return p;
}

// ---------------------------------------------------------------------------
// File contents for copied files
// ---------------------------------------------------------------------------

export interface ContentStore {
  put(blob: Blob): Promise<string>;
}

/**
 * Download the contents of `files` from the source tenant (GET /files/{id}/file)
 * into `store` and update the FileDefs in place. Returns warnings for files
 * that could not be downloaded (they stay without content and are blocked in
 * the plan).
 */
export async function fetchFileContents(
  files: FileDef[],
  sourceIdOf: (uid: string) => string | undefined,
  transport: Pick<Transport, "downloadFile">,
  store: ContentStore,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<string[]> {
  const warnings: string[] = [];
  let done = 0;
  for (const f of files) {
    onProgress?.(done, files.length, f.name);
    const id = sourceIdOf(f.uid);
    if (!id) {
      warnings.push(`${f.name}: the source file id is unknown.`);
      done++;
      continue;
    }
    try {
      const res = await transport.downloadFile(id);
      if (res.status >= 400) {
        warnings.push(`${f.name}: download failed (HTTP ${res.status}).`);
      } else {
        const blob = base64ToBlob(res.body.contentBase64, res.body.mimeType);
        f.blobId = await store.put(blob);
        f.size = blob.size;
        f.mimeType = res.body.mimeType || f.mimeType;
        f.sha256 = await sha256Hex(blob);
      }
    } catch (e) {
      warnings.push(`${f.name}: download failed (${e instanceof Error ? e.message : String(e)}).`);
    }
    done++;
  }
  onProgress?.(done, files.length, "");
  return warnings;
}

/**
 * Problems with a rename resolution. Messages about the id start with "Id",
 * messages about the name with "Name".
 */
export function renameProblems(
  kind: "aspectType" | "assetType",
  uid: string,
  rename: { idSuffix: string; name: string },
  project: Project,
  tenant: string,
  target: TenantSnapshot,
  resolutions: ReadonlyMap<string, Resolution>,
): string[] {
  const problems: string[] = [];
  const id = composeTypeId(tenant, rename.idSuffix);
  if (!PATTERNS.typeIdSuffix.test(rename.idSuffix)) problems.push("Id may only contain A–Z, a–z, 0–9 and _.");
  else if (rename.idSuffix.length > MAX_ID_SUFFIX) problems.push(`Id is longer than ${MAX_ID_SUFFIX} characters.`);
  const namePattern = kind === "aspectType" ? PATTERNS.aspectTypeName : PATTERNS.assetTypeName;
  if (!rename.name || !namePattern.test(rename.name)) {
    problems.push(kind === "aspectType" ? "Name may only contain letters, digits and _." : "Name may only contain letters, digits, _, . and spaces.");
  } else if (rename.name.length > LIMITS.typeNameMax) problems.push(`Name is longer than ${LIMITS.typeNameMax} characters.`);
  const existing = kind === "aspectType" ? target.aspectTypes.tenant : target.assetTypes.tenant;
  if (existing.some((t) => lc(t.id) === lc(id))) problems.push(`Id ${id} already exists in the target.`);
  if (existing.some((t) => lc(t.name) === lc(rename.name))) problems.push(`Name "${rename.name}" already exists in the target.`);
  const siblings = (kind === "aspectType" ? project.aspectTypes : project.assetTypes).filter((t) => t.uid !== uid && resolutions.get(t.uid)?.action !== "map");
  const finalOf = (t: { uid: string; idSuffix: string; name: string }) => {
    const r = resolutions.get(t.uid);
    return r?.action === "rename" ? r : t;
  };
  if (siblings.some((t) => lc(finalOf(t).idSuffix) === lc(rename.idSuffix))) problems.push("Id is used by another copied type.");
  if (siblings.some((t) => lc(finalOf(t).name) === lc(rename.name))) problems.push("Name is used by another copied type.");
  return problems;
}
