// Impact analysis before deletes and before type changes that affect
// instances. Pure functions work on already loaded lists; the async ones
// count instances with listAll filters (typeId / hasType / parentId / fileId).

import type {
  AmAspectTypeResource,
  AmAssetResource,
  AmAssetTypeResource,
  AmFileMetadata,
} from "@/api/amTypes";
import { isCoreId } from "@/domain/coreLibrary";
import { mapWithConcurrency } from "./batch";
import { buildFilter } from "./filters";
import type { AmTransport } from "./transport";

export interface ImpactItem {
  id: string;
  label: string;
  detail?: string;
}

export interface ImpactGroup {
  title: string;
  /** Total number of affected objects (may exceed items.length). */
  total: number;
  items: ImpactItem[];
  /** The count could not be determined completely (partial list failure). */
  incomplete?: boolean;
}

export interface Impact {
  /** The operation must not run (the platform would reject it or it is not allowed). */
  blocked: boolean;
  /** Why it is blocked, or warnings to show. */
  reasons: string[];
  groups: ImpactGroup[];
}

const SAMPLE = 25;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Direct aspects (not inherited) of a type. */
export function directAspects(t: AmAssetTypeResource) {
  return (t.aspects ?? []).filter((a) => !a._links?.origin);
}

/** Direct variables (not inherited) of a type. */
export function directVariables(t: AmAssetTypeResource) {
  return (t.variables ?? []).filter((v) => !v._links?.origin);
}

/** Asset types whose own aspects use the aspect type. */
export function aspectTypeUsers(aspectTypeId: string, assetTypes: readonly AmAssetTypeResource[]) {
  const out: { type: AmAssetTypeResource; aspectNames: string[] }[] = [];
  for (const t of assetTypes) {
    const names = directAspects(t)
      .filter((a) => a.aspectType && same(a.aspectType.id, aspectTypeId))
      .map((a) => a.name);
    if (names.length) out.push({ type: t, aspectNames: names });
  }
  return out;
}

export function childAssetTypes(id: string, assetTypes: readonly AmAssetTypeResource[]) {
  return assetTypes.filter((t) => t.parentTypeId && same(t.parentTypeId, id));
}

/** All types derived (transitively) from `id`, cycle-safe. */
export function descendantAssetTypes(id: string, assetTypes: readonly AmAssetTypeResource[]) {
  const out: AmAssetTypeResource[] = [];
  const seen = new Set<string>([id.toLowerCase()]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of childAssetTypes(cur, assetTypes)) {
      const k = c.id.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
      queue.push(c.id);
    }
  }
  return out;
}

/** Ancestor chain of a type (parent first), cycle-safe, ids only. */
export function ancestorIds(id: string, assetTypes: readonly AmAssetTypeResource[]): string[] {
  const byId = new Map(assetTypes.map((t) => [t.id.toLowerCase(), t]));
  const out: string[] = [];
  const seen = new Set<string>([id.toLowerCase()]);
  let cur = byId.get(id.toLowerCase())?.parentTypeId;
  while (cur && !seen.has(cur.toLowerCase())) {
    out.push(cur);
    seen.add(cur.toLowerCase());
    cur = byId.get(cur.toLowerCase())?.parentTypeId;
  }
  return out;
}

/** Drop ids that descend from another id in the set (hasType on the ancestor covers them). */
export function topMostTypeIds(ids: readonly string[], assetTypes: readonly AmAssetTypeResource[]): string[] {
  const set = new Set(ids.map((i) => i.toLowerCase()));
  return ids.filter((id) => !ancestorIds(id, assetTypes).some((a) => set.has(a.toLowerCase())));
}

export interface CountResult {
  total: number;
  sample: AmAssetResource[];
  incomplete: boolean;
}

/** Count assets matching a filter (lists at most `sample` items, total from the page metadata). */
export async function countAssets(
  t: AmTransport,
  connectionId: string,
  filter: string,
  sample = SAMPLE,
): Promise<CountResult> {
  const res = await t.listAll<AmAssetResource>(connectionId, {
    resource: "assets",
    filter,
    basicFieldsOnly: true,
    maxItems: sample,
  });
  return {
    total: Math.max(res.totalElements, res.items.length),
    sample: res.items,
    incomplete: res.partialFailures.length > 0,
  };
}

