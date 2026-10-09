// Import existing tenant objects (types and assets) into an existing project.
//
// The tenant catalog's snapshot is converted with the backup converter
// (baselines set, origin "tenant"), then only the selected objects plus what
// they depend on are merged into the project:
//   - asset types bring their tenant parent chain and the tenant aspect types
//     of their own aspects;
//   - assets bring their ancestors (so the hierarchy stays connected),
//     optionally their whole subtrees, and optionally their tenant types.
// Objects the project already contains — known through the deployment mapping
// or matched by natural key (type id; parent + name for assets) — are not
// imported again; references point to the existing project entities instead.
// Mapping entries for imported objects are recorded for the source
// connection, flagged `imported`, so a later deployment updates them instead of
// creating duplicates, and sync mode never deletes them.

import type { AmAssetResource } from "@/api/amTypes";
import { emptyMapping } from "@/deploy/mapping";
import { ROOT_ASSET_UID, splitTypeId, type AspectTypeDef, type AssetDef, type AssetTypeDef, type Project, type TypeRef } from "@/domain/model";
import type { MappingEntry, MappingRecord } from "@/storage/db";
import { snapshotToProject } from "@/tenant/convert";
import { classifyTypeId, type TenantSnapshot } from "@/tenant/read";

const lc = (s: string) => s.toLowerCase();

export interface ImportSelection {
  aspectTypeIds: string[];
  assetTypeIds: string[];
  /** Assets to import; their ancestors are added automatically. */
  assetIds: string[];
  /** Also import every descendant of the selected assets. */
  includeSubtrees: boolean;
  /** Also import the tenant types of imported assets (otherwise they are referenced as existing types). */
  includeAssetTypes: boolean;
}

export type ImportStatus = "import" | "in-project";

export interface ImportItem {
  kind: "aspectType" | "assetType" | "asset";
  tenantId: string;
  name: string;
  status: ImportStatus;
  /** Why it is part of the import ("selected", "parent of …", …). */
  reason: string;
}

export interface ImportPlan {
  items: ImportItem[];
  aspectTypes: AspectTypeDef[];
  assetTypes: AssetTypeDef[];
  assets: AssetDef[];
  mappingEntries: Record<string, MappingEntry>;
  counts: { aspectTypes: number; assetTypes: number; assets: number; alreadyInProject: number };
  warnings: string[];
}

/** Which tenant objects the project already contains (tenant id → project uid). */
export interface ProjectCorrespondence {
  aspectTypes: Map<string, string>;
  assetTypes: Map<string, string>;
  assets: Map<string, string>;
}

/**
 * Match tenant objects to project entities: deployment mapping first (entity
 * still in the project), then natural keys — `<tenant>.<idSuffix>` for types,
 * matched parent + name (case-insensitive) for assets.
 */
