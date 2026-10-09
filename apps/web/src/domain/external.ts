// Existing (non-core) types of a tenant, as read into a tenant catalog.
//
// Projects reference such types with TypeRef `{ kind: "external", id }`. When a
// catalog is available, ModelIndex resolves those references with the real
// definitions (variables, aspects, parent chain), so validation, attribute
// estimates and pickers work with existing tenant types too. Shapes reuse the
// core library types: an existing type is described exactly like a core type,
// only it is billable and owned by a tenant.

import type { CoreAspectType, CoreAssetType } from "./coreLibrary";

export interface ExternalTypes {
  /** Tenant the types were read from (type ids are `<tenant>.<id>`). */
  tenant: string;
  /** Display name of the connection the catalog was read from. */
  source: string;
  readAt: string;
  assetTypes: CoreAssetType[];
  aspectTypes: CoreAspectType[];
  assetType(id: string): CoreAssetType | undefined;
  aspectType(id: string): CoreAspectType | undefined;
}

export function indexExternalTypes(input: {
  tenant: string;
  source: string;
  readAt: string;
  assetTypes: CoreAssetType[];
  aspectTypes: CoreAspectType[];
}): ExternalTypes {
  const assetTypes = new Map(input.assetTypes.map((t) => [t.id.toLowerCase(), t]));
  const aspectTypes = new Map(input.aspectTypes.map((t) => [t.id.toLowerCase(), t]));
  return {
    ...input,
    assetType: (id) => assetTypes.get(id.toLowerCase()),
    aspectType: (id) => aspectTypes.get(id.toLowerCase()),
  };
}
