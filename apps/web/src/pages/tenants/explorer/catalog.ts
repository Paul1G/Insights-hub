// Tenant-wide lists shared by the explorer tabs (pickers, impact analysis).

import type { ConnectionSummary, ListResult } from "@/api/client";
import type { AmAspectTypeResource, AmAssetTypeResource, AmFileMetadata } from "@/api/amTypes";
import { useTenantList, type Loaded } from "@/online/hooks";

export interface Catalog {
  connectionId: string;
  connection: ConnectionSummary;
  tenant: string;
  aspectTypes: Loaded<ListResult<AmAspectTypeResource>>;
  assetTypes: Loaded<ListResult<AmAssetTypeResource>>;
  files: Loaded<ListResult<AmFileMetadata>>;
}

export function useCatalog(connection: ConnectionSummary | null): Catalog | null {
  const id = connection?.id ?? "";
  const enabled = !!connection;
  const aspectTypes = useTenantList<AmAspectTypeResource>(id, { resource: "aspecttypes" }, enabled);
  const assetTypes = useTenantList<AmAssetTypeResource>(id, { resource: "assettypes" }, enabled);
  const files = useTenantList<AmFileMetadata>(id, { resource: "files" }, enabled);
  if (!connection) return null;
  return { connectionId: id, connection, tenant: connection.tenant, aspectTypes, assetTypes, files };
}

export const itemsOf = <T,>(l: Loaded<ListResult<T>>): T[] => l.data?.items ?? [];
