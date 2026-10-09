// Field rules and modelling guardrails, transcribed from the official
// Asset Management v3 OpenAPI spec (docs/reference/assetmanagement-v3.yaml)
// and the modelling guidelines
// (docs/reference/overview-and-modelling-guidelines.txt).
//
// Spec patterns are validated server-side as full matches, so every regex here
// is anchored.

import type { DataType } from "./model";

/** Reserved words that cannot be used as variable or aspect names. */
export const RESERVED_WORDS = [
  "id",
  "name",
  "description",
  "tenant",
  "etag",
  "scope",
  "properties",
  "propertySets",
  "extends",
  "variables",
  "aspects",
  "parentTypeId",
] as const;

const RESERVED_LOWER = new Set(RESERVED_WORDS.map((w) => w.toLowerCase()));

export function isReservedWord(name: string): boolean {
  return RESERVED_LOWER.has(name.toLowerCase());
}

export const PATTERNS = {
  /** Tenant part of a type id: [A-Za-z0-9_]{1,8}. */
  tenantName: /^[A-Za-z0-9_]{1,8}$/,
  /** Part after "<tenant>." in a type id. */
  typeIdSuffix: /^[A-Za-z0-9_]+$/,
  /** Full type id. */
  typeId: /^[A-Za-z0-9_]{1,8}\.[A-Za-z0-9_]+$/,
  aspectTypeName: /^[a-zA-Z0-9_]+$/,
  assetTypeName: /^[\p{L}_0-9. ]+$/u,
  /** VariableUpdate / VariableDefinition name. */
  variableName: /^[a-zA-Z_][a-zA-Z0-9_]*$/,
  /** Aspect name inside an asset type. */
  aspectName: /^[a-zA-Z0-9_]+$/,
  /** Asset name: no slashes or backslashes. */
  assetName: /^[^/\\]*$/,
  /** Aspect type description, asset description, unit: no single quote. */
  noSingleQuote: /^[^']*$/,
  /** File name for the Files API. */
  fileName: /^[^*&%\s/\\]+$/,
  /** File assignment key. */
  fileKey: /^\w+$/,
  /** Location.locality as written in the spec: [\p{L}0-9_ -\']* */
  locality: /^[\p{L}0-9_ -']*$/u,
} as const;

export const LIMITS = {
  typeIdMax: 128,
  tenantNameMax: 8,
  typeNameMax: 128,
  aspectTypeNameMax: 128,
  variableNameMax: 64,
  aspectNameMax: 64,
  assetNameMax: 128,
  descriptionMax: 255,
  unitMax: 32,
  stringLengthMax: 255,
  bigStringLengthMax: 100000,
  defaultValueMax: 255,
  variableValueMax: 255,
  externalIdMax: 255,
  locationFieldMax: 255,
  fileNameMax: 255,
  fileDescriptionMax: 255,
  fileSizeMaxBytes: 5 * 1024 * 1024,
  /** Recommended page size for GET /assets, /assettypes, /aspecttypes. */
  listPageSize: 200,
} as const;

/** Data types that accept a `length`. */
export function supportsLength(dataType: DataType): boolean {
  return dataType === "STRING" || dataType === "BIG_STRING";
}

export function maxLengthFor(dataType: DataType): number | undefined {
  if (dataType === "STRING") return LIMITS.stringLengthMax;
  if (dataType === "BIG_STRING") return LIMITS.bigStringLengthMax;
  return undefined;
}

/** Default length the platform applies to STRING variables when none is set. */
export const DEFAULT_STRING_LENGTH = 255;

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

/** "Recommendation for optimum performance" — warnings, thresholds adjustable. */
export interface RecommendedThresholds {
  maxAssetTypes: number;
  maxVariablesPerAspectType: number;
  maxAspectsPerAssetType: number;
  /** Including inherited variables and variables of all aspects. */
  maxVariablesPerAssetType: number;
}

/** "Modeling Recommendations for P&P Tenant" — enforced technical limits. */
export interface TechnicalLimits {
  maxVariablesPerAspectType: number;
  maxAspectsPerAssetType: number;
  maxDirectVariablesPerAssetType: number;
  maxAssetTypeDepth: number;
  maxAssetHierarchyDepth: number;
  maxAttributesPerAsset: number;
  maxAttributesPerTenant: number;
}

export const DEFAULT_RECOMMENDED: RecommendedThresholds = {
  maxAssetTypes: 100,
  maxVariablesPerAspectType: 10,
  maxAspectsPerAssetType: 25,
  maxVariablesPerAssetType: 250,
};

export const TECHNICAL_LIMITS: TechnicalLimits = {
  maxVariablesPerAspectType: 20,
  maxAspectsPerAssetType: 30,
  maxDirectVariablesPerAssetType: 25,
  maxAssetTypeDepth: 5,
  maxAssetHierarchyDepth: 20,
  maxAttributesPerAsset: 500,
  maxAttributesPerTenant: 500000,
};

/**
 * - recommended:  only the performance recommendations are checked (warnings);
 *                 technical limits are reported as information.
 * - technical:    recommendations (warnings) + Capability Package / P&P
 *                 technical limits (errors that block deployment).
 */
export type GuardrailProfile = "recommended" | "technical";

export interface GuardrailSettings {
  profile: GuardrailProfile;
  recommended: RecommendedThresholds;
}

export const DEFAULT_GUARDRAILS: GuardrailSettings = {
  profile: "technical",
  recommended: DEFAULT_RECOMMENDED,
};

export const GUARDRAIL_NOTES = {
  assetTypeDepth:
    "Inheritance depth is counted as the number of inheritance steps below core.basicasset " +
    "(a type whose parent is core.basicasset has depth 1).",
  assetHierarchyDepth:
    "Hierarchy depth is counted in levels including the tenant root (root = level 1).",
  attributes:
    "Asset attributes = static asset type variables + variables of all aspects, including " +
    "inherited tenant types. OOTB (core) types and core aspect types contribute no billable " +
    "attributes; every asset counts at least 1.",
} as const;
