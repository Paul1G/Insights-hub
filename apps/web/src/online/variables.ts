// Editable variable definitions and the request bodies that obey the
// Asset Management update rules (overview-and-modelling-guidelines.txt and the
// operation descriptions in assetmanagement-v3.yaml):
//
//   - dataType, searchable (and qualityCode) cannot be changed; the only way
//     is "delete and recreate", which loses the stored values;
//   - name, unit, length and defaultValue can be updated; a STRING length can
//     only be increased;
//   - variable names must not be interchanged within one request;
//   - default values exist for static variables only (asset type variables
//     and static aspect types); BIG_STRING only in dynamic aspect types;
//   - aspect type variables: PATCH /aspecttypes/{id}/variables adds, updates
//     and deletes (null) variables;
//   - asset type variables: PATCH /assettypes/{id}/variables updates
//     (name/unit/length/defaultValue) only — additions and removals go through
//     PATCH /assettypes/{id} with the complete `variables` array.

import type {
  AmAspectVariableUpdateMap,
  AmDataType,
  AmVariableDefinition,
  AmVariableUpdateMap,
} from "@/api/amTypes";
import { DATA_TYPES } from "@/domain/model";
import {
  DEFAULT_STRING_LENGTH,
  isReservedWord,
  LIMITS,
  maxLengthFor,
  PATTERNS,
  supportsLength,
} from "@/domain/rules";
import { checkValue } from "@/domain/values";

export const VARIABLE_DATA_TYPES: readonly AmDataType[] = DATA_TYPES;

export interface VariableDraft {
  /** Local key for React lists and issue targeting. */
  key: string;
  /** The server definition this row was loaded from; undefined for new rows. */
  original?: AmVariableDefinition;
  name: string;
  dataType: AmDataType;
  unit: string;
  searchable: boolean;
  /** Text of the length input; "" = not set. */
  length: string;
  defaultValue: string;
  qualityCode: boolean;
  /** Marked for deletion. */
  deleted: boolean;
  /** Delete and recreate (needed to change dataType / searchable / qualityCode). */
  recreate: boolean;
}

export type VariableOwner =
  | { kind: "aspectType"; category: "static" | "dynamic" }
  | { kind: "assetType" };

export interface DraftIssue {
  key: string;
  field?: "name" | "dataType" | "unit" | "length" | "defaultValue" | "searchable" | "qualityCode";
  severity: "error" | "warning";
  message: string;
}

let seq = 0;
const nextKey = () => `v${++seq}`;

export function draftFromVariable(v: AmVariableDefinition): VariableDraft {
  return {
    key: nextKey(),
    original: v,
    name: v.name,
    dataType: v.dataType,
    unit: v.unit ?? "",
    searchable: !!v.searchable,
    length: v.length === null || v.length === undefined ? "" : String(v.length),
    defaultValue: v.defaultValue ?? "",
    qualityCode: !!v.qualityCode,
    deleted: false,
    recreate: false,
  };
}

export function newVariableDraft(owner: VariableOwner): VariableDraft {
  return {
    key: nextKey(),
    name: "",
    dataType: "STRING",
    unit: "",
    searchable: false,
    length: "",
    defaultValue: "",
    qualityCode: owner.kind === "aspectType" && owner.category === "dynamic",
    deleted: false,
    recreate: false,
  };
}

/** Defaults are allowed for asset type variables and static aspect types only. */
export function allowsDefaultValue(owner: VariableOwner): boolean {
  return owner.kind === "assetType" || owner.category === "static";
}

export function allowsBigString(owner: VariableOwner): boolean {
  return owner.kind === "aspectType" && owner.category === "dynamic";
}

export function allowsQualityCode(owner: VariableOwner): boolean {
  return owner.kind === "aspectType";
}

function parseLength(text: string): number | undefined | "invalid" {
  const t = text.trim();
  if (!t) return undefined;
  if (!/^\d+$/.test(t)) return "invalid";
  return Number(t);
}

/** True when an immutable property differs from the server definition. */
export function immutableChanged(d: VariableDraft): boolean {
  const o = d.original;
  if (!o) return false;
  return o.dataType !== d.dataType || !!o.searchable !== d.searchable || !!o.qualityCode !== d.qualityCode;
}