export function correspondence(project: Project, snapshot: TenantSnapshot, mapping: MappingRecord | undefined): ProjectCorrespondence {
  const out: ProjectCorrespondence = { aspectTypes: new Map(), assetTypes: new Map(), assets: new Map() };
  const present = {
    aspectType: new Set(project.aspectTypes.map((t) => t.uid)),
    assetType: new Set(project.assetTypes.map((t) => t.uid)),
    asset: new Set(project.assets.map((a) => a.uid)),
  };
  for (const [key, e] of Object.entries(mapping?.entries ?? {})) {
    const uid = key.slice(key.indexOf(":") + 1);
    if (e.kind === "aspectType" && present.aspectType.has(uid)) out.aspectTypes.set(lc(e.tenantId), uid);
    if (e.kind === "assetType" && present.assetType.has(uid)) out.assetTypes.set(lc(e.tenantId), uid);
    if (e.kind === "asset" && present.asset.has(uid)) out.assets.set(e.tenantId, uid);
  }
  const tenantPrefix = `${lc(snapshot.tenant)}.`;
  const bySuffix = <T extends { uid: string; idSuffix: string }>(defs: T[]) => new Map(defs.map((d) => [lc(d.idSuffix), d.uid]));
  const aspectSuffix = bySuffix(project.aspectTypes);
  const assetSuffix = bySuffix(project.assetTypes);
  for (const t of snapshot.aspectTypes.tenant) {
    const uid = lc(t.id).startsWith(tenantPrefix) ? aspectSuffix.get(lc(splitTypeId(t.id).idSuffix)) : undefined;
    if (uid && !out.aspectTypes.has(lc(t.id))) out.aspectTypes.set(lc(t.id), uid);
  }
  for (const t of snapshot.assetTypes.tenant) {
    const uid = lc(t.id).startsWith(tenantPrefix) ? assetSuffix.get(lc(splitTypeId(t.id).idSuffix)) : undefined;
    if (uid && !out.assetTypes.has(lc(t.id))) out.assetTypes.set(lc(t.id), uid);
  }

  // Assets top-down: a tenant asset matches a project child of its matched parent with the same name.
  const children = new Map<string, Map<string, string>>();
  for (const a of project.assets) {
    if (a.parentUid === null) continue;
    const m = children.get(a.parentUid) ?? new Map<string, string>();
    m.set(lc(a.name), a.uid);
    children.set(a.parentUid, m);
  }
  const tenantChildren = new Map<string, AmAssetResource[]>();
  for (const a of snapshot.assets) {
    if (!a.parentId) continue;
    const list = tenantChildren.get(a.parentId) ?? [];
    list.push(a);
    tenantChildren.set(a.parentId, list);
  }
  const queue: [string, string][] = [[snapshot.root.assetId, ROOT_ASSET_UID]];
  const visited = new Set<string>();
  while (queue.length) {
    const [tenantId, projectUid] = queue.shift()!;
    if (visited.has(tenantId)) continue;
    visited.add(tenantId);
    for (const child of tenantChildren.get(tenantId) ?? []) {
      const uid = out.assets.get(child.assetId) ?? children.get(projectUid)?.get(lc(child.name));
      if (uid) {
        out.assets.set(child.assetId, uid);
        queue.push([child.assetId, uid]);
      }
    }
  }
  return out;
}

