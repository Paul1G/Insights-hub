// Offline project model for Asset Model Studio.
//
// The model mirrors the Insights Hub Asset Management v3 resources
// (docs/reference/assetmanagement-v3.yaml) but is tenant-independent:
//   - every entity carries a local `uid` (UUID) instead of a tenant id;
//   - type ids are stored as `idSuffix` (the part after "<tenant>.") and are
//     composed with the target tenant name only at deploy time;
//   - references between entities use TypeRef (project uid, core id or an
//     external id that must already exist in the target tenant).
//
// `baseline` fields record the state of an entity the last time it was
// deployed to or imported from a tenant. They drive the immutability rules
// (dataType/searchable/timezone cannot change once created, string length can
// only grow, ...). Per-target tenant ids live in the deployment mappings, not
// in the project, so one project can be deployed to several tenants.

import { z } from "zod";

export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_FORMAT = "asset-model-studio/project";

/** uid of the placeholder that stands for the tenant's root asset. */
export const ROOT_ASSET_UID = "root";

export const DATA_TYPES = [
  "BOOLEAN",
  "INT",
  "LONG",
  "DOUBLE",
  "STRING",
  "TIMESTAMP",
  "BIG_STRING",
] as const;
export const DataTypeSchema = z.enum(DATA_TYPES);
export type DataType = z.infer<typeof DataTypeSchema>;

export const ASPECT_CATEGORIES = ["static", "dynamic"] as const;
export const AspectCategorySchema = z.enum(ASPECT_CATEGORIES);
export type AspectCategory = z.infer<typeof AspectCategorySchema>;

export const TWIN_TYPES = ["performance", "simulation"] as const;
export const TwinTypeSchema = z.enum(TWIN_TYPES);
export type TwinType = z.infer<typeof TwinTypeSchema>;

export const ScopeSchema = z.enum(["private", "public"]);
export type Scope = z.infer<typeof ScopeSchema>;

/**
 * Reference to an asset type or aspect type.
 * - project:  defined in this project (by uid)
 * - core:     an OOTB Insights Hub type (`core.*`), read-only
 * - external: a non-core type that must already exist in the target tenant
 */
export const TypeRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), uid: z.string().min(1) }),
  z.object({ kind: z.literal("core"), id: z.string().min(1) }),
  z.object({ kind: z.literal("external"), id: z.string().min(1) }),
]);
export type TypeRef = z.infer<typeof TypeRefSchema>;

export const VariableBaselineSchema = z.object({
  dataType: DataTypeSchema,
  searchable: z.boolean(),
  length: z.number().int().optional(),
});
export type VariableBaseline = z.infer<typeof VariableBaselineSchema>;

export const VariableDefSchema = z.object({
  uid: z.string().min(1),
  name: z.string(),
  dataType: DataTypeSchema,
  unit: z.string().optional(),
  searchable: z.boolean(),
  /** Only for STRING / BIG_STRING. */
  length: z.number().int().optional(),
  /** Static variables only; must be compatible with dataType. */
  defaultValue: z.string().optional(),
  /** Aspect type variables only. */
  qualityCode: z.boolean().optional(),
  /** Local design notes; never deployed. */
  notes: z.string().optional(),
  baseline: VariableBaselineSchema.optional(),
});
export type VariableDef = z.infer<typeof VariableDefSchema>;

export const OriginSchema = z.object({
  source: z.enum(["tenant", "library", "import"]),
  /** e.g. the tenant id of the type it was read from or the library name. */
  ref: z.string().optional(),
  at: z.string().optional(),
});
export type Origin = z.infer<typeof OriginSchema>;

export const AspectTypeDefSchema = z.object({
  uid: z.string().min(1),
  /** Local part of the id: `<tenant>.<idSuffix>`. */
  idSuffix: z.string(),
  name: z.string(),
  category: AspectCategorySchema,
  description: z.string().optional(),
  variables: z.array(VariableDefSchema),
  notes: z.string().optional(),
  origin: OriginSchema.optional(),
  /** Set once deployed/imported: name, id and category are then immutable. */
  baseline: z
    .object({ idSuffix: z.string(), name: z.string(), category: AspectCategorySchema })
    .optional(),
});
export type AspectTypeDef = z.infer<typeof AspectTypeDefSchema>;

export const AspectRefDefSchema = z.object({
  uid: z.string().min(1),
  /** Aspect name inside the asset type (unique in the type family). */
  name: z.string(),
  aspectType: TypeRefSchema,
});
export type AspectRefDef = z.infer<typeof AspectRefDefSchema>;

export const FileAssignmentDefSchema = z.object({
  key: z.string(),
  fileUid: z.string().min(1),
});
export type FileAssignmentDef = z.infer<typeof FileAssignmentDefSchema>;

