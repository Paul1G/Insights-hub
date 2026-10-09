// adapter/simulator/model defines the persisted state of one simulated
// Asset Management tenant. Shapes follow docs/reference/assetmanagement-v3.yaml;
// rendering into API resources happens in tenant.ts.

export type DataType =
  | 'BOOLEAN'
  | 'INT'
  | 'LONG'
  | 'DOUBLE'
  | 'STRING'
  | 'TIMESTAMP'
  | 'BIG_STRING';

export const DATA_TYPES: readonly DataType[] = [
  'BOOLEAN',
  'INT',
  'LONG',
  'DOUBLE',
  'STRING',
  'TIMESTAMP',
  'BIG_STRING',
];

export interface VariableDef {
  name: string;
  dataType: DataType;
  unit: string | null;
  searchable: boolean;
  length: number | null;
  defaultValue: string | null;
  /** Aspect type variables only. */
  qualityCode?: boolean;
}

export interface AspectTypeRec {
  id: string;
  tenantId: string;
  name: string;
  category: 'static' | 'dynamic';
  scope: 'private' | 'public';
  description?: string;
  variables: VariableDef[];
  etag: number;
}

export interface TypeAspectRec {
  name: string;
  aspectId: string;
  aspectTypeId: string;
}

export interface FileAssignmentRec {
  key: string;
  fileId: string;
}

export interface AssetTypeRec {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  parentTypeId: string | null;
  instantiable: boolean;
  scope: 'private' | 'public';
  variables: VariableDef[];
  aspects: TypeAspectRec[];
  fileAssignments: FileAssignmentRec[];
  etag: number;
}

export interface LocationRec {
  country: string | null;
  region: string | null;
  locality: string | null;
  streetAddress: string | null;
  postalCode: string | null;
  longitude: number | null;
  latitude: number | null;
}

export interface ValueRec {
  name: string;
  value: string;
}

export interface AspectValuesRec {
  name: string;
  variables: ValueRec[];
}

export interface AssetRec {
  assetId: string;
  tenantId: string;
  name: string;
  externalId: string | null;
  description: string | null;
  typeId: string;
  /** null only for the root asset. */
  parentId: string | null;
  timezone: string;
  twinType: 'performance' | 'simulation';
  /** The asset's own location (inherited locations are computed). */
  location: LocationRec | null;
  /** Explicitly set variable values (defaults are computed). */
  variables: ValueRec[];
  /** Explicitly set static aspect values. */
  aspects: AspectValuesRec[];
  fileAssignments: FileAssignmentRec[];
  etag: number;
}

export interface FileRec {
  id: string;
  name: string;
  originalFileName: string;
  description: string | null;
  tenantId: string;
  scope: 'private' | 'public';
  mimeType: string;
  size: number;
  uploaded: string;
  lastModified: string;
  etag: number;
}

/** Persisted (JSON) form; core types are not persisted, they are code. */
export interface SimStateFile {
  version: 1;
  tenant: string;
  rootAssetId: string;
  modelLock: boolean;
  aspectTypes: AspectTypeRec[];
  assetTypes: AssetTypeRec[];
  assets: AssetRec[];
  files: FileRec[];
}
