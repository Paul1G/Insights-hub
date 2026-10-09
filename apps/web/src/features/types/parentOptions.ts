// Parent-type choices for asset types: project types (without cycles),
// existing tenant types of the linked tenant catalog, and core types (without
// root-hierarchy descendants, which are reserved for tenant / subtenant roots
// and cannot be extended).

import { BASIC_ASSET_TYPE_ID, ROOT_HIERARCHY_TYPE_ID, type CoreLibraryIndex } from "@/domain/coreLibrary";
import { typeRefKey, type TypeRef } from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";

export interface ParentOption {
  key: string;
  ref: TypeRef;
  label: string;
  group: "project" | "core" | "external";
  recommended: boolean;
  abstract: boolean;
  deprecated: boolean;
}

/** Core types that may be used as a parent (root-hierarchy types excluded). */
export function isExtendableCoreType(core: CoreLibraryIndex, id: string): boolean {
  return !core.descendsFrom(id, ROOT_HIERARCHY_TYPE_ID);
}

function coreLabel(name: string, id: string, flags: { recommended: boolean; abstract: boolean; deprecated: boolean }): string {
  const notes: string[] = [];
  if (flags.recommended) notes.push("recommended, no billable attributes");
  if (flags.abstract) notes.push("abstract");
  if (flags.deprecated) notes.push("deprecated");
  return `${name} (${id})${notes.length ? ` — ${notes.join(", ")}` : ""}`;
}

/**
 * @param selfUid when re-parenting an existing type: the type itself and its
 *   descendants are excluded so no inheritance cycle can be created.
 * @param current the current parent; kept as an option even if it would be
 *   excluded otherwise (e.g. an external parent), so the select shows it.
 */
export function parentOptions(index: ModelIndex, selfUid?: string, current?: TypeRef): ParentOption[] {
  const excluded = new Set<string>();
  if (selfUid) {
    excluded.add(selfUid);
    for (const d of index.descendantTypesOf(selfUid)) excluded.add(d.uid);
  }
  const project: ParentOption[] = index.project.assetTypes
    .filter((t) => !excluded.has(t.uid))
    .map((t) => ({
      key: typeRefKey({ kind: "project", uid: t.uid }),
      ref: { kind: "project", uid: t.uid } as TypeRef,
      label: `${t.name || "(unnamed)"} ({tenant}.${t.idSuffix})${t.instantiable ? "" : " — abstract"}`,
      group: "project" as const,
      recommended: false,
      abstract: !t.instantiable,
      deprecated: false,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const core: ParentOption[] = index.core.library.assetTypes
    .filter((t) => isExtendableCoreType(index.core, t.id))
    .map((t) => {
      const flags = {
        recommended: t.id.toLowerCase() === BASIC_ASSET_TYPE_ID,
        abstract: !t.instantiable,
        deprecated: !!t.deprecated,
      };
      return {
        key: typeRefKey({ kind: "core", id: t.id }),
        ref: { kind: "core", id: t.id } as TypeRef,
        label: coreLabel(t.name, t.id, flags),
        group: "core" as const,
        ...flags,
      };
    })
    .sort((a, b) => Number(b.recommended) - Number(a.recommended) || Number(a.deprecated) - Number(b.deprecated) || a.label.localeCompare(b.label));

  const existing: ParentOption[] = index
    .externalAssetTypes()
    .filter((t) => !index.resolveAssetType({ kind: "external", id: t.id })?.chain.some(
      (r) => r.kind === "core" && r.id.toLowerCase() === ROOT_HIERARCHY_TYPE_ID,
    ))
    .map((t) => ({
      key: typeRefKey({ kind: "external", id: t.id }),
      ref: { kind: "external", id: t.id } as TypeRef,
      label: `${t.name} (${t.id}) — existing in tenant${t.instantiable ? "" : ", abstract"}`,
      group: "external" as const,
      recommended: false,
      abstract: !t.instantiable,
      deprecated: false,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const out = [...core.filter((o) => o.recommended), ...project, ...existing, ...core.filter((o) => !o.recommended)];
  if (current && !out.some((o) => o.key === typeRefKey(current))) {
    out.unshift({
      key: typeRefKey(current),
      ref: current,
      label:
        current.kind === "external"
          ? `${current.id} — external, must exist in the target tenant`
          : `${index.assetTypeName(current)} — current parent (not allowed)`,
      group: current.kind === "project" ? "project" : current.kind,
      recommended: false,
      abstract: false,
      deprecated: false,
    });
  }
  return out;
}

/** True when making `parent` the parent of `typeUid` would create an inheritance cycle. */
export function wouldCreateCycle(index: ModelIndex, typeUid: string, parent: TypeRef): boolean {
  if (parent.kind !== "project") return false;
  if (parent.uid === typeUid) return true;
  return index.descendantTypesOf(typeUid).some((d) => d.uid === parent.uid);
}