export async function planImport(
  project: Project,
  snapshot: TenantSnapshot,
  mapping: MappingRecord | undefined,
  selection: ImportSelection,
  connectionId: string,
): Promise<ImportPlan> {
  const match = correspondence(project, snapshot, mapping);
  // Types and assets only: the tenant catalog does not hold files.
  const conversion = await snapshotToProject({ ...snapshot, files: [] }, { name: project.name, connectionId, projectId: project.id });
  const conv = conversion.project;
  const tenantIdOf = new Map<string, string>();
  for (const [id, uid] of conversion.uids.aspectTypes) tenantIdOf.set(uid, id);
  for (const [id, uid] of conversion.uids.assetTypes) tenantIdOf.set(uid, id);
  for (const [id, uid] of conversion.uids.assets) tenantIdOf.set(uid, id);

  const items = new Map<string, ImportItem>();
  const aspectWanted = new Set<string>();
  const assetTypeWanted = new Set<string>();
  const assetWanted = new Set<string>();
  const typeById = new Map(snapshot.assetTypes.tenant.map((t) => [lc(t.id), t]));
  const aspectById = new Map(snapshot.aspectTypes.tenant.map((t) => [lc(t.id), t]));
  const assetById = new Map(snapshot.assets.map((a) => [a.assetId, a]));
  const isTenant = (id: string) => classifyTypeId(id, snapshot.tenant) === "tenant";

  const note = (kind: ImportItem["kind"], tenantId: string, name: string, inProject: boolean, reason: string) => {
    const key = `${kind}:${lc(tenantId)}`;
    if (!items.has(key)) items.set(key, { kind, tenantId, name, status: inProject ? "in-project" : "import", reason });
  };

  const wantAspectType = (id: string, reason: string) => {
    const t = aspectById.get(lc(id));
    if (!t || !isTenant(t.id)) return;
    const inProject = match.aspectTypes.has(lc(t.id));
    note("aspectType", t.id, t.name, inProject, reason);
    if (!inProject) aspectWanted.add(lc(t.id));
  };
  const wantAssetType = (id: string, reason: string) => {
    let cur = typeById.get(lc(id));
    let why = reason;
    const seen = new Set<string>();
    while (cur && isTenant(cur.id) && !seen.has(lc(cur.id))) {
      seen.add(lc(cur.id));
      const inProject = match.assetTypes.has(lc(cur.id));
      note("assetType", cur.id, cur.name, inProject, why);
      if (inProject) break;
      assetTypeWanted.add(lc(cur.id));
      for (const a of cur.aspects ?? []) {
        if (!a._links?.origin && a.aspectType?.id) wantAspectType(a.aspectType.id, `aspect type of ${cur.name}`);
      }
      why = `parent of ${cur.name}`;
      cur = cur.parentTypeId ? typeById.get(lc(cur.parentTypeId)) : undefined;
    }
  };

  for (const id of selection.aspectTypeIds) wantAspectType(id, "selected");
  for (const id of selection.assetTypeIds) wantAssetType(id, "selected");

  const tenantChildren = new Map<string, AmAssetResource[]>();
  for (const a of snapshot.assets) {
    if (!a.parentId) continue;
    const list = tenantChildren.get(a.parentId) ?? [];
    list.push(a);
    tenantChildren.set(a.parentId, list);
  }
  const wantAsset = (a: AmAssetResource, reason: string) => {
    const inProject = match.assets.has(a.assetId);
    note("asset", a.assetId, a.name, inProject, reason);
    if (inProject) return;
    assetWanted.add(a.assetId);
    if (selection.includeAssetTypes && isTenant(a.typeId)) wantAssetType(a.typeId, `type of ${a.name}`);
  };
  for (const id of selection.assetIds) {
    const a = assetById.get(id);
    if (!a) continue;
    wantAsset(a, "selected");
    // Ancestors keep the imported asset attached to the hierarchy.
    let parentId = a.parentId;
    const seen = new Set<string>();
    while (parentId && parentId !== snapshot.root.assetId && !seen.has(parentId)) {
      seen.add(parentId);
      const p = assetById.get(parentId);
      if (!p) break;
      wantAsset(p, `ancestor of ${a.name}`);
      parentId = p.parentId;
    }
    if (selection.includeSubtrees) {
      const stack = [...(tenantChildren.get(a.assetId) ?? [])];
      while (stack.length) {
        const c = stack.pop()!;
        if (seen.has(c.assetId)) continue;
        seen.add(c.assetId);
        wantAsset(c, `below ${a.name}`);
        stack.push(...(tenantChildren.get(c.assetId) ?? []));
      }
    }
  }

  // Reference remapping: conversion uid → existing project uid / kept / existing-type ref.
  const remapType = (ref: TypeRef, kind: "assetType" | "aspectType"): TypeRef => {
    if (ref.kind !== "project") return ref;
    const tenantId = tenantIdOf.get(ref.uid);
    if (!tenantId) return ref;
    const existing = (kind === "assetType" ? match.assetTypes : match.aspectTypes).get(lc(tenantId));
    if (existing) return { kind: "project", uid: existing };
    const wanted = kind === "assetType" ? assetTypeWanted : aspectWanted;
    if (wanted.has(lc(tenantId))) return ref;
    return { kind: "external", id: typeById.get(lc(tenantId))?.id ?? aspectById.get(lc(tenantId))?.id ?? tenantId };
  };

  const aspectTypes = conv.aspectTypes.filter((t) => aspectWanted.has(lc(tenantIdOf.get(t.uid) ?? "")));
  const assetTypes = conv.assetTypes
    .filter((t) => assetTypeWanted.has(lc(tenantIdOf.get(t.uid) ?? "")))
    .map((t) => ({
      ...t,
      parent: remapType(t.parent, "assetType"),
      aspects: t.aspects.map((a) => ({ ...a, aspectType: remapType(a.aspectType, "aspectType") })),
    }));
  const assets = conv.assets
    .filter((a) => a.uid !== ROOT_ASSET_UID && assetWanted.has(tenantIdOf.get(a.uid) ?? ""))
    .map((a) => {
      const parentTenantId = a.parentUid ? tenantIdOf.get(a.parentUid) : undefined;
      const parentUid =
        a.parentUid === ROOT_ASSET_UID ? ROOT_ASSET_UID : parentTenantId ? match.assets.get(parentTenantId) ?? a.parentUid : a.parentUid;
      return { ...a, parentUid, type: remapType(a.type, "assetType") };
    });

  const importedUids = new Set([...aspectTypes, ...assetTypes, ...assets].map((x) => x.uid));
  const mappingEntries: Record<string, MappingEntry> = {};
  for (const [key, entry] of Object.entries(conversion.mapping.entries)) {
    const ownerUid = entry.kind === "variable" || entry.kind === "aspect" ? entry.ownerUid : key.slice(key.indexOf(":") + 1);
    if (ownerUid && importedUids.has(ownerUid)) mappingEntries[key] = entry;
  }

  const warnings: string[] = [];
  const droppedFiles = [...assetTypeWanted].some((id) => (typeById.get(id)?.fileAssignments ?? []).length > 0) ||
    [...assetWanted].some((id) => (assetById.get(id)?.fileAssignments ?? []).length > 0);
  if (droppedFiles) {
    warnings.push("File assignments are not imported: the tenant catalog does not contain files. Use “Backup tenant” to include files.");
  }
  for (const w of conversion.warnings) {
    if (/not connected to the root/.test(w)) warnings.push(w);
  }
  const projectNames = new Set(project.assetTypes.map((t) => lc(t.name)));
  for (const t of assetTypes) {
    if (projectNames.has(lc(t.name))) warnings.push(`Asset type name “${t.name}” is already used by a different project type; rename one of them.`);
  }

  const list = [...items.values()];
  return {
    items: list,
    aspectTypes,
    assetTypes,
    assets,
    mappingEntries,
    counts: {
      aspectTypes: aspectTypes.length,
      assetTypes: assetTypes.length,
      assets: assets.length,
      alreadyInProject: list.filter((i) => i.status === "in-project").length,
    },
    warnings,
  };
}

