// Asset type choices for creating assets, and asset field checks shared by the
// add-child, bulk and CSV flows.

import { ROOT_HIERARCHY_TYPE_ID } from "@/domain/coreLibrary";
import { typeRefKey, type TypeRef } from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";
import { LIMITS, PATTERNS } from "@/domain/rules";

export interface TypeOption {
  /** typeRefKey of the ref (stable select value). */
  key: string;
  ref: TypeRef;
  /** Display name. */
  name: string;
  /** Id as written in CSV files: project idSuffix, the core id or the existing tenant type id. */
  token: string;
  /** "Pump ({tenant}.Pump)" / "Site (core.basicsite)". */
  label: string;
  group: "project" | "tenant" | "core";
  deprecated: boolean;
}

function isRootHierarchy(index: ModelIndex, ref: TypeRef): boolean {
  const resolved = index.resolveAssetType(ref);
  return !!resolved?.chain.some((r) => r.kind === "core" && r.id.toLowerCase() === ROOT_HIERARCHY_TYPE_ID);
}

/**
 * Types an asset can be created from: instantiable project types, existing
 * tenant types (when the project is linked to a tenant catalog) and
 * instantiable core types, excluding descendants of core.roothierarchy
 * (core.basicenterprise, core.basicsubtenant are reserved for tenant roots).
 */
export function instantiableTypeOptions(index: ModelIndex): TypeOption[] {
  const out: TypeOption[] = [];
  const project = [...index.project.assetTypes].sort((a, b) => a.name.localeCompare(b.name));
  for (const t of project) {
    const ref: TypeRef = { kind: "project", uid: t.uid };
    if (!t.instantiable || isRootHierarchy(index, ref)) continue;
    out.push({
      key: typeRefKey(ref),
      ref,
      name: t.name || t.idSuffix,
      token: t.idSuffix,
      label: `${t.name || "(unnamed)"} ({tenant}.${t.idSuffix})`,
      group: "project",
      deprecated: false,
    });
  }
  const existing = [...index.externalAssetTypes()].sort((a, b) => a.name.localeCompare(b.name));
  for (const t of existing) {
    const ref: TypeRef = { kind: "external", id: t.id };
    if (!t.instantiable || isRootHierarchy(index, ref)) continue;
    out.push({
      key: typeRefKey(ref),
      ref,
      name: t.name,
      token: t.id,
      label: `${t.name} (${t.id}) — existing in tenant`,
      group: "tenant",
      deprecated: false,
    });
  }
  const core = [...index.core.library.assetTypes].sort((a, b) => a.name.localeCompare(b.name));
  for (const t of core) {
    if (!t.instantiable || index.core.descendsFrom(t.id, ROOT_HIERARCHY_TYPE_ID)) continue;
    const ref: TypeRef = { kind: "core", id: t.id };
    out.push({
      key: typeRefKey(ref),
      ref,
      name: t.name,
      token: t.id,
      label: `${t.name} (${t.id})${t.deprecated ? " — deprecated" : ""}`,
      group: "core",
      deprecated: !!t.deprecated,
    });
  }
  return out;
}

/**
 * Resolve a type token from a CSV cell: a project type idSuffix (optionally
 * prefixed with "{tenant}."), an existing tenant type id or a core type id.
 * Case-insensitive.
 */
export function resolveTypeToken(options: TypeOption[], token: string): TypeOption | undefined {
  const t = token.trim().toLowerCase().replace(/^\{tenant\}\./, "");
  if (!t) return undefined;
  return options.find((o) => o.token.toLowerCase() === t);
}

/** Error message for an asset name, or undefined when valid. */
export function assetNameError(name: string): string | undefined {
  if (!name.trim()) return "Name is required.";
  if (name.length > LIMITS.assetNameMax) return `Name is longer than ${LIMITS.assetNameMax} characters.`;
  if (!PATTERNS.assetName.test(name)) return "Name must not contain / or \\.";
  return undefined;
}

export function descriptionError(description: string): string | undefined {
  if (description.length > LIMITS.descriptionMax) return `Description is longer than ${LIMITS.descriptionMax} characters.`;
  if (!PATTERNS.noSingleQuote.test(description)) return "Description must not contain a single quote (').";
  return undefined;
}

export function externalIdError(externalId: string): string | undefined {
  return externalId.length > LIMITS.externalIdMax ? `External id is longer than ${LIMITS.externalIdMax} characters.` : undefined;
}

/** Lower-cased names of the current children of a parent. */
export function siblingNameSet(index: ModelIndex, parentUid: string, exceptUid?: string): Set<string> {
  return new Set(
    index
      .childrenOf(parentUid)
      .filter((a) => a.uid !== exceptUid)
      .map((a) => a.name.toLowerCase()),
  );
}
