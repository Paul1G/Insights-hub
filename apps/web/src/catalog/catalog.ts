// Tenant catalog: a cached read of a tenant's existing model (aspect types,
// asset types and assets), stored per connection in IndexedDB.
//
// The read uses the same paged reader as backups (GET lists with size=200,
// fetched concurrently by the proxy). The catalog feeds:
//   - ModelIndex (existing types resolve as `external` references),
//   - the type pickers of the editors,
//   - the Tenant model page and the Library's "Tenant types" tab (browse and
//     import existing objects into a project).

import type { AmAspectTypeResource, AmAssetTypeResource, AmVariableDefinition } from "@/api/amTypes";
import type { ConnectionSummary } from "@/api/client";
import type { CoreAspectType, CoreAssetType, CoreVariable } from "@/domain/coreLibrary";
import { indexExternalTypes, type ExternalTypes } from "@/domain/external";
import { createApiTransport, type Transport } from "@/deploy/transport";
import { db, type TenantCatalogRecord } from "@/storage/db";
import { allTypes, readTenant, type ReadProgress, type TenantSnapshot } from "@/tenant/read";

const lc = (s: string) => s.toLowerCase();

/** Members without `_links.origin` are defined on the type itself (not inherited). */
function isOwn(item: { _links?: { origin?: unknown } }): boolean {
  return !item._links?.origin;
}

function toVariable(v: AmVariableDefinition): CoreVariable {
  return {
    name: v.name,
    dataType: v.dataType,
    unit: v.unit ?? null,
    searchable: !!v.searchable,
    length: v.length ?? null,
    defaultValue: v.defaultValue ?? null,
    ...(v.qualityCode !== undefined ? { qualityCode: v.qualityCode } : {}),
  };
}

function toAspectType(t: AmAspectTypeResource): CoreAspectType {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    description: t.description ?? "",
    variables: (t.variables ?? []).map(toVariable),
  };
}

function toAssetType(t: AmAssetTypeResource): CoreAssetType {
  return {
    id: t.id,
    name: t.name,
    description: t.description ?? "",
    parentTypeId: t.parentTypeId ?? null,
    instantiable: t.instantiable !== false,
    variables: (t.variables ?? []).filter(isOwn).map(toVariable),
    aspects: (t.aspects ?? [])
      .filter(isOwn)
      .filter((a) => a.aspectType?.id)
      .map((a) => ({ name: a.name, aspectTypeId: a.aspectType.id })),
  };
}

/** Existing non-core types of a snapshot, in the shape ModelIndex resolves. */
export function externalTypesFromSnapshot(snapshot: TenantSnapshot, source: string): ExternalTypes {
  const aspectTypes = new Map<string, CoreAspectType>();
  for (const t of [...snapshot.aspectTypes.tenant, ...snapshot.aspectTypes.external]) aspectTypes.set(lc(t.id), toAspectType(t));
  const assetTypes = [...snapshot.assetTypes.tenant, ...snapshot.assetTypes.external];
  // Aspect types embedded in asset types but not listed (e.g. shared ones).
  for (const t of assetTypes) {
    for (const a of t.aspects ?? []) {
      const id = a.aspectType?.id;
      if (id && !lc(id).startsWith("core.") && !aspectTypes.has(lc(id))) aspectTypes.set(lc(id), toAspectType(a.aspectType));
    }
  }
  return indexExternalTypes({
    tenant: snapshot.tenant,
    source,
    readAt: snapshot.readAt,
    assetTypes: assetTypes.map(toAssetType),
    aspectTypes: [...aspectTypes.values()],
  });
}

export interface CatalogCounts {
  aspectTypes: number;
  assetTypes: number;
  coreAspectTypes: number;
  coreAssetTypes: number;
  assets: number;
}

export function catalogCounts(snapshot: TenantSnapshot): CatalogCounts {
  return {
    aspectTypes: snapshot.aspectTypes.tenant.length + snapshot.aspectTypes.external.length,
    assetTypes: snapshot.assetTypes.tenant.length + snapshot.assetTypes.external.length,
    coreAspectTypes: snapshot.aspectTypes.core.length,
    coreAssetTypes: snapshot.assetTypes.core.length,
    assets: snapshot.assets.length,
  };
}

/** Read the tenant behind a connection (types + assets, no files). */
export async function readCatalog(
  connection: Pick<ConnectionSummary, "id" | "name" | "tenant">,
  opts: { onProgress?: (p: ReadProgress) => void; transport?: Transport; includeShared?: boolean } = {},
): Promise<TenantCatalogRecord> {
  const snapshot = await readTenant(opts.transport ?? createApiTransport(connection.id), {
    tenant: connection.tenant,
    includeAssets: true,
    includeFiles: false,
    includeShared: opts.includeShared,
    onProgress: opts.onProgress,
  });
  return {
    connectionId: connection.id,
    connectionName: connection.name,
    tenant: connection.tenant,
    readAt: snapshot.readAt,
    snapshot,
  };
}

export async function saveCatalog(record: TenantCatalogRecord): Promise<void> {
  await db.tenantCatalogs.put(record);
}

export async function loadCatalog(connectionId: string): Promise<TenantCatalogRecord | undefined> {
  return db.tenantCatalogs.get(connectionId);
}

export async function deleteCatalog(connectionId: string): Promise<void> {
  await db.tenantCatalogs.delete(connectionId);
}

/** Asset count per type id (exact type), from the catalog's assets. */
export function instanceCounts(snapshot: TenantSnapshot): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of snapshot.assets) out.set(lc(a.typeId), (out.get(lc(a.typeId)) ?? 0) + 1);
  return out;
}

/** All types of a snapshot including core ones, for browsing. */
export function browseTypes(snapshot: TenantSnapshot) {
  return { assetTypes: allTypes(snapshot.assetTypes), aspectTypes: allTypes(snapshot.aspectTypes) };
}