function assetItems(assets: readonly AmAssetResource[]): ImpactItem[] {
  return assets.map((a) => ({
    id: a.assetId,
    label: a.name,
    detail: a.hierarchyPath?.length ? a.hierarchyPath.map((p) => p.name).join(" › ") : a.typeId,
  }));
}

function typeItems(types: readonly AmAssetTypeResource[]): ImpactItem[] {
  return types.map((x) => ({ id: x.id, label: x.name, detail: x.id }));
}

/** Delete impact of an aspect type: blocked for core types and while asset types use it. */
export function aspectTypeDeleteImpact(
  aspectType: AmAspectTypeResource,
  assetTypes: readonly AmAssetTypeResource[],
): Impact {
  const users = aspectTypeUsers(aspectType.id, assetTypes);
  const reasons: string[] = [];
  if (isCoreId(aspectType.id)) reasons.push("Core aspect types are read-only and cannot be deleted.");
  if (users.length) {
    reasons.push(
      `Used by ${users.length} asset type${users.length === 1 ? "" : "s"}. Remove the aspect from these types first ` +
        "(an aspect type can only be deleted if no asset type uses it).",
    );
  }
  return {
    blocked: reasons.length > 0,
    reasons,
    groups: users.length
      ? [
          {
            title: "Asset types using this aspect type",
            total: users.length,
            items: users.map((u) => ({ id: u.type.id, label: u.type.name, detail: `aspects: ${u.aspectNames.join(", ")}` })),
          },
        ]
      : [],
  };
}

/**
 * Delete impact of an asset type: blocked for core types, while child types
 * exist (parentTypeId) and while assets instantiate it (filter typeId).
 * Instances of derived types (filter hasType) are reported as well.
 */
export async function assetTypeDeleteImpact(
  t: AmTransport,
  connectionId: string,
  assetType: AmAssetTypeResource,
  assetTypes: readonly AmAssetTypeResource[],
): Promise<Impact> {
  const reasons: string[] = [];
  const groups: ImpactGroup[] = [];
  if (isCoreId(assetType.id)) reasons.push("Core asset types are read-only and cannot be deleted.");
  const children = childAssetTypes(assetType.id, assetTypes);
  if (children.length) {
    reasons.push(`Has ${children.length} child type${children.length === 1 ? "" : "s"}; delete or re-parent them first.`);
    groups.push({ title: "Child asset types", total: children.length, items: typeItems(children) });
  }
  const [direct, all] = await Promise.all([
    countAssets(t, connectionId, buildFilter({ typeId: assetType.id })!),
    countAssets(t, connectionId, buildFilter({ hasType: assetType.id })!),
  ]);
  if (direct.total > 0) {
    reasons.push(`${direct.total} asset${direct.total === 1 ? "" : "s"} instantiate this type; delete them first.`);
    groups.push({ title: "Assets of this type", total: direct.total, items: assetItems(direct.sample), incomplete: direct.incomplete });
  }
  const derived = all.total - direct.total;
  if (derived > 0) {
    groups.push({
      title: "Assets of derived types",
      total: derived,
      items: assetItems(all.sample.filter((a) => !same(a.typeId, assetType.id))),
      incomplete: all.incomplete,
    });
  }
  return { blocked: reasons.length > 0, reasons, groups };
}

/** Instances affected by a change to an asset type (the type and all derived types: hasType). */
export async function assetTypeChangeImpact(
  t: AmTransport,
  connectionId: string,
  assetType: AmAssetTypeResource,
  assetTypes: readonly AmAssetTypeResource[],
): Promise<Impact> {
  const derived = descendantAssetTypes(assetType.id, assetTypes);
  const all = await countAssets(t, connectionId, buildFilter({ hasType: assetType.id })!);
  const groups: ImpactGroup[] = [
    { title: "Affected assets (this type and derived types)", total: all.total, items: assetItems(all.sample), incomplete: all.incomplete },
  ];
  if (derived.length) groups.push({ title: "Derived asset types", total: derived.length, items: typeItems(derived) });
  return { blocked: false, reasons: [], groups };
}

/**
 * Instances affected by a change to an aspect type: every asset type using it
 * (directly or by inheritance) and the assets of those types. Counted with
 * hasType on the top-most using types (at most 4 requests in flight).
 */
