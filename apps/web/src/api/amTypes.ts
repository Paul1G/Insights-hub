// Insights Hub Asset Management v3 resource shapes, transcribed from
// docs/reference/assetmanagement-v3.yaml (v3.19.0). Only fields defined in
// the spec are declared.

export type AmDataType = "BOOLEAN" | "INT" | "LONG" | "DOUBLE" | "STRING" | "TIMESTAMP" | "BIG_STRING";

export interface AmLink {
  href: string;
}

export interface AmVariableDefinition {
  name: string;
  dataType: AmDataType;
  unit?: string | null;
  searchable?: boolean;
  length?: number | null;
  defaultValue?: string | null;
  /** Aspect type variables only. */
  qualityCode?: boolean;
  /** `origin` is present when the variable is inherited. */
  _links?: { origin?: AmLink };
}

/** PATCH /assettypes/{id}/variables body: variable name → updated fields. */
export type AmVariableUpdateMap = Record<
  string,
  { name?: string; unit?: string; length?: number; defaultValue?: string }
>;

/** PATCH /aspecttypes/{id}/variables body: name → definition (null deletes, per RFC 7396). */
export type AmAspectVariableUpdateMap = Record<string, Partial<AmVariableDefinition> | null>;

export interface AmSharing {
  modes?: ("SHARER" | "RECEIVER")[];
}

export interface AmAspectTypeResource {
  id: string;
  tenantId: string;
  name: string;
  category: "static" | "dynamic";
  scope: "public" | "private";
  description?: string;
  variables: AmVariableDefinition[];
  etag: number;
  sharing?: AmSharing;
  _links?: { self?: AmLink };
}

/** PUT /aspecttypes/{id} body. */
export interface AmAspectType {
  name: string;
  category: "static" | "dynamic";
  scope: "public" | "private";
  description?: string;
  variables: AmVariableDefinition[];
}

export interface AmFileAssignment {
  key: string;
  fileId: string;
  _links?: { download?: AmLink; metadata?: AmLink; origin?: AmLink };
}

export interface AmAssetTypeAspectResource {
  name: string;
  aspectId?: string;
  aspectType: AmAspectTypeResource;
  _links?: { origin?: AmLink };
}

export interface AmAssetTypeResource {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  parentTypeId: string;
  instantiable: boolean;
  scope: "public" | "private";
  etag: number;
  aspects: AmAssetTypeAspectResource[];
  variables: AmVariableDefinition[];
  fileAssignments: AmFileAssignment[];
  sharing?: AmSharing;
  _links?: { self?: AmLink; parent?: AmLink };
}

/** PUT /assettypes/{id} body (also used for PATCH as merge patch). */
export interface AmAssetType {
  name: string;
  description?: string;
  parentTypeId: string;
  instantiable?: boolean;
  scope?: "public" | "private";
  aspects?: { name: string; aspectId?: string; aspectTypeId: string }[];
  variables?: AmVariableDefinition[];
  fileAssignments?: { key: string; fileId: string }[];
}

export interface AmLocation {
  country?: string;
  region?: string;
  locality?: string;
  streetAddress?: string;
  postalCode?: string;
  longitude?: number;
  latitude?: number;
}

export interface AmVariable {
  name: string;
  value: string;
}

export interface AmAspect {
  name: string;
  variables: AmVariable[];
}

/** POST /assets body. */
export interface AmAsset {
  name: string;
  externalId?: string;
  description?: string;
  location?: AmLocation;
  variables?: AmVariable[];
  aspects?: AmAspect[];
  fileAssignments?: { key: string; fileId: string }[];
  typeId: string;
  parentId: string;
  timezone?: string;
  twinType?: "performance" | "simulation";
}

/** PUT /assets/{id} body; PATCH uses the same fields as a merge patch. */
export interface AmAssetUpdate {
  name?: string;
  externalId?: string;
  description?: string;
  location?: AmLocation;
  variables?: AmVariable[];
  aspects?: AmAspect[];
  fileAssignments?: { key: string; fileId: string }[];
}

export interface AmAssetResource {
  assetId: string;
  tenantId: string;
  name: string;
  externalId?: string;
  description?: string;
  location?: AmLocation;
  variables: AmVariable[];
  aspects: AmAspect[];
  fileAssignments: AmFileAssignment[];
  typeId: string;
  /** Absent for the root asset. */
  parentId?: string;
  timezone?: string;
  twinType?: "performance" | "simulation";
  subTenant?: string;
  etag: number;
  deleted?: string | null;
  locks?: { id?: string; service?: string; reason?: string; reasonCode?: string }[];
  sharing?: AmSharing;
  hierarchyPath?: { assetId: string; name: string }[];
  _links?: Record<string, AmLink | undefined>;
}

export interface AmAspectResource {
  aspectTypeId?: string;
  holderAssetId?: string;
  name: string;
  aspectId?: string;
  category?: "dynamic" | "static";
  description?: string;
  variables: AmVariableDefinition[];
}

export interface AmFileMetadata {
  id: string;
  name: string;
  originalFileName?: string;
  description?: string;
  tenantId?: string;
  subTenant?: string;
  uploaded?: string;
  lastModified?: string;
  isAssigned?: boolean;
  scope?: "public" | "private";
  etag: number;
  _links?: { self?: AmLink; download?: AmLink };
}

export interface AmPage {
  size: number;
  totalElements: number;
  totalPages: number;
  number: number;
}

export interface AmErrorBody {
  errors?: { code?: string; errorcode?: string; logref?: string; message?: string }[];
}

export interface AmModelLock {
  enabled?: boolean;
  jobs?: string[];
}
