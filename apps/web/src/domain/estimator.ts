// Asset Attribute Estimator.
//
// Calculation (docs/reference/overview-and-modelling-guidelines.txt,
// "Calculation of Asset Attributes"):
//   - attributes per asset type = static variables of the type + variables of
//     its aspects, plus everything inherited from parent tenant types;
//   - OOTB (core) parents do not pass attributes on; variables of core aspect
//     types are excluded from billing; core.basicasset has none;
//   - every asset counts at least 1 attribute (also instances of OOTB types);
//   - the total is the sum over all assets.
// The platform states that its own calculator is an estimator too, so
// slight variations are expected.

import { ROOT_ASSET_UID, typeRefKey, type TypeRef } from "./model";
import type { ModelIndex, ResolvedAssetType } from "./resolve";
import { TECHNICAL_LIMITS } from "./rules";

export interface AttributeBreakdown {
  direct: number;
  inheritedStatic: number;
  aspects: {
    name: string;
    aspectTypeName: string;
    variables: number;
    billable: boolean;
    inherited: boolean;
  }[];
  /** Billable attributes contributed by the type definition. */
  billable: number;
  /** What a single asset of this type counts (min 1). */
  perAsset: number;
  incomplete: boolean;
}

export interface TypeEstimate {
  ref: TypeRef;
  key: string;
  name: string;
  displayId: string;
  isCore: boolean;
  instantiable: boolean;
  perAsset: number;
  billableAttributes: number;
  totalVariables: number;
  instances: number;
  totalAttributes: number;
  incomplete: boolean;
}

export interface ProjectEstimate {
  types: TypeEstimate[];
  assets: number;
  totalAttributes: number;
  /** Share of the 500,000 per-tenant technical limit (0..1+). */
  tenantLimitShare: number;
  /** Assets created directly from OOTB types (count 1 each). */
  ootbInstances: number;
  incomplete: boolean;
}

export function breakdownFor(resolved: ResolvedAssetType): AttributeBreakdown {
  const direct = resolved.variables.filter((v) => !v.inherited && v.billable).length;
  const inheritedStatic = resolved.variables.filter((v) => v.inherited && v.billable).length;
  const aspects = resolved.aspects.map((a) => ({
    name: a.name,
    aspectTypeName: a.aspectType.name,
    variables: a.aspectType.variables.length,
    billable: !a.aspectType.isCore && a.definedOn.kind !== "core",
    inherited: a.inherited,
  }));
  return {
    direct,
    inheritedStatic,
    aspects,
    billable: resolved.billableAttributes,
    perAsset: Math.max(1, resolved.billableAttributes),
    incomplete: resolved.incomplete,
  };
}

/** Estimate the attributes per asset of a single type. */
export function estimateType(index: ModelIndex, ref: TypeRef): AttributeBreakdown | undefined {
  const resolved = index.resolveAssetType(ref);
  return resolved ? breakdownFor(resolved) : undefined;
}

/**
 * Estimate the whole project.
 * @param planned optional planned instance counts per type key (typeRefKey),
 *   replacing the modelled asset count for "what-if" sizing.
 */
export function estimateProject(index: ModelIndex, planned?: Record<string, number>): ProjectEstimate {
  const counts = new Map<string, { ref: TypeRef; n: number }>();
  for (const a of index.project.assets) {
    if (a.uid === ROOT_ASSET_UID) continue;
    const key = typeRefKey(a.type);
    const entry = counts.get(key) ?? { ref: a.type, n: 0 };
    entry.n += 1;
    counts.set(key, entry);
  }
  // Every project type appears even without instances so it can be sized.
  for (const t of index.project.assetTypes) {
    const ref: TypeRef = { kind: "project", uid: t.uid };
    const key = typeRefKey(ref);
    if (!counts.has(key)) counts.set(key, { ref, n: 0 });
  }
  if (planned) {
    for (const [key, n] of Object.entries(planned)) {
      const entry = counts.get(key);
      if (entry) entry.n = Math.max(0, Math.floor(n));
    }
  }

  const types: TypeEstimate[] = [];
  let totalAttributes = 0;
  let assets = 0;
  let ootbInstances = 0;
  let incomplete = false;
  for (const [key, { ref, n }] of counts) {
    const resolved = index.resolveAssetType(ref);
    const perAsset = resolved ? Math.max(1, resolved.billableAttributes) : 1;
    const isCore = ref.kind === "core";
    if (isCore) ootbInstances += n;
    if (resolved?.incomplete) incomplete = true;
    types.push({
      ref,
      key,
      name: resolved?.name ?? index.assetTypeName(ref),
      displayId: resolved?.displayId ?? index.assetTypeDisplayId(ref),
      isCore,
      instantiable: resolved?.instantiable ?? true,
      perAsset,
      billableAttributes: resolved?.billableAttributes ?? 0,
      totalVariables: resolved?.totalVariableCount ?? 0,
      instances: n,
      totalAttributes: perAsset * n,
      incomplete: resolved?.incomplete ?? true,
    });
    totalAttributes += perAsset * n;
    assets += n;
  }
  types.sort((a, b) => b.totalAttributes - a.totalAttributes || a.name.localeCompare(b.name));
  return {
    types,
    assets,
    totalAttributes,
    tenantLimitShare: totalAttributes / TECHNICAL_LIMITS.maxAttributesPerTenant,
    ootbInstances,
    incomplete,
  };
}