export async function aspectTypeChangeImpact(
  t: AmTransport,
  connectionId: string,
  aspectTypeId: string,
  assetTypes: readonly AmAssetTypeResource[],
): Promise<Impact> {
  const users = aspectTypeUsers(aspectTypeId, assetTypes).map((u) => u.type);
  const inheriting = new Map<string, AmAssetTypeResource>();
  for (const u of users) {
    inheriting.set(u.id.toLowerCase(), u);
    for (const d of descendantAssetTypes(u.id, assetTypes)) inheriting.set(d.id.toLowerCase(), d);
  }
  const roots = topMostTypeIds(users.map((u) => u.id), assetTypes);
  const counts = await mapWithConcurrency(roots, 4, (id) => countAssets(t, connectionId, buildFilter({ hasType: id })!));
  const total = counts.reduce((s, c) => s + c.total, 0);
  const sample = counts.flatMap((c) => c.sample).slice(0, SAMPLE);
  return {
    blocked: false,
    reasons: [],
    groups: [
      { title: "Asset types using it (incl. derived types)", total: inheriting.size, items: typeItems([...inheriting.values()]) },
      { title: "Affected assets", total, items: assetItems(sample), incomplete: counts.some((c) => c.incomplete) },
    ],
  };
}

/** Delete impact of an asset: the root cannot be deleted, nor an asset with children. */
export async function assetDeleteImpact(t: AmTransport, connectionId: string, asset: AmAssetResource): Promise<Impact> {
  const reasons: string[] = [];
  const groups: ImpactGroup[] = [];
  if (!asset.parentId) {
    reasons.push("The root asset cannot be deleted (it is removed together with the tenant).");
    return { blocked: true, reasons, groups };
  }
  const children = await countAssets(t, connectionId, buildFilter({ parentId: asset.assetId })!);
  if (children.total > 0) {
    reasons.push(`Has ${children.total} child asset${children.total === 1 ? "" : "s"}; delete or move them first.`);
    groups.push({ title: "Child assets", total: children.total, items: assetItems(children.sample), incomplete: children.incomplete });
  }
  if (asset.fileAssignments?.length) {
    groups.push({
      title: "File assignments removed with the asset",
      total: asset.fileAssignments.length,
      items: asset.fileAssignments.map((f) => ({ id: f.key, label: f.key, detail: `file ${f.fileId}` })),
    });
  }
  return { blocked: reasons.length > 0, reasons, groups };
}

/**
 * Delete impact of a file: blocked while it is assigned (isAssigned). Lists
 * the asset types (from the loaded list) and the assets (filter fileId,
 * verified client-side) that reference it.
 */
export async function fileDeleteImpact(
  t: AmTransport,
  connectionId: string,
  file: AmFileMetadata,
  assetTypes: readonly AmAssetTypeResource[],
): Promise<Impact> {
  const types = assetTypes.filter((x) => (x.fileAssignments ?? []).some((f) => f.fileId === file.id && !f._links?.origin));
  const groups: ImpactGroup[] = [];
  let assets: AmAssetResource[] = [];
  let incomplete = false;
  if (file.isAssigned) {
    const res = await t.listAll<AmAssetResource>(connectionId, {
      resource: "assets",
      filter: buildFilter({ fileId: file.id }),
      maxItems: 200,
    });
    assets = res.items.filter((a) => (a.fileAssignments ?? []).some((f) => f.fileId === file.id));
    incomplete = res.partialFailures.length > 0;
  }
  if (types.length) {
    groups.push({
      title: "Asset types with this file",
      total: types.length,
      items: types.map((x) => ({
        id: x.id,
        label: x.name,
        detail: `keys: ${(x.fileAssignments ?? []).filter((f) => f.fileId === file.id).map((f) => f.key).join(", ")}`,
      })),
    });
  }
  if (assets.length) {
    groups.push({
      title: "Assets with this file",
      total: assets.length,
      items: assets.slice(0, SAMPLE).map((a) => ({
        id: a.assetId,
        label: a.name,
        detail: `keys: ${a.fileAssignments.filter((f) => f.fileId === file.id).map((f) => f.key).join(", ")}`,
      })),
      incomplete,
    });
  }
  const reasons: string[] = [];
  if (file.isAssigned) {
    reasons.push("The file is assigned to assets or asset types. Remove the file assignments first (deletion is blocked by the platform).");
  }
  return { blocked: !!file.isAssigned, reasons, groups };
}