export const AssetTypeDefSchema = z.object({
  uid: z.string().min(1),
  idSuffix: z.string(),
  name: z.string(),
  description: z.string().optional(),
  parent: TypeRefSchema,
  instantiable: z.boolean(),
  variables: z.array(VariableDefSchema),
  aspects: z.array(AspectRefDefSchema),
  fileAssignments: z.array(FileAssignmentDefSchema),
  notes: z.string().optional(),
  origin: OriginSchema.optional(),
  /** Set once deployed/imported: id is immutable and instantiable cannot be switched off. */
  baseline: z.object({ idSuffix: z.string(), instantiable: z.boolean() }).optional(),
});
export type AssetTypeDef = z.infer<typeof AssetTypeDefSchema>;

export const LocationSchema = z.object({
  country: z.string().optional(),
  region: z.string().optional(),
  locality: z.string().optional(),
  streetAddress: z.string().optional(),
  postalCode: z.string().optional(),
  longitude: z.number().optional(),
  latitude: z.number().optional(),
});
export type Location = z.infer<typeof LocationSchema>;

export const VariableValueSchema = z.object({ name: z.string(), value: z.string() });
export type VariableValue = z.infer<typeof VariableValueSchema>;

export const AspectValuesSchema = z.object({
  name: z.string(),
  variables: z.array(VariableValueSchema),
});
export type AspectValues = z.infer<typeof AspectValuesSchema>;

export const AssetDefSchema = z.object({
  uid: z.string().min(1),
  name: z.string(),
  externalId: z.string().optional(),
  description: z.string().optional(),
  type: TypeRefSchema,
  /** null only for the root placeholder (uid === ROOT_ASSET_UID). */
  parentUid: z.string().nullable(),
  /** Java time zone id; when omitted the tenant default applies. Create-only. */
  timezone: z.string().optional(),
  twinType: TwinTypeSchema,
  location: LocationSchema.optional(),
  /** Values for (direct or inherited) asset type variables. */
  variables: z.array(VariableValueSchema),
  /** Values for variables of static aspects. */
  aspects: z.array(AspectValuesSchema),
  fileAssignments: z.array(FileAssignmentDefSchema),
  notes: z.string().optional(),
  origin: OriginSchema.optional(),
  /** Set once deployed/imported: timezone and twinType are create-only. */
  baseline: z
    .object({ timezone: z.string().optional(), twinType: TwinTypeSchema })
    .optional(),
});
export type AssetDef = z.infer<typeof AssetDefSchema>;

export const FileDefSchema = z.object({
  uid: z.string().min(1),
  /** Name sent to the Files API (pattern ^[^*&%\s/\\]+$, <= 255). */
  name: z.string(),
  description: z.string().optional(),
  scope: ScopeSchema,
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  /** Hex SHA-256 of the content. */
  sha256: z.string(),
  /** Key of the content in the local blob store (fileBlobs table). */
  blobId: z.string(),
  origin: OriginSchema.optional(),
});
export type FileDef = z.infer<typeof FileDefSchema>;

export const ChangeLogEntrySchema = z.object({
  at: z.string(),
  summary: z.string(),
  /** Optional user id (X-Forwarded-User) of the author when known. */
  author: z.string().optional(),
});
export type ChangeLogEntry = z.infer<typeof ChangeLogEntrySchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  aspectTypes: z.array(AspectTypeDefSchema),
  assetTypes: z.array(AssetTypeDefSchema),
  /** Includes exactly one root placeholder (uid === ROOT_ASSET_UID). */
  assets: z.array(AssetDefSchema),
  files: z.array(FileDefSchema),
  changelog: z.array(ChangeLogEntrySchema),
});
export type Project = z.infer<typeof ProjectSchema>;

export type EntityKind = "aspectType" | "assetType" | "asset" | "file";

export function newUid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createRootAsset(): AssetDef {
  return {
    uid: ROOT_ASSET_UID,
    name: "Tenant root",
    type: { kind: "core", id: "core.basicenterprise" },
    parentUid: null,
    twinType: "performance",
    variables: [],
    aspects: [],
    fileAssignments: [],
    description: "Placeholder for the target tenant's root asset (GET /assets/root).",
  };
}

export function createEmptyProject(name: string, description?: string): Project {
  const at = nowIso();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: newUid(),
    name,
    description,
    createdAt: at,
    updatedAt: at,
    aspectTypes: [],
    assetTypes: [],
    assets: [createRootAsset()],
    files: [],
    changelog: [{ at, summary: "Project created" }],
  };
}

export function typeRefKey(ref: TypeRef): string {
  return ref.kind === "project" ? `project:${ref.uid}` : `${ref.kind}:${ref.id}`;
}

export function sameTypeRef(a: TypeRef, b: TypeRef): boolean {
  return typeRefKey(a) === typeRefKey(b);
}

/** Compose the tenant-qualified id used by the API (`<tenant>.<idSuffix>`). */
export function composeTypeId(tenant: string, idSuffix: string): string {
  return `${tenant}.${idSuffix}`;
}

/** Split a tenant-qualified type id into tenant and suffix. */
export function splitTypeId(id: string): { tenant: string; idSuffix: string } {
  const dot = id.indexOf(".");
  if (dot < 0) return { tenant: "", idSuffix: id };
  return { tenant: id.slice(0, dot), idSuffix: id.slice(dot + 1) };
}