/** Active rows: not deleted. A recreated row counts as a new definition with the draft values. */
export function activeDrafts(drafts: readonly VariableDraft[]): VariableDraft[] {
  return drafts.filter((d) => !d.deleted);
}

/** The definition a draft stands for (sent for additions and recreations). */
export function definitionFromDraft(d: VariableDraft, owner: VariableOwner): AmVariableDefinition {
  const def: AmVariableDefinition = { name: d.name.trim(), dataType: d.dataType, searchable: d.searchable };
  const unit = d.unit.trim();
  if (unit) def.unit = unit;
  const len = parseLength(d.length);
  if (typeof len === "number" && supportsLength(d.dataType)) def.length = len;
  if (allowsDefaultValue(owner) && d.defaultValue !== "") def.defaultValue = d.defaultValue;
  if (allowsQualityCode(owner)) def.qualityCode = d.qualityCode;
  return def;
}

/** Plain server definition without links (for complete `variables` arrays). */
export function stripVariable(v: AmVariableDefinition, owner: VariableOwner): AmVariableDefinition {
  const def: AmVariableDefinition = { name: v.name, dataType: v.dataType, searchable: !!v.searchable };
  if (v.unit !== null && v.unit !== undefined) def.unit = v.unit;
  if (v.length !== null && v.length !== undefined) def.length = v.length;
  if (v.defaultValue !== null && v.defaultValue !== undefined) def.defaultValue = v.defaultValue;
  if (allowsQualityCode(owner) && v.qualityCode !== undefined) def.qualityCode = v.qualityCode;
  return def;
}

/**
 * Validate variable rows. `familyNames` are names that already exist in the
 * type family outside this list (inherited variables, other types).
 */
export function validateVariableDrafts(
  drafts: readonly VariableDraft[],
  owner: VariableOwner,
  familyNames: readonly string[] = [],
): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const active = activeDrafts(drafts);
  const originalNames = new Map<string, string>();
  for (const d of drafts) if (d.original) originalNames.set(d.original.name.toLowerCase(), d.key);
  const seen = new Map<string, string>();
  const family = new Set(familyNames.map((n) => n.toLowerCase()));

  for (const d of active) {
    const err = (field: DraftIssue["field"], message: string) =>
      issues.push({ key: d.key, field, severity: "error", message });
    const warn = (field: DraftIssue["field"], message: string) =>
      issues.push({ key: d.key, field, severity: "warning", message });
    const name = d.name.trim();
    const lower = name.toLowerCase();

    // name
    if (!name) err("name", "Name is required.");
    else if (name.length > LIMITS.variableNameMax) err("name", `At most ${LIMITS.variableNameMax} characters.`);
    else if (!PATTERNS.variableName.test(name)) err("name", "Letters, digits and _ only; must not start with a digit.");
    else if (isReservedWord(name)) err("name", `"${name}" is a reserved word.`);
    if (name) {
      if (seen.has(lower)) err("name", "Variable names must be unique (case-insensitive).");
      seen.set(lower, d.key);
      if (family.has(lower)) err("name", "This name already exists in the type family (inherited or derived variable).");
      const renamed = d.original && d.original.name.toLowerCase() !== lower;
      const isNewName = !d.original || renamed;
      const owner2 = originalNames.get(lower);
      if (isNewName && owner2 !== undefined && owner2 !== d.key) {
        err(
          "name",
          "Another variable currently has this name. Names cannot be interchanged or reused in the same request — save the rename or deletion first.",
        );
      }
    }

    // dataType
    if (!VARIABLE_DATA_TYPES.includes(d.dataType)) err("dataType", "Unknown data type.");
    if (d.dataType === "BIG_STRING" && !allowsBigString(owner)) {
      err("dataType", "BIG_STRING can only be used by variables in dynamic aspect types.");
    }

    // immutable fields
    if (d.original && immutableChanged(d) && !d.recreate) {
      err(
        "dataType",
        "dataType, searchable and qualityCode cannot be changed. Use “Delete and recreate” (stored values of this variable are lost).",
      );
    }
    if (d.original && d.recreate && d.name.trim().toLowerCase() !== d.original.name.toLowerCase()) {
      err("name", "A recreated variable keeps its name. Rename it in a separate save.");
    }

    // unit
    if (d.unit.length > LIMITS.unitMax) err("unit", `At most ${LIMITS.unitMax} characters.`);
    if (!PATTERNS.noSingleQuote.test(d.unit)) err("unit", "Single quotes are not allowed.");

    // length
    const len = parseLength(d.length);
    if (len === "invalid") err("length", "Enter a whole number.");
    else if (typeof len === "number") {
      if (!supportsLength(d.dataType)) err("length", "Length is only used for STRING and BIG_STRING.");
      else {
        const max = maxLengthFor(d.dataType)!;
        if (len < 1 || len > max) err("length", `Between 1 and ${max}.`);
      }
    }
    if (d.original && !d.recreate && supportsLength(d.dataType)) {
      const before = d.original.length ?? (d.original.dataType === "STRING" ? DEFAULT_STRING_LENGTH : undefined);
      const after = typeof len === "number" ? len : before;
      if (before !== undefined && after !== undefined && after < before) {
        err("length", `The length can only be increased (currently ${before}).`);
      }
      if (
        owner.kind === "aspectType" &&
        owner.category === "dynamic" &&
        after !== before &&
        typeof len === "number"
      ) {
        warn("length", "Insights Hub may reject length changes of dynamic STRING variables (documented for PUT/PATCH of aspect types).");
      }
    }

    // default value
    if (d.defaultValue !== "") {
      if (!allowsDefaultValue(owner)) err("defaultValue", "Default values exist only for static variables.");
      else {
        const l = typeof len === "number" ? len : d.original?.length ?? undefined;
        const msg = checkValue(d.dataType, d.defaultValue, l);
        if (msg) err("defaultValue", msg);
      }
    } else if (d.original && !d.recreate && d.original.defaultValue) {
      err("defaultValue", "A default value cannot be removed with a variable update; enter a new value or recreate the variable.");
    }
    if (d.original && !d.recreate && d.original.unit && !d.unit.trim()) {
      warn("unit", "The unit will be cleared.");
    }
  }
  return issues;
}

