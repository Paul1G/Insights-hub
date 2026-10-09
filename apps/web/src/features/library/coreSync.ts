// "Sync library from tenant": converts the core (OOTB) asset and aspect types
// read from a live tenant (GET /assettypes, GET /aspecttypes — AM v3 resource
// shapes, see api/amTypes.ts) into a CoreLibrary, and diffs two libraries for
// the confirmation preview.

import type { AmAspectTypeResource, AmAssetTypeResource, AmVariableDefinition } from "@/api/amTypes";
import {
  BUILTIN_CORE_LIBRARY,
  isCoreId,
  type CoreAspectType,
  type CoreAssetType,
  type CoreLibrary,
  type CoreVariable,
} from "@/domain/coreLibrary";
import { diffValues, type Change } from "@/domain/diff";

export function coreVariableFrom(v: AmVariableDefinition): CoreVariable {
  return {
    name: v.name,
    dataType: v.dataType,
    unit: v.unit ?? null,
    searchable: v.searchable ?? false,
    length: v.length ?? null,
    defaultValue: v.defaultValue ?? null,
    ...(v.qualityCode !== undefined ? { qualityCode: v.qualityCode } : {}),
  };
}

function coreAspectTypeFrom(r: AmAspectTypeResource): CoreAspectType {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    description: r.description ?? "",
    variables: (r.variables ?? []).map(coreVariableFrom),
  };
}

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

/**
 * Build a CoreLibrary from tenant resources. Only `core.*` types are kept.
 * Inherited variables / aspects (marked by an `origin` link, only present
 * when listed with `exploded=true`) are dropped so every type carries its own
 * definition only. The `deprecated` flag is not part of the API; it is taken
 * from the documented built-in library for the same id.
 */
export function coreLibraryFromTenant(
  assetTypes: AmAssetTypeResource[],
  aspectTypes: AmAspectTypeResource[],
  meta: { syncedAt: string; syncedFrom: string },
  documented: CoreLibrary = BUILTIN_CORE_LIBRARY,
): CoreLibrary {
  const deprecated = new Set(documented.assetTypes.filter((t) => t.deprecated).map((t) => t.id.toLowerCase()));

  const aspects = new Map<string, CoreAspectType>();
  for (const r of aspectTypes) {
    if (isCoreId(r.id)) aspects.set(r.id.toLowerCase(), coreAspectTypeFrom(r));
  }

  const types: CoreAssetType[] = [];
  for (const r of assetTypes) {
    if (!isCoreId(r.id)) continue;
    const ownAspects = (r.aspects ?? []).filter((a) => !a._links?.origin && a.aspectType?.id);
    for (const a of ownAspects) {
      // Asset type aspects embed their aspect type; use it when the aspect
      // type list did not contain it (e.g. a partial list).
      const key = a.aspectType.id.toLowerCase();
      if (isCoreId(a.aspectType.id) && !aspects.has(key)) aspects.set(key, coreAspectTypeFrom(a.aspectType));
    }
    const parent = r.parentTypeId && r.parentTypeId.toLowerCase() !== r.id.toLowerCase() ? r.parentTypeId : null;
    types.push({
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      parentTypeId: parent,
      instantiable: r.instantiable,
      variables: (r.variables ?? []).filter((v) => !v._links?.origin).map(coreVariableFrom),
      aspects: ownAspects.map((a) => ({ name: a.name, aspectTypeId: a.aspectType.id })),
      ...(deprecated.has(r.id.toLowerCase()) ? { deprecated: true } : {}),
    });
  }

  return {
    source: "tenant",
    syncedAt: meta.syncedAt,
    syncedFrom: meta.syncedFrom,
    assetTypes: types.sort(byId),
    aspectTypes: [...aspects.values()].sort(byId),
  };
}

export interface CoreTypeDiff<T> {
  added: T[];
  removed: T[];
  changed: { before: T; after: T; changes: Change[] }[];
  unchanged: number;
}

export interface CoreLibraryDiff {
  assetTypes: CoreTypeDiff<CoreAssetType>;
  aspectTypes: CoreTypeDiff<CoreAspectType>;
  /** True when nothing differs. */
  identical: boolean;
}

function diffById<T extends { id: string }>(before: T[], after: T[]): CoreTypeDiff<T> {
  const b = new Map(before.map((t) => [t.id.toLowerCase(), t]));
  const a = new Map(after.map((t) => [t.id.toLowerCase(), t]));
  const out: CoreTypeDiff<T> = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const [key, bt] of b) {
    const at = a.get(key);
    if (!at) {
      out.removed.push(bt);
      continue;
    }
    const changes = diffValues(bt, at);
    if (changes.length) out.changed.push({ before: bt, after: at, changes });
    else out.unchanged += 1;
  }
  for (const [key, at] of a) if (!b.has(key)) out.added.push(at);
  out.added.sort(byId);
  out.removed.sort(byId);
  out.changed.sort((x, y) => byId(x.after, y.after));
  return out;
}

/** Type-level diff of two core libraries (current → candidate). Source metadata is ignored. */
export function diffCoreLibraries(current: CoreLibrary, next: CoreLibrary): CoreLibraryDiff {
  const assetTypes = diffById(current.assetTypes, next.assetTypes);
  const aspectTypes = diffById(current.aspectTypes, next.aspectTypes);
  const identical = [assetTypes, aspectTypes].every((d) => !d.added.length && !d.removed.length && !d.changed.length);
  return { assetTypes, aspectTypes, identical };
}
