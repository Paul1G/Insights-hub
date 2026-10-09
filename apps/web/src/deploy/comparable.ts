// Normalised views of tenant resources used for change detection, the
// executor's drift check and diffs. Both sides of every comparison go through
// the same functions, so null/undefined/"" and ordering never show up as
// spurious changes.

import type {
  AmAspect,
  AmAspectTypeResource,
  AmAssetResource,
  AmAssetTypeResource,
  AmFileAssignment,
  AmFileMetadata,
  AmLocation,
  AmVariable,
  AmVariableDefinition,
} from "@/api/amTypes";
import type { DataType, Location } from "@/domain/model";
import { DEFAULT_STRING_LENGTH, supportsLength } from "@/domain/rules";
import type { ExpectKind } from "./types";

export const lc = (s: string): string => s.toLowerCase();

export interface ComparableVariable {
  name: string;
  dataType: DataType;
  unit?: string;
  searchable: boolean;
  length?: number;
  defaultValue?: string;
  qualityCode?: boolean;
}

/** Effective length: STRING without a length means the platform default (255). */
export function effectiveLength(dataType: DataType, length: number | null | undefined): number | undefined {
  if (!supportsLength(dataType)) return undefined;
  if (length !== null && length !== undefined) return length;
  return dataType === "STRING" ? DEFAULT_STRING_LENGTH : undefined;
}

export function blankToUndefined(v: string | null | undefined): string | undefined {
  return v === null || v === undefined || v === "" ? undefined : v;
}

export function comparableVariable(v: AmVariableDefinition, withQualityCode: boolean): ComparableVariable {
  const out: ComparableVariable = {
    name: v.name,
    dataType: v.dataType,
    searchable: !!v.searchable,
  };
  const unit = blankToUndefined(v.unit);
  if (unit !== undefined) out.unit = unit;
  const length = effectiveLength(v.dataType, v.length);
  if (length !== undefined) out.length = length;
  const dv = blankToUndefined(v.defaultValue);
  if (dv !== undefined) out.defaultValue = dv;
  if (withQualityCode) out.qualityCode = !!v.qualityCode;
  return out;
}

const byName = <T extends { name: string }>(a: T, b: T) => lc(a.name).localeCompare(lc(b.name));
const byKey = <T extends { key: string }>(a: T, b: T) => lc(a.key).localeCompare(lc(b.key));

/** Own (not inherited) members: inherited ones carry `_links.origin`. */
export function isOwn(member: { _links?: { origin?: unknown } }): boolean {
  return !member._links?.origin;
}

export function normalizeLocation(loc: AmLocation | Location | null | undefined): Location | undefined {
  if (!loc) return undefined;
  const out: Location = {};
  for (const k of ["country", "region", "locality", "streetAddress", "postalCode"] as const) {
    const v = blankToUndefined(loc[k] as string | null | undefined);
    if (v !== undefined) out[k] = v;
  }
  for (const k of ["longitude", "latitude"] as const) {
    const v = loc[k] as number | null | undefined;
    if (v !== null && v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function sortedValues(values: AmVariable[] | undefined): AmVariable[] {
  return [...(values ?? [])].map((v) => ({ name: v.name, value: v.value })).sort(byName);
}

export function sortedAspects(aspects: AmAspect[] | undefined): AmAspect[] {
  return [...(aspects ?? [])]
    .map((a) => ({ name: a.name, variables: sortedValues(a.variables) }))
    .filter((a) => a.variables.length > 0)
    .sort(byName);
}

export function ownAssignments(list: AmFileAssignment[] | undefined): { key: string; fileId: string }[] {
  return (list ?? [])
    .filter(isOwn)
    .map((f) => ({ key: f.key, fileId: f.fileId }))
    .sort(byKey);
}

export function comparableAspectType(t: AmAspectTypeResource) {
  return {
    name: t.name,
    category: t.category,
    description: blankToUndefined(t.description),
    variables: (t.variables ?? []).map((v) => comparableVariable(v, true)).sort(byName),
  };
}

export function comparableAssetType(t: AmAssetTypeResource) {
  return {
    name: t.name,
    description: blankToUndefined(t.description),
    parentTypeId: t.parentTypeId,
    instantiable: t.instantiable !== false,
    variables: (t.variables ?? []).filter(isOwn).map((v) => comparableVariable(v, false)).sort(byName),
    aspects: (t.aspects ?? [])
      .filter(isOwn)
      .map((a) => ({ name: a.name, aspectId: a.aspectId, aspectTypeId: a.aspectType?.id }))
      .sort(byName),
  };
}

export function comparableAsset(a: AmAssetResource) {
  return {
    name: a.name,
    externalId: blankToUndefined(a.externalId),
    description: blankToUndefined(a.description),
    typeId: a.typeId,
    variables: sortedValues(a.variables),
    aspects: sortedAspects(a.aspects),
  };
}

export function comparableFile(f: AmFileMetadata) {
  return {
    name: f.name,
    description: blankToUndefined(f.description),
    scope: f.scope ?? "private",
    lastModified: f.lastModified,
  };
}

/** The subset of a resource a step depends on (stored as PlanStep.expect). */
export function comparable(kind: ExpectKind, body: unknown): unknown {
  if (body === null || typeof body !== "object") return {};
  switch (kind) {
    case "aspectType":
      return comparableAspectType(body as AmAspectTypeResource);
    case "assetType":
      return comparableAssetType(body as AmAssetTypeResource);
    case "asset":
      return comparableAsset(body as AmAssetResource);
    case "assetParent":
      return { parentId: (body as AmAssetResource).parentId };
    case "file":
      return comparableFile(body as AmFileMetadata);
    case "assignments":
      return { fileAssignments: ownAssignments((body as { fileAssignments?: AmFileAssignment[] }).fileAssignments) };
    case "exists":
      return {};
  }
}