/** Merge a planned import into a project draft (run inside store.apply). */
export function applyImport(draft: Project, plan: ImportPlan): void {
  draft.aspectTypes.push(...structuredClone(plan.aspectTypes));
  draft.assetTypes.push(...structuredClone(plan.assetTypes));
  draft.assets.push(...structuredClone(plan.assets));
}

/** The mapping record after an import (entries for imported objects added). */
export function mergedMapping(
  existing: MappingRecord | undefined,
  plan: ImportPlan,
  projectId: string,
  connectionId: string,
  tenant: string,
): MappingRecord {
  const base = existing ?? emptyMapping(projectId, connectionId, tenant);
  return { ...base, entries: { ...base.entries, ...plan.mappingEntries }, updatedAt: new Date().toISOString() };
}

/** Everything in the tenant: all tenant types and every top-level asset with its subtree. */
export function selectEverything(snapshot: TenantSnapshot): ImportSelection {
  return {
    aspectTypeIds: snapshot.aspectTypes.tenant.map((t) => t.id),
    assetTypeIds: snapshot.assetTypes.tenant.map((t) => t.id),
    assetIds: snapshot.assets.filter((a) => a.parentId === snapshot.root.assetId).map((a) => a.assetId),
    includeSubtrees: true,
    includeAssetTypes: true,
  };
}

