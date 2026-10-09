// Table rows for browsing a tenant catalog (types and assets).

import type { AmAspectTypeResource, AmAssetResource, AmAssetTypeResource } from "@/api/amTypes";
import type { ProjectCorrespondence } from "@/catalog/importToProject";
import { classifyTypeId, type TenantSnapshot, type TypeOrigin } from "@/tenant/read";

const lc = (s: string) => s.toLowerCase();

export type RowStatus = "in-project" | "not-in-project" | "core";

export interface AssetTypeRow {
  id: string;
  name: string;
  origin: TypeOrigin;
  parentTypeId: string;
  instantiable: boolean;
  variables: number;
  aspects: number;
  instances: number;
  status: RowStatus;
  resource: AmAssetTypeResource;
}

export interface AspectTypeRow {
  id: string;
  name: string;
  origin: TypeOrigin;
  category: "static" | "dynamic";
  variables: number;
  usedBy: number;
  status: RowStatus;
  resource: AmAspectTypeResource;
}

export interface AssetRow {
  assetId: string;
  name: string;
  /** Root children = 1. */
  depth: number;
  /** Names from the root's children down to the asset, " / "-joined. */
  path: string;
  typeId: string;
  typeName: string;
  externalId: string;
  children: number;
  status: RowStatus;
  resource: AmAssetResource;
}

const own = (x: { _links?: { origin?: unknown } }) => !x._links?.origin;

function statusOf(origin: TypeOrigin, inProject: boolean): RowStatus {
  if (origin === "core") return "core";
  return inProject ? "in-project" : "not-in-project";
}

export function assetTypeRows(snapshot: TenantSnapshot, match?: ProjectCorrespondence): AssetTypeRow[] {
  const instances = new Map<string, number>();
  for (const a of snapshot.assets) instances.set(lc(a.typeId), (instances.get(lc(a.typeId)) ?? 0) + 1);
  const all = [...snapshot.assetTypes.tenant, ...snapshot.assetTypes.external, ...snapshot.assetTypes.core];
  return all.map((t) => {
    const origin = classifyTypeId(t.id, snapshot.tenant);
    return {
      id: t.id,
      name: t.name,
      origin,
      parentTypeId: t.parentTypeId ?? "",
      instantiable: t.instantiable !== false,
      variables: (t.variables ?? []).filter(own).length,
      aspects: (t.aspects ?? []).filter(own).length,
      instances: instances.get(lc(t.id)) ?? 0,
      status: statusOf(origin, !!match?.assetTypes.has(lc(t.id))),
      resource: t,
    };
  });
}

export function aspectTypeRows(snapshot: TenantSnapshot, match?: ProjectCorrespondence): AspectTypeRow[] {
  const usedBy = new Map<string, number>();
  for (const t of [...snapshot.assetTypes.tenant, ...snapshot.assetTypes.external, ...snapshot.assetTypes.core]) {
    for (const a of (t.aspects ?? []).filter(own)) {
      const id = a.aspectType?.id;
      if (id) usedBy.set(lc(id), (usedBy.get(lc(id)) ?? 0) + 1);
    }
  }
  const all = [...snapshot.aspectTypes.tenant, ...snapshot.aspectTypes.external, ...snapshot.aspectTypes.core];
  return all.map((t) => {
    const origin = classifyTypeId(t.id, snapshot.tenant);
    return {
      id: t.id,
      name: t.name,
      origin,
      category: t.category,
      variables: (t.variables ?? []).length,
      usedBy: usedBy.get(lc(t.id)) ?? 0,
      status: statusOf(origin, !!match?.aspectTypes.has(lc(t.id))),
      resource: t,
    };
  });
}

/** Assets in hierarchy order (depth-first, siblings by name). Detached assets come last. */
export function assetRows(snapshot: TenantSnapshot, match?: ProjectCorrespondence): AssetRow[] {
  const typeNames = new Map<string, string>();
  for (const t of [...snapshot.assetTypes.tenant, ...snapshot.assetTypes.external, ...snapshot.assetTypes.core]) {
    typeNames.set(lc(t.id), t.name);
  }
  const children = new Map<string, AmAssetResource[]>();
  for (const a of snapshot.assets) {
    if (!a.parentId) continue;
    const list = children.get(a.parentId) ?? [];
    list.push(a);
    children.set(a.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const out: AssetRow[] = [];
  const seen = new Set<string>();
  const row = (a: AmAssetResource, depth: number, path: string): AssetRow => ({
    assetId: a.assetId,
    name: a.name,
    depth,
    path,
    typeId: a.typeId,
    typeName: typeNames.get(lc(a.typeId)) ?? a.typeId,
    externalId: a.externalId ?? "",
    children: children.get(a.assetId)?.length ?? 0,
    status: match?.assets.has(a.assetId) ? "in-project" : "not-in-project",
    resource: a,
  });
  const stack: [AmAssetResource, number, string][] = [...(children.get(snapshot.root.assetId) ?? [])]
    .reverse()
    .map((a) => [a, 1, a.name]);
  while (stack.length) {
    const [a, depth, path] = stack.pop()!;
    if (seen.has(a.assetId)) continue;
    seen.add(a.assetId);
    out.push(row(a, depth, path));
    const kids = children.get(a.assetId) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, depth + 1, `${path} / ${kids[i]!.name}`]);
  }
  for (const a of snapshot.assets) if (!seen.has(a.assetId)) out.push(row(a, 0, `(not connected) ${a.name}`));
  return out;
}

export const ORIGIN_LABEL: Record<TypeOrigin, string> = {
  tenant: "Tenant",
  external: "Shared / other tenant",
  core: "Core (OOTB)",
};

export const STATUS_LABEL: Record<RowStatus, string> = {
  "in-project": "In project",
  "not-in-project": "Not in project",
  core: "Core",
};
