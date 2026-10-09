// Editing operations on a Project.
//
// Every mutating operation takes a *draft* (an Immer draft or a fresh copy)
// and edits it in place, so the project store can record patches for
// undo/redo. Operations that need structural lookups receive a ModelIndex
// built from the revision before the edit (uids are stable, so that is safe).
//
// Operations enforce the same invariants the API does (root cannot be
// deleted, no cycles, a type with children/instances cannot be deleted) and
// throw DomainError otherwise, so UIs can surface the message.

import {
  ROOT_ASSET_UID,
  newUid,
  nowIso,
  type AspectCategory,
  type AspectTypeDef,
  type AssetDef,
  type AssetTypeDef,
  type DataType,
  type Project,
  type TypeRef,
  type VariableDef,
} from "./model";
import type { ModelIndex } from "./resolve";
import { BASIC_ASSET_TYPE_ID } from "./coreLibrary";

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

const lc = (s: string) => s.toLowerCase();

/** Returns `base` or `base_2`, `base_3`, … so it does not collide (case-insensitive). */
export function uniqueName(base: string, existing: Iterable<string>, separator = "_"): string {
  const taken = new Set([...existing].map(lc));
  if (!taken.has(lc(base))) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}${separator}${i}`;
    if (!taken.has(lc(candidate))) return candidate;
  }
}

/** Turn a display name into a valid id suffix / variable-like identifier. */
export function toIdentifier(name: string, fallback = "item"): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

export function touch(d: Project, summary?: string, author?: string): void {
  const at = nowIso();
  d.updatedAt = at;
  if (summary) d.changelog.push({ at, summary, ...(author ? { author } : {}) });
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function newVariable(name: string, dataType: DataType = "STRING"): VariableDef {
  return {
    uid: newUid(),
    name,
    dataType,
    searchable: false,
    ...(dataType === "STRING" ? { length: 255 } : {}),
  };
}

export function newAspectType(project: Project, name = "NewAspect", category: AspectCategory = "dynamic"): AspectTypeDef {
  const n = uniqueName(name, project.aspectTypes.map((t) => t.name));
  const id = uniqueName(toIdentifier(n), project.aspectTypes.map((t) => t.idSuffix));
  return {
    uid: newUid(),
    idSuffix: id,
    name: n,
    category,
    variables: [newVariable("value", category === "dynamic" ? "DOUBLE" : "STRING")],
  };
}

export function newAssetType(
  project: Project,
  name = "NewAssetType",
  parent: TypeRef = { kind: "core", id: BASIC_ASSET_TYPE_ID },
): AssetTypeDef {
  const n = uniqueName(name, project.assetTypes.map((t) => t.name));
  const id = uniqueName(toIdentifier(n), project.assetTypes.map((t) => t.idSuffix));
  return {
    uid: newUid(),
    idSuffix: id,
    name: n,
    parent,
    instantiable: true,
    variables: [],
    aspects: [],
    fileAssignments: [],
  };
}

export function newAsset(name: string, type: TypeRef, parentUid: string): AssetDef {
  return {
    uid: newUid(),
    name,
    type,
    parentUid,
    twinType: "performance",
    variables: [],
    aspects: [],
    fileAssignments: [],
  };
}

// ---------------------------------------------------------------------------
// Impact analysis
// ---------------------------------------------------------------------------

export interface BlastRadius {
  /** Asset types whose effective definition changes. */
  assetTypes: AssetTypeDef[];
  /** Assets that carry the variable. */
  assets: number;
  /** Assets that have an explicit value for the variable (lost on delete). */
  assetsWithValues: number;
}

function assetTypesUsingAspectType(index: ModelIndex, aspectTypeUid: string): AssetTypeDef[] {
  const direct = index.aspectTypeUsage(aspectTypeUid).map((u) => u.assetType);
  const all = new Map<string, AssetTypeDef>();
  for (const t of direct) {
    all.set(t.uid, t);
    for (const d of index.descendantTypesOf(t.uid)) all.set(d.uid, d);
  }
  return [...all.values()];
}

/** Impact of deleting/changing a variable of an asset type (incl. descendants). */
export function assetTypeVariableBlastRadius(index: ModelIndex, typeUid: string, variableName: string): BlastRadius {
  const self = index.assetTypes.get(typeUid);
  const types = [...(self ? [self] : []), ...index.descendantTypesOf(typeUid)];
  const assets = index.assetsOfType({ kind: "project", uid: typeUid }, true);
  const name = lc(variableName);
  return {
    assetTypes: types,
    assets: assets.length,
    assetsWithValues: assets.filter((a) => a.variables.some((v) => lc(v.name) === name)).length,
  };
}

/** Impact of deleting/changing a variable of an aspect type. */
export function aspectTypeVariableBlastRadius(index: ModelIndex, aspectTypeUid: string, variableName: string): BlastRadius {
  const types = assetTypesUsingAspectType(index, aspectTypeUid);
  const aspectNames = new Set<string>();
  for (const u of index.aspectTypeUsage(aspectTypeUid)) aspectNames.add(lc(u.aspectName));
  const assetSet = new Map<string, AssetDef>();
  for (const t of index.aspectTypeUsage(aspectTypeUid).map((u) => u.assetType)) {
    for (const a of index.assetsOfType({ kind: "project", uid: t.uid }, true)) assetSet.set(a.uid, a);
  }
  const name = lc(variableName);
  let withValues = 0;
  for (const a of assetSet.values()) {
    if (a.aspects.some((av) => aspectNames.has(lc(av.name)) && av.variables.some((v) => lc(v.name) === name))) withValues++;
  }
  return { assetTypes: types, assets: assetSet.size, assetsWithValues: withValues };
}

export interface TypeDeletionImpact {
  childTypes: AssetTypeDef[];
  assets: AssetDef[];
  blocked: boolean;
}

/** The API only deletes an asset type without child types and instances. */
export function assetTypeDeletionImpact(index: ModelIndex, typeUid: string): TypeDeletionImpact {
  const childTypes = index.childTypesOf(typeUid);
  const assets = index.assetsOfType({ kind: "project", uid: typeUid }, false);
  return { childTypes, assets, blocked: childTypes.length > 0 || assets.length > 0 };
}

/** The API only deletes an aspect type no asset type uses. */
export function aspectTypeDeletionImpact(index: ModelIndex, aspectTypeUid: string) {
  const usages = index.aspectTypeUsage(aspectTypeUid);
  return { usages, blocked: usages.length > 0 };
}

// ---------------------------------------------------------------------------
// Aspect types
// ---------------------------------------------------------------------------

function findAspectType(d: Project, uid: string): AspectTypeDef {
  const t = d.aspectTypes.find((x) => x.uid === uid);
  if (!t) throw new DomainError("Aspect type not found.");
  return t;
}

function findAssetType(d: Project, uid: string): AssetTypeDef {
  const t = d.assetTypes.find((x) => x.uid === uid);
  if (!t) throw new DomainError("Asset type not found.");
  return t;
}

/** Aspect names (lower case) of asset types that use the aspect type. */
function aspectNamesUsing(d: Project, aspectTypeUid: string): Set<string> {
  const names = new Set<string>();
  for (const t of d.assetTypes) {
    for (const a of t.aspects) {
      if (a.aspectType.kind === "project" && a.aspectType.uid === aspectTypeUid) names.add(lc(a.name));
    }
  }
  return names;
}

export function deleteAspectType(d: Project, index: ModelIndex, uid: string): void {
  const impact = aspectTypeDeletionImpact(index, uid);
  if (impact.blocked) {
    throw new DomainError(
      `Aspect type is used by ${impact.usages.map((u) => `${u.assetType.name}.${u.aspectName}`).join(", ")}; remove those aspects first.`,
    );
  }
  d.aspectTypes = d.aspectTypes.filter((t) => t.uid !== uid);
}

export function renameAspectTypeVariable(d: Project, aspectTypeUid: string, varUid: string, newName: string): void {
  const t = findAspectType(d, aspectTypeUid);
  const v = t.variables.find((x) => x.uid === varUid);
  if (!v) throw new DomainError("Variable not found.");
  const old = lc(v.name);
  if (old === lc(newName) && v.name === newName) return;
  if (t.variables.some((x) => x.uid !== varUid && lc(x.name) === lc(newName))) {
    throw new DomainError(`A variable named "${newName}" already exists.`);
  }
  v.name = newName;
  const aspectNames = aspectNamesUsing(d, aspectTypeUid);
  for (const a of d.assets) {
    for (const av of a.aspects) {
      if (!aspectNames.has(lc(av.name))) continue;
      for (const val of av.variables) if (lc(val.name) === old) val.name = newName;
    }
  }
}

export function deleteAspectTypeVariable(d: Project, aspectTypeUid: string, varUid: string): void {
  const t = findAspectType(d, aspectTypeUid);
  const v = t.variables.find((x) => x.uid === varUid);
  if (!v) return;
  if (t.variables.length === 1) throw new DomainError("An aspect type needs at least one variable.");
  t.variables = t.variables.filter((x) => x.uid !== varUid);
  const aspectNames = aspectNamesUsing(d, aspectTypeUid);
  const name = lc(v.name);
  for (const a of d.assets) {
    for (const av of a.aspects) {
      if (aspectNames.has(lc(av.name))) av.variables = av.variables.filter((x) => lc(x.name) !== name);
    }
  }
}

// ---------------------------------------------------------------------------
// Asset types
// ---------------------------------------------------------------------------

/** uids of the type and all its descendant project types. */
function typeAndDescendants(index: ModelIndex, typeUid: string): Set<string> {
  return new Set([typeUid, ...index.descendantTypesOf(typeUid).map((t) => t.uid)]);
}

function assetsOfTypes(d: Project, typeUids: Set<string>): AssetDef[] {
  return d.assets.filter((a) => a.type.kind === "project" && typeUids.has(a.type.uid));
}

export function deleteAssetType(d: Project, index: ModelIndex, uid: string): void {
  const impact = assetTypeDeletionImpact(index, uid);
  if (impact.blocked) {
    throw new DomainError(
      `Cannot delete: ${impact.childTypes.length} child type(s) and ${impact.assets.length} asset(s) still use this type.`,
    );
  }
  d.assetTypes = d.assetTypes.filter((t) => t.uid !== uid);
}

export function renameAssetTypeVariable(
  d: Project,
  index: ModelIndex,
  typeUid: string,
  varUid: string,
  newName: string,
): void {
  const t = findAssetType(d, typeUid);
  const v = t.variables.find((x) => x.uid === varUid);
  if (!v) throw new DomainError("Variable not found.");
  if (t.variables.some((x) => x.uid !== varUid && lc(x.name) === lc(newName))) {
    throw new DomainError(`A variable named "${newName}" already exists.`);
  }
  const old = lc(v.name);
  v.name = newName;
  for (const a of assetsOfTypes(d, typeAndDescendants(index, typeUid))) {
    for (const val of a.variables) if (lc(val.name) === old) val.name = newName;
  }
}

/** Deleting a variable also removes the values overridden on asset instances. */
export function deleteAssetTypeVariable(d: Project, index: ModelIndex, typeUid: string, varUid: string): void {
  const t = findAssetType(d, typeUid);
  const v = t.variables.find((x) => x.uid === varUid);
  if (!v) return;
  t.variables = t.variables.filter((x) => x.uid !== varUid);
  const name = lc(v.name);
  for (const a of assetsOfTypes(d, typeAndDescendants(index, typeUid))) {
    a.variables = a.variables.filter((x) => lc(x.name) !== name);
  }
}

export function renameAspect(d: Project, index: ModelIndex, typeUid: string, aspectUid: string, newName: string): void {
  const t = findAssetType(d, typeUid);
  const asp = t.aspects.find((x) => x.uid === aspectUid);
  if (!asp) throw new DomainError("Aspect not found.");
  if (t.aspects.some((x) => x.uid !== aspectUid && lc(x.name) === lc(newName))) {
    throw new DomainError(`An aspect named "${newName}" already exists.`);
  }
  const old = lc(asp.name);
  asp.name = newName;
  for (const a of assetsOfTypes(d, typeAndDescendants(index, typeUid))) {
    for (const av of a.aspects) if (lc(av.name) === old) av.name = newName;
  }
}

export function removeAspect(d: Project, index: ModelIndex, typeUid: string, aspectUid: string): void {
  const t = findAssetType(d, typeUid);
  const asp = t.aspects.find((x) => x.uid === aspectUid);
  if (!asp) return;
  t.aspects = t.aspects.filter((x) => x.uid !== aspectUid);
  const name = lc(asp.name);
  for (const a of assetsOfTypes(d, typeAndDescendants(index, typeUid))) {
    a.aspects = a.aspects.filter((x) => lc(x.name) !== name);
  }
}

/**
 * "Delete and recreate": dataType and searchable are immutable once created,
 * so the variable is replaced by a new one (new uid, no baseline). Values
 * stored on assets are removed because they belong to the old variable.
 */
export function recreateVariable(
  d: Project,
  index: ModelIndex,
  owner: { kind: "aspectType" | "assetType"; uid: string },
  varUid: string,
  changes: Partial<Pick<VariableDef, "dataType" | "searchable" | "length" | "unit" | "defaultValue" | "qualityCode">>,
): VariableDef {
  const list = owner.kind === "aspectType" ? findAspectType(d, owner.uid).variables : findAssetType(d, owner.uid).variables;
  const pos = list.findIndex((x) => x.uid === varUid);
  if (pos < 0) throw new DomainError("Variable not found.");
  const old = list[pos]!;
  const replacement: VariableDef = {
    uid: newUid(),
    name: old.name,
    dataType: changes.dataType ?? old.dataType,
    searchable: changes.searchable ?? old.searchable,
    unit: "unit" in changes ? changes.unit : old.unit,
    qualityCode: "qualityCode" in changes ? changes.qualityCode : old.qualityCode,
    notes: old.notes,
  };
  const dt = replacement.dataType;
  const length = "length" in changes ? changes.length : old.length;
  if ((dt === "STRING" || dt === "BIG_STRING") && length !== undefined) replacement.length = length;
  const dv = "defaultValue" in changes ? changes.defaultValue : undefined;
  if (dv !== undefined) replacement.defaultValue = dv;
  for (const k of Object.keys(replacement) as (keyof VariableDef)[]) {
    if (replacement[k] === undefined) delete replacement[k];
  }
  list.splice(pos, 1, replacement);

  const name = lc(old.name);
  if (owner.kind === "assetType") {
    for (const a of assetsOfTypes(d, typeAndDescendants(index, owner.uid))) {
      a.variables = a.variables.filter((x) => lc(x.name) !== name);
    }
  } else {
    const aspectNames = aspectNamesUsing(d, owner.uid);
    for (const a of d.assets) {
      for (const av of a.aspects) {
        if (aspectNames.has(lc(av.name))) av.variables = av.variables.filter((x) => lc(x.name) !== name);
      }
    }
  }
  return replacement;
}

// ---------------------------------------------------------------------------
// Assets & hierarchy
// ---------------------------------------------------------------------------

function findAsset(d: Project, uid: string): AssetDef {
  const a = d.assets.find((x) => x.uid === uid);
  if (!a) throw new DomainError("Asset not found.");
  return a;
}

/** Move an asset (with its subtree) under a new parent. */
export function moveAsset(d: Project, index: ModelIndex, uid: string, newParentUid: string): void {
  if (uid === ROOT_ASSET_UID) throw new DomainError("The tenant root cannot be moved.");
  if (uid === newParentUid) throw new DomainError("An asset cannot be its own parent.");
  if (!index.assets.has(newParentUid)) throw new DomainError("Target parent not found.");
  if (index.descendantsOf(uid).includes(newParentUid)) {
    throw new DomainError("An asset cannot be moved into its own subtree.");
  }
  findAsset(d, uid).parentUid = newParentUid;
}

/** Delete an asset and its whole subtree. The root cannot be deleted. */
export function deleteAssetSubtree(d: Project, index: ModelIndex, uid: string): number {
  if (uid === ROOT_ASSET_UID) {
    throw new DomainError("The root asset cannot be deleted independently of its tenant.");
  }
  const remove = new Set([uid, ...index.descendantsOf(uid)]);
  d.assets = d.assets.filter((a) => !remove.has(a.uid));
  return remove.size;
}

function siblingNames(d: Project, parentUid: string): string[] {
  return d.assets.filter((a) => a.parentUid === parentUid).map((a) => a.name);
}

/**
 * Clone an asset subtree under `targetParentUid` (defaults to the original
 * parent). Clones get fresh uids, lose baselines/origins (they are new
 * objects for every tenant) and the clone root gets a unique sibling name.
 * Returns the uid of the cloned subtree root.
 */
export function cloneSubtree(d: Project, index: ModelIndex, uid: string, targetParentUid?: string): string {
  if (uid === ROOT_ASSET_UID) throw new DomainError("The tenant root cannot be cloned.");
  const source = index.assets.get(uid);
  if (!source) throw new DomainError("Asset not found.");
  const parentUid = targetParentUid ?? source.parentUid ?? ROOT_ASSET_UID;
  if (!index.assets.has(parentUid)) throw new DomainError("Target parent not found.");
  if (targetParentUid && index.descendantsOf(uid).includes(targetParentUid)) {
    throw new DomainError("Cannot clone a subtree into itself.");
  }
  const map = new Map<string, string>();
  const ordered = [uid, ...index.descendantsOf(uid)];
  for (const u of ordered) map.set(u, newUid());
  const clones: AssetDef[] = ordered.map((u) => {
    const a = index.assets.get(u)!;
    const copy: AssetDef = structuredClone(a);
    copy.uid = map.get(u)!;
    copy.parentUid = u === uid ? parentUid : map.get(a.parentUid!)!;
    delete copy.baseline;
    delete copy.origin;
    return copy;
  });
  clones[0]!.name = uniqueName(`${source.name} (copy)`, siblingNames(d, parentUid), " ");
  d.assets.push(...clones);
  return clones[0]!.uid;
}

/**
 * Expand a name template for bulk creation. `{n}` is replaced by the running
 * number, `{n:3}` pads it to 3 digits. Without a placeholder `_{n}` is appended.
 */
export function expandNameTemplate(template: string, count: number, start = 1): string[] {
  const re = /\{n(?::(\d+))?\}/g;
  const hasPlaceholder = re.test(template);
  const t = hasPlaceholder ? template : `${template}_{n}`;
  return Array.from({ length: count }, (_, i) =>
    t.replace(/\{n(?::(\d+))?\}/g, (_m, pad?: string) => String(start + i).padStart(pad ? Number(pad) : 0, "0")),
  );
}

export interface BulkAssetRow {
  name: string;
  type: TypeRef;
  parentUid: string;
  externalId?: string;
  description?: string;
  timezone?: string;
}

/** Append assets in bulk; returns the created uids. */
export function bulkCreateAssets(d: Project, rows: BulkAssetRow[]): string[] {
  const parents = new Set(d.assets.map((a) => a.uid));
  const out: string[] = [];
  for (const r of rows) {
    if (!parents.has(r.parentUid)) throw new DomainError(`Parent of "${r.name}" not found.`);
    const a = newAsset(r.name, r.type, r.parentUid);
    if (r.externalId) a.externalId = r.externalId;
    if (r.description) a.description = r.description;
    if (r.timezone) a.timezone = r.timezone;
    d.assets.push(a);
    parents.add(a.uid);
    out.push(a.uid);
  }
  return out;
}