export function hasErrors(issues: readonly DraftIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

/**
 * Updatable fields (name/unit/length/defaultValue) the user changed on an
 * existing variable — three-way: a field is included when the draft differs
 * from the definition it was loaded from (`d.original`) *and* from the current
 * server definition, so concurrent changes to untouched fields are kept.
 */
export function variableUpdateFields(
  current: AmVariableDefinition,
  d: VariableDraft,
  owner: VariableOwner,
): { name?: string; unit?: string; length?: number; defaultValue?: string } {
  const out: { name?: string; unit?: string; length?: number; defaultValue?: string } = {};
  const base = d.original ?? current;
  const name = d.name.trim();
  if (name !== base.name && name !== current.name) out.name = name;
  const unit = d.unit.trim();
  if (unit !== (base.unit ?? "") && unit !== (current.unit ?? "")) out.unit = unit;
  const len = parseLength(d.length);
  if (
    typeof len === "number" &&
    supportsLength(d.dataType) &&
    len !== (base.length ?? undefined) &&
    len !== (current.length ?? undefined)
  ) {
    out.length = len;
  }
  if (
    allowsDefaultValue(owner) &&
    d.defaultValue !== "" &&
    d.defaultValue !== (base.defaultValue ?? "") &&
    d.defaultValue !== (current.defaultValue ?? "")
  ) {
    out.defaultValue = d.defaultValue;
  }
  return out;
}

const findByName = (vars: readonly AmVariableDefinition[], name: string) =>
  vars.find((v) => v.name.toLowerCase() === name.toLowerCase());

export interface VariableChangeSummary {
  added: string[];
  deleted: string[];
  recreated: string[];
  updated: string[];
}

export function summarizeVariableChanges(
  current: readonly AmVariableDefinition[],
  drafts: readonly VariableDraft[],
  owner: VariableOwner,
): VariableChangeSummary {
  const s: VariableChangeSummary = { added: [], deleted: [], recreated: [], updated: [] };
  for (const d of drafts) {
    if (!d.original) {
      if (!d.deleted) s.added.push(d.name.trim());
      continue;
    }
    const cur = findByName(current, d.original.name);
    if (!cur) {
      if (!d.deleted) s.added.push(d.name.trim());
      continue;
    }
    if (d.deleted) s.deleted.push(cur.name);
    else if (d.recreate) s.recreated.push(cur.name);
    else if (Object.keys(variableUpdateFields(cur, d, owner)).length) s.updated.push(cur.name);
  }
  return s;
}

/**
 * Bodies for PATCH /aspecttypes/{id}/variables (merge patch: name → definition,
 * null deletes). Returns one map, or two when variables are recreated (the
 * deletion has to be applied before the definition with the same name is added).
 * Planned against the *current* server variables, so a re-plan after a 412
 * re-applies exactly the user's changes.
 */
export function aspectTypeVariablePatches(
  current: readonly AmVariableDefinition[],
  drafts: readonly VariableDraft[],
  category: "static" | "dynamic",
): AmAspectVariableUpdateMap[] {
  const owner: VariableOwner = { kind: "aspectType", category };
  const first: AmAspectVariableUpdateMap = {};
  const main: AmAspectVariableUpdateMap = {};
  for (const d of drafts) {
    const cur = d.original ? findByName(current, d.original.name) : undefined;
    if (!d.original || !cur) {
      if (!d.deleted) main[d.name.trim()] = definitionFromDraft(d, owner);
      continue;
    }
    if (d.deleted) {
      main[cur.name] = null;
      continue;
    }
    if (d.recreate) {
      first[cur.name] = null;
      main[d.name.trim()] = definitionFromDraft(d, owner);
      continue;
    }
    const fields = variableUpdateFields(cur, d, owner);
    if (!Object.keys(fields).length) continue;
    // Full definition with the unchanged immutable fields: the map values are
    // VariableDefinition (name and dataType required).
    const def: Partial<AmVariableDefinition> = {
      ...stripVariable(cur, owner),
      ...fields,
    };
    if (!allowsDefaultValue(owner)) delete def.defaultValue;
    main[cur.name] = def;
  }
  const out: AmAspectVariableUpdateMap[] = [];
  if (Object.keys(first).length) out.push(first);
  if (Object.keys(main).length) out.push(main);
  return out;
}

/**
 * Body for PATCH /assettypes/{id}/variables: existing direct variables whose
 * name/unit/length/defaultValue changed (recreated / deleted / new ones are
 * handled by PATCH /assettypes/{id}).
 */
export function assetTypeVariableUpdateMap(
  currentDirect: readonly AmVariableDefinition[],
  drafts: readonly VariableDraft[],
): AmVariableUpdateMap {
  const owner: VariableOwner = { kind: "assetType" };
  const map: AmVariableUpdateMap = {};
  for (const d of drafts) {
    if (!d.original || d.deleted || d.recreate) continue;
    const cur = findByName(currentDirect, d.original.name);
    if (!cur) continue;
    const fields = variableUpdateFields(cur, d, owner);
    if (Object.keys(fields).length) map[cur.name] = fields;
  }
  return map;
}

/**
 * Complete direct `variables` arrays for PATCH /assettypes/{id}:
 * - `removal`: current variables minus deleted and recreated ones (only when
 *   something is recreated — that step must precede re-adding the same name);
 * - `final`: current variables minus deleted/recreated, plus new and recreated
 *   definitions. Existing variables are sent unchanged; their updates follow in
 *   PATCH /assettypes/{id}/variables.
 * `changed` is false when the array would be identical to the current one.
 */
export function assetTypeVariableArrays(
  currentDirect: readonly AmVariableDefinition[],
  drafts: readonly VariableDraft[],
): { removal?: AmVariableDefinition[]; final: AmVariableDefinition[]; changed: boolean } {
  const owner: VariableOwner = { kind: "assetType" };
  const drop = new Set<string>();
  const recreate = new Set<string>();
  const additions: AmVariableDefinition[] = [];
  for (const d of drafts) {
    const cur = d.original ? findByName(currentDirect, d.original.name) : undefined;
    if (!d.original || !cur) {
      if (!d.deleted) additions.push(definitionFromDraft(d, owner));
      continue;
    }
    if (d.deleted) drop.add(cur.name.toLowerCase());
    else if (d.recreate) {
      recreate.add(cur.name.toLowerCase());
      additions.push(definitionFromDraft(d, owner));
    }
  }
  const kept = currentDirect
    .filter((v) => !drop.has(v.name.toLowerCase()) && !recreate.has(v.name.toLowerCase()))
    .map((v) => stripVariable(v, owner));
  const final = [...kept, ...additions];
  return {
    removal: recreate.size ? kept : undefined,
    final,
    changed: drop.size > 0 || recreate.size > 0 || additions.length > 0,
  };
}
