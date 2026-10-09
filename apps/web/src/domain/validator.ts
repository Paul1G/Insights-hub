// Project validator: naming rules, immutability, references, uniqueness
// (case-insensitive) and modelling guardrails.
//
// Severity:
//   error   — the API would reject it, a documented immutability rule is
//             broken, or a technical limit is exceeded under the
//             "technical" profile. Errors block deployment.
//   warning — recommended thresholds, ambiguous designs.
//   info    — hints (technical limits under the "recommended" profile, ...).

import { BASIC_ASSET_TYPE_ID, ROOT_HIERARCHY_TYPE_ID } from "./coreLibrary";
import { checkContentType } from "./mime";
import {
  ROOT_ASSET_UID,
  type AspectCategory,
  type AspectTypeDef,
  type AssetDef,
  type AssetTypeDef,
  type FileAssignmentDef,
  type Location,
  type VariableDef,
} from "./model";
import { ModelIndex, type ResolvedAssetType, type VariableLike } from "./resolve";
import {
  DEFAULT_GUARDRAILS,
  GUARDRAIL_NOTES,
  LIMITS,
  PATTERNS,
  TECHNICAL_LIMITS,
  isReservedWord,
  maxLengthFor,
  supportsLength,
  type GuardrailSettings,
} from "./rules";
import { checkTimezone, timezoneMessage } from "./timezone";
import { checkValue } from "./values";

export type Severity = "error" | "warning" | "info";

export type IssueTargetKind = "project" | "aspectType" | "assetType" | "asset" | "file";

export interface IssueTarget {
  kind: IssueTargetKind;
  uid: string;
  /** Display label of the entity. */
  label: string;
  /** Variable / aspect uid inside the entity, when applicable. */
  memberUid?: string;
  field?: string;
}

export interface Issue {
  /** Stable id: code + target, usable as React key. */
  id: string;
  severity: Severity;
  code: string;
  message: string;
  target: IssueTarget;
  /** Guardrail metadata for limit-based issues. */
  limit?: { kind: "recommended" | "technical"; max: number; actual: number };
  /** Short actionable hint. */
  hint?: string;
}

export interface ValidationResult {
  issues: Issue[];
  errors: number;
  warnings: number;
  infos: number;
  byEntity: Map<string, Issue[]>;
}

/** Longest idSuffix that still fits a 128-char id for the longest (8-char) tenant name. */
export const MAX_ID_SUFFIX = LIMITS.typeIdMax - LIMITS.tenantNameMax - 1;

class Collector {
  readonly issues: Issue[] = [];
  private readonly seen = new Set<string>();

  add(
    severity: Severity,
    code: string,
    target: IssueTarget,
    message: string,
    extra: Pick<Issue, "limit" | "hint"> = {},
  ): void {
    const id = `${code}:${target.kind}:${target.uid}:${target.memberUid ?? ""}:${target.field ?? ""}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.issues.push({ id, severity, code, message, target, ...extra });
  }
}

const lc = (s: string) => s.toLowerCase();

function checkDescription(
  c: Collector,
  target: IssueTarget,
  description: string | undefined,
  forbidQuote: boolean,
): void {
  if (!description) return;
  if (description.length > LIMITS.descriptionMax) {
    c.add("error", "DESCRIPTION_TOO_LONG", { ...target, field: "description" }, `Description is longer than ${LIMITS.descriptionMax} characters.`);
  }
  if (forbidQuote && !PATTERNS.noSingleQuote.test(description)) {
    c.add("error", "DESCRIPTION_QUOTE", { ...target, field: "description" }, "Description must not contain a single quote (').");
  }
}

function checkIdSuffix(c: Collector, target: IssueTarget, idSuffix: string): void {
  const t = { ...target, field: "idSuffix" };
  if (!idSuffix) {
    c.add("error", "ID_REQUIRED", t, "Type id is required.");
    return;
  }
  if (!PATTERNS.typeIdSuffix.test(idSuffix)) {
    c.add("error", "ID_PATTERN", t, `Type id "${idSuffix}" may only contain A-Z, a-z, 0-9 and _.`);
  }
  if (idSuffix.length > MAX_ID_SUFFIX) {
    c.add("error", "ID_TOO_LONG", t, `Type id is longer than ${MAX_ID_SUFFIX} characters (the full id "<tenant>.<id>" is limited to ${LIMITS.typeIdMax}).`);
  }
}

/**
 * A new project type whose id already exists in the linked tenant: deploying
 * it updates the existing type instead of creating one.
 */
function existingTypeNotice(
  c: Collector,
  index: ModelIndex,
  target: IssueTarget,
  kind: "assetType" | "aspectType",
  idSuffix: string,
  hasBaseline: boolean,
): void {
  const ext = index.external;
  if (!ext || hasBaseline || !idSuffix) return;
  const id = `${ext.tenant}.${idSuffix}`;
  const existing = kind === "assetType" ? ext.assetType(id) : ext.aspectType(id);
  if (!existing) return;
  c.add("warning", "EXISTS_IN_TENANT", { ...target, field: "idSuffix" },
    `${id} already exists in tenant ${ext.tenant} (“${existing.name}”); deploying this project type updates the existing one.`,
    { hint: "Import the existing type from the Tenant model page to start from its current definition, or choose another id." });
}

interface VariableContext {
  owner: "aspectType" | "assetType";
  category?: AspectCategory;
}

function checkVariable(c: Collector, target: IssueTarget, v: VariableDef, ctx: VariableContext): void {
  const t: IssueTarget = { ...target, memberUid: v.uid };
  const label = v.name || "(unnamed)";
  if (!v.name) {
    c.add("error", "VAR_NAME_REQUIRED", { ...t, field: "name" }, "Variable name is required.");
  } else {
    if (!PATTERNS.variableName.test(v.name)) {
      c.add("error", "VAR_NAME_PATTERN", { ...t, field: "name" }, `Variable "${label}" must start with a letter or _ and contain only letters, digits and _.`);
    }
    if (v.name.length > LIMITS.variableNameMax) {
      c.add("error", "VAR_NAME_TOO_LONG", { ...t, field: "name" }, `Variable "${label}" is longer than ${LIMITS.variableNameMax} characters.`);
    }
    if (isReservedWord(v.name)) {
      c.add("error", "VAR_NAME_RESERVED", { ...t, field: "name" }, `"${v.name}" is a reserved word and cannot be used as a variable name.`);
    }
  }
  const isDynamic = ctx.owner === "aspectType" && ctx.category === "dynamic";
  if (v.dataType === "BIG_STRING" && !isDynamic) {
    c.add("error", "VAR_BIG_STRING_STATIC", { ...t, field: "dataType" }, `Variable "${label}": BIG_STRING can only be used by variables in dynamic aspect types.`);
  }
  if (v.length !== undefined) {
    if (!supportsLength(v.dataType)) {
      c.add("error", "VAR_LENGTH_UNSUPPORTED", { ...t, field: "length" }, `Variable "${label}": length is only allowed for STRING and BIG_STRING.`);
    } else {
      const max = maxLengthFor(v.dataType)!;
      if (v.length < 1 || v.length > max) {
        c.add("error", "VAR_LENGTH_RANGE", { ...t, field: "length" }, `Variable "${label}": length must be between 1 and ${max} for ${v.dataType}.`);
      }
    }
  }
  if (v.unit) {
    if (v.unit.length > LIMITS.unitMax) {
      c.add("error", "VAR_UNIT_TOO_LONG", { ...t, field: "unit" }, `Variable "${label}": unit is longer than ${LIMITS.unitMax} characters.`);
    }
    if (!PATTERNS.noSingleQuote.test(v.unit)) {
      c.add("error", "VAR_UNIT_QUOTE", { ...t, field: "unit" }, `Variable "${label}": unit must not contain a single quote.`);
    }
  }
  if (v.defaultValue !== undefined) {
    if (isDynamic) {
      c.add("error", "VAR_DEFAULT_DYNAMIC", { ...t, field: "defaultValue" }, `Variable "${label}": default values are only available for static variables, not for dynamic aspect variables.`);
    } else {
      const err = checkValue(v.dataType, v.defaultValue, v.length);
      if (err) c.add("error", "VAR_DEFAULT_INVALID", { ...t, field: "defaultValue" }, `Variable "${label}" default value: ${err}`);
    }
  }
  if (v.qualityCode && ctx.owner === "assetType") {
    c.add("warning", "VAR_QUALITY_CODE_ASSET_TYPE", { ...t, field: "qualityCode" }, `Variable "${label}": qualityCode only applies to aspect type variables and is ignored on asset types.`);
  }
  if (v.baseline) {
    if (v.baseline.dataType !== v.dataType) {
      c.add("error", "VAR_DATATYPE_IMMUTABLE", { ...t, field: "dataType" }, `Variable "${label}": dataType cannot be changed after creation (was ${v.baseline.dataType}).`, {
        hint: "Use “Delete and recreate” to replace the variable; existing values are lost.",
      });
    }
    if (v.baseline.searchable !== v.searchable) {
      c.add("error", "VAR_SEARCHABLE_IMMUTABLE", { ...t, field: "searchable" }, `Variable "${label}": searchable cannot be changed after creation (was ${String(v.baseline.searchable)}).`, {
        hint: "Use “Delete and recreate” to replace the variable; existing values are lost.",
      });
    }
    const before = v.baseline.length;
    const after = v.length;
    if (before !== undefined && supportsLength(v.dataType)) {
      if (isDynamic && after !== before) {
        c.add("error", "VAR_LENGTH_DYNAMIC_IMMUTABLE", { ...t, field: "length" }, `Variable "${label}": the length of a dynamic STRING variable cannot be changed (was ${before}).`);
      } else if (after === undefined || after < before) {
        c.add("error", "VAR_LENGTH_DECREASE", { ...t, field: "length" }, `Variable "${label}": length can only be increased (was ${before}).`);
      }
    }
  }
}

function checkUniqueNames<T>(
  items: T[],
  name: (item: T) => string,
  onDuplicate: (item: T, first: T) => void,
): void {
  const seen = new Map<string, T>();
  for (const item of items) {
    const n = name(item);
    if (!n) continue;
    const first = seen.get(lc(n));
    if (first !== undefined) onDuplicate(item, first);
    else seen.set(lc(n), item);
  }
}

function limitIssue(
  c: Collector,
  settings: GuardrailSettings,
  kind: "recommended" | "technical",
  code: string,
  target: IssueTarget,
  actual: number,
  max: number,
  message: string,
  hint?: string,
): void {
  if (actual <= max) return;
  const severity: Severity =
    kind === "recommended" ? "warning" : settings.profile === "technical" ? "error" : "info";
  c.add(severity, code, target, message, { limit: { kind, max, actual }, hint });
}

function checkFileAssignments(
  c: Collector,
  index: ModelIndex,
  target: IssueTarget,
  assignments: FileAssignmentDef[],
): void {
  const keys = new Set<string>();
  for (const fa of assignments) {
    const t = { ...target, field: `fileAssignments.${fa.key}` };
    if (!PATTERNS.fileKey.test(fa.key)) {
      c.add("error", "FILE_KEY_PATTERN", t, `File assignment key "${fa.key}" may only contain letters, digits and _.`);
    }
    if (keys.has(lc(fa.key))) c.add("error", "FILE_KEY_DUPLICATE", t, `Duplicate file assignment key "${fa.key}".`);
    keys.add(lc(fa.key));
    if (!index.files.has(fa.fileUid)) c.add("error", "FILE_ASSIGNMENT_MISSING", t, `File assignment "${fa.key}" references a file that is not in the project.`);
  }
}

function checkLocation(c: Collector, target: IssueTarget, loc: Location | undefined): void {
  if (!loc) return;
  const t = { ...target, field: "location" };
  for (const key of ["country", "region", "locality", "streetAddress", "postalCode"] as const) {
    const val = loc[key];
    if (val && val.length > LIMITS.locationFieldMax) {
      c.add("error", "LOCATION_FIELD_TOO_LONG", { ...t, field: `location.${key}` }, `Location ${key} is longer than ${LIMITS.locationFieldMax} characters.`);
    }
  }
  if (loc.locality && !PATTERNS.locality.test(loc.locality)) {
    c.add("error", "LOCATION_LOCALITY_PATTERN", { ...t, field: "location.locality" }, "Locality contains characters that are not allowed.");
  }
  if (loc.latitude !== undefined && (loc.latitude < -90 || loc.latitude > 90)) {
    c.add("error", "LOCATION_LATITUDE", { ...t, field: "location.latitude" }, "Latitude must be between -90 and 90.");
  }
  if (loc.longitude !== undefined && (loc.longitude < -180 || loc.longitude > 180)) {
    c.add("error", "LOCATION_LONGITUDE", { ...t, field: "location.longitude" }, "Longitude must be between -180 and 180.");
  }
}

// ---------------------------------------------------------------------------

function validateAspectTypes(c: Collector, index: ModelIndex, settings: GuardrailSettings): void {
  const { project } = index;
  const target = (t: AspectTypeDef): IssueTarget => ({ kind: "aspectType", uid: t.uid, label: t.name || t.idSuffix || "(unnamed aspect type)" });

  checkUniqueNames(project.aspectTypes, (t) => t.idSuffix, (t, first) =>
    c.add("error", "ASPECT_TYPE_ID_DUPLICATE", { ...target(t), field: "idSuffix" }, `Aspect type id "${t.idSuffix}" is already used by "${first.name}" (ids are case-insensitive).`),
  );
  checkUniqueNames(project.aspectTypes, (t) => t.name, (t, first) =>
    c.add("error", "ASPECT_TYPE_NAME_DUPLICATE", { ...target(t), field: "name" }, `Aspect type name "${t.name}" conflicts with "${first.name}" (names are case-insensitive).`),
  );

  for (const t of project.aspectTypes) {
    const tg = target(t);
    checkIdSuffix(c, tg, t.idSuffix);
    existingTypeNotice(c, index, tg, "aspectType", t.idSuffix, !!t.baseline);
    if (!t.name) c.add("error", "NAME_REQUIRED", { ...tg, field: "name" }, "Aspect type name is required.");
    else {
      if (!PATTERNS.aspectTypeName.test(t.name)) c.add("error", "ASPECT_TYPE_NAME_PATTERN", { ...tg, field: "name" }, `Aspect type name "${t.name}" may only contain letters, digits and _.`);
      if (t.name.length > LIMITS.aspectTypeNameMax) c.add("error", "NAME_TOO_LONG", { ...tg, field: "name" }, `Name is longer than ${LIMITS.aspectTypeNameMax} characters.`);
    }
    checkDescription(c, tg, t.description, true);
    if (t.variables.length === 0) c.add("error", "ASPECT_TYPE_NO_VARIABLES", tg, "An aspect type needs at least one variable.");

    if (t.baseline) {
      if (t.baseline.name !== t.name) c.add("error", "ASPECT_TYPE_NAME_IMMUTABLE", { ...tg, field: "name" }, `Aspect type name cannot be changed after creation (was "${t.baseline.name}").`);
      if (t.baseline.idSuffix !== t.idSuffix) c.add("error", "ID_IMMUTABLE", { ...tg, field: "idSuffix" }, `Type id cannot be changed after creation (was "${t.baseline.idSuffix}").`);
      if (t.baseline.category !== t.category) c.add("error", "ASPECT_TYPE_CATEGORY_IMMUTABLE", { ...tg, field: "category" }, `Category cannot be changed after creation (was ${t.baseline.category}).`);
    }

    for (const v of t.variables) checkVariable(c, tg, v, { owner: "aspectType", category: t.category });
    checkUniqueNames(t.variables, (v) => v.name, (v) =>
      c.add("error", "VAR_NAME_DUPLICATE", { ...tg, memberUid: v.uid, field: "name" }, `Variable name "${v.name}" is used more than once (names are case-insensitive).`),
    );

    const n = t.variables.length;
    limitIssue(c, settings, "recommended", "REC_ASPECT_TYPE_VARIABLES", tg, n, settings.recommended.maxVariablesPerAspectType,
      `${n} variables — recommended maximum per aspect type is ${settings.recommended.maxVariablesPerAspectType}.`,
      "Split the variables into purpose-specific aspect types.");
    limitIssue(c, settings, "technical", "TECH_ASPECT_TYPE_VARIABLES", tg, n, TECHNICAL_LIMITS.maxVariablesPerAspectType,
      `${n} variables — technical limit per aspect type is ${TECHNICAL_LIMITS.maxVariablesPerAspectType}.`,
      `Split across ${Math.ceil(n / TECHNICAL_LIMITS.maxVariablesPerAspectType)} aspect types.`);
  }
}

function familyVariableNames(index: ModelIndex, t: AssetTypeDef): Map<string, string> {
  // name (lower) → owner label, for every variable and aspect in ancestors and descendants
  const out = new Map<string, string>();
  const resolved = index.resolveAssetType({ kind: "project", uid: t.uid });
  for (const v of resolved?.variables ?? []) {
    if (v.inherited) out.set(`var:${lc(v.name)}`, v.definedOnName);
  }
  for (const a of resolved?.aspects ?? []) {
    if (a.inherited) out.set(`aspect:${lc(a.name)}`, a.definedOnName);
  }
  for (const d of index.descendantTypesOf(t.uid)) {
    for (const v of d.variables) if (!out.has(`var:${lc(v.name)}`)) out.set(`var:${lc(v.name)}`, d.name);
    for (const a of d.aspects) if (!out.has(`aspect:${lc(a.name)}`)) out.set(`aspect:${lc(a.name)}`, d.name);
  }
  return out;
}

function validateAssetTypes(c: Collector, index: ModelIndex, settings: GuardrailSettings): void {
  const { project } = index;
  const target = (t: AssetTypeDef): IssueTarget => ({ kind: "assetType", uid: t.uid, label: t.name || t.idSuffix || "(unnamed asset type)" });

  limitIssue(c, settings, "recommended", "REC_ASSET_TYPE_COUNT", { kind: "project", uid: project.id, label: project.name },
    project.assetTypes.length, settings.recommended.maxAssetTypes,
    `${project.assetTypes.length} asset types — recommended maximum is ${settings.recommended.maxAssetTypes} overall.`,
    "Well-defined types are usually sufficient for thousands of assets; merge near-duplicate types.");

  checkUniqueNames(project.assetTypes, (t) => t.idSuffix, (t, first) =>
    c.add("error", "ASSET_TYPE_ID_DUPLICATE", { ...target(t), field: "idSuffix" }, `Asset type id "${t.idSuffix}" is already used by "${first.name}" (ids are case-insensitive).`),
  );
  checkUniqueNames(project.assetTypes, (t) => t.name, (t, first) =>
    c.add("error", "ASSET_TYPE_NAME_DUPLICATE", { ...target(t), field: "name" }, `Asset type name "${t.name}" conflicts with "${first.name}" (names are case-insensitive).`),
  );

  for (const t of project.assetTypes) {
    const tg = target(t);
    checkIdSuffix(c, tg, t.idSuffix);
    existingTypeNotice(c, index, tg, "assetType", t.idSuffix, !!t.baseline);
    if (!t.name) c.add("error", "NAME_REQUIRED", { ...tg, field: "name" }, "Asset type name is required.");
    else {
      if (!PATTERNS.assetTypeName.test(t.name)) c.add("error", "ASSET_TYPE_NAME_PATTERN", { ...tg, field: "name" }, `Asset type name "${t.name}" may only contain letters, digits, _, . and spaces.`);
      if (t.name.length > LIMITS.typeNameMax) c.add("error", "NAME_TOO_LONG", { ...tg, field: "name" }, `Name is longer than ${LIMITS.typeNameMax} characters.`);
    }
    checkDescription(c, tg, t.description, false);
    if (t.baseline) {
      if (t.baseline.idSuffix !== t.idSuffix) c.add("error", "ID_IMMUTABLE", { ...tg, field: "idSuffix" }, `Type id cannot be changed after creation (was "${t.baseline.idSuffix}").`);
      if (t.baseline.instantiable && !t.instantiable) c.add("error", "INSTANTIABLE_IMMUTABLE", { ...tg, field: "instantiable" }, "An instantiable type cannot be changed to be non-instantiable.");
    }

    const resolved = index.resolveAssetType({ kind: "project", uid: t.uid });
    if (!resolved) continue;
    if (resolved.cyclic) {
      c.add("error", "ASSET_TYPE_CYCLE", { ...tg, field: "parent" }, "The parent chain of this type is cyclic.");
    }
    const parentResolved = index.resolveAssetType(t.parent);
    if (!parentResolved) {
      c.add("error", "PARENT_TYPE_MISSING", { ...tg, field: "parent" }, "The parent type does not exist.");
    } else if (t.parent.kind === "core" && index.core.descendsFrom(t.parent.id, ROOT_HIERARCHY_TYPE_ID)) {
      c.add("error", "PARENT_ROOT_HIERARCHY", { ...tg, field: "parent" }, `Root hierarchy types (${t.parent.id}) are reserved for tenant/subtenant roots and cannot be extended.`);
    } else if (t.parent.kind === "external" && !parentResolved.known) {
      c.add("info", "PARENT_EXTERNAL", { ...tg, field: "parent" }, `Parent ${t.parent.id} must exist in the target tenant; its variables are unknown offline, so counts are lower bounds. Link the project to the tenant to resolve it.`);
    }

    limitIssue(c, settings, "technical", "TECH_ASSET_TYPE_DEPTH", tg, resolved.depth, TECHNICAL_LIMITS.maxAssetTypeDepth,
      `Inheritance depth ${resolved.depth} — technical limit is ${TECHNICAL_LIMITS.maxAssetTypeDepth}. ${GUARDRAIL_NOTES.assetTypeDepth}`,
      "Flatten the hierarchy: move variables from intermediate types into aspects and inherit from core.basicasset.");
    limitIssue(c, settings, "technical", "TECH_DIRECT_VARIABLES", tg, t.variables.length, TECHNICAL_LIMITS.maxDirectVariablesPerAssetType,
      `${t.variables.length} direct variables — technical limit is ${TECHNICAL_LIMITS.maxDirectVariablesPerAssetType}.`,
      "Shift direct variables into a reusable static aspect type.");
    const aspectCount = resolved.aspects.length;
    limitIssue(c, settings, "recommended", "REC_ASSET_TYPE_ASPECTS", tg, aspectCount, settings.recommended.maxAspectsPerAssetType,
      `${aspectCount} aspects (incl. inherited) — recommended maximum is ${settings.recommended.maxAspectsPerAssetType}.`,
      "Merge related aspects; keep variables per aspect within limits.");
    limitIssue(c, settings, "technical", "TECH_ASSET_TYPE_ASPECTS", tg, aspectCount, TECHNICAL_LIMITS.maxAspectsPerAssetType,
      `${aspectCount} aspects (incl. inherited) — technical limit is ${TECHNICAL_LIMITS.maxAspectsPerAssetType}.`,
      "Reduce aspects by increasing variables per aspect (max 20 each).");
    limitIssue(c, settings, "recommended", "REC_ASSET_TYPE_VARIABLES", tg, resolved.totalVariableCount, settings.recommended.maxVariablesPerAssetType,
      `${resolved.totalVariableCount} variables (incl. inherited and aspects) — recommended maximum is ${settings.recommended.maxVariablesPerAssetType}.`,
      "Create purpose-specific asset types instead of one large type.");

    // Variables
    for (const v of t.variables) checkVariable(c, tg, v, { owner: "assetType" });
    checkUniqueNames(t.variables, (v) => v.name, (v) =>
      c.add("error", "VAR_NAME_DUPLICATE", { ...tg, memberUid: v.uid, field: "name" }, `Variable name "${v.name}" is used more than once (names are case-insensitive).`),
    );
    const family = familyVariableNames(index, t);
    for (const v of t.variables) {
      const owner = v.name ? family.get(`var:${lc(v.name)}`) : undefined;
      if (owner) {
        c.add("error", "VAR_NAME_FAMILY_CONFLICT", { ...tg, memberUid: v.uid, field: "name" }, `Variable "${v.name}" is also defined on "${owner}" — names must be unique in the whole type family (ancestors and descendants).`);
      }
    }

    // Aspects
    checkUniqueNames(t.aspects, (a) => a.name, (a) =>
      c.add("error", "ASPECT_NAME_DUPLICATE", { ...tg, memberUid: a.uid, field: "name" }, `Aspect name "${a.name}" is used more than once (names are case-insensitive).`),
    );
    for (const a of t.aspects) {
      const at = { ...tg, memberUid: a.uid };
      if (!a.name) c.add("error", "ASPECT_NAME_REQUIRED", { ...at, field: "name" }, "Aspect name is required.");
      else {
        if (!PATTERNS.aspectName.test(a.name)) c.add("error", "ASPECT_NAME_PATTERN", { ...at, field: "name" }, `Aspect name "${a.name}" may only contain letters, digits and _.`);
        if (a.name.length > LIMITS.aspectNameMax) c.add("error", "ASPECT_NAME_TOO_LONG", { ...at, field: "name" }, `Aspect name is longer than ${LIMITS.aspectNameMax} characters.`);
        if (isReservedWord(a.name)) c.add("error", "ASPECT_NAME_RESERVED", { ...at, field: "name" }, `"${a.name}" is a reserved word and cannot be used as an aspect name.`);
        const owner = family.get(`aspect:${lc(a.name)}`);
        if (owner) c.add("error", "ASPECT_NAME_FAMILY_CONFLICT", { ...at, field: "name" }, `Aspect "${a.name}" is also defined on "${owner}" — aspect names must be unique in the type family.`);
      }
      if (!index.resolveAspectType(a.aspectType)) {
        c.add("error", "ASPECT_TYPE_MISSING", { ...at, field: "aspectType" }, `Aspect "${a.name}" references an aspect type that does not exist.`);
      }
    }
    checkFileAssignments(c, index, tg, t.fileAssignments);
  }
}

function staticVariablesByName(resolved: ResolvedAssetType): Map<string, VariableLike> {
  return new Map(resolved.variables.map((v) => [lc(v.name), v]));
}

function validateAssets(c: Collector, index: ModelIndex, settings: GuardrailSettings): number {
  const { project } = index;
  const roots = project.assets.filter((a) => a.parentUid === null);
  if (!index.root) {
    c.add("error", "ROOT_MISSING", { kind: "project", uid: project.id, label: project.name }, "The project has no root placeholder asset.");
  }
  for (const r of roots) {
    if (r.uid !== ROOT_ASSET_UID) {
      c.add("error", "ASSET_NO_PARENT", { kind: "asset", uid: r.uid, label: r.name }, "Only the tenant root may have no parent.");
    }
  }

  // Sibling name uniqueness (case-insensitive) — deployment matches assets by parent + name.
  const siblingNames = new Map<string, AssetDef>();
  let totalAttributes = 0;
  const typeCache = new Map<string, { resolved?: ResolvedAssetType; staticVars: Map<string, VariableLike> }>();

  for (const a of project.assets) {
    if (a.uid === ROOT_ASSET_UID) continue;
    const tg: IssueTarget = { kind: "asset", uid: a.uid, label: a.name || "(unnamed asset)" };

    if (!a.name) c.add("error", "NAME_REQUIRED", { ...tg, field: "name" }, "Asset name is required.");
    else {
      if (a.name.length > LIMITS.assetNameMax) c.add("error", "NAME_TOO_LONG", { ...tg, field: "name" }, `Name is longer than ${LIMITS.assetNameMax} characters.`);
      if (!PATTERNS.assetName.test(a.name)) c.add("error", "ASSET_NAME_PATTERN", { ...tg, field: "name" }, "Asset name must not contain / or \\.");
    }
    checkDescription(c, tg, a.description, true);
    if (a.externalId && a.externalId.length > LIMITS.externalIdMax) {
      c.add("error", "EXTERNAL_ID_TOO_LONG", { ...tg, field: "externalId" }, `External id is longer than ${LIMITS.externalIdMax} characters.`);
    }

    // Parent & hierarchy
    if (a.parentUid !== null) {
      if (!index.assets.has(a.parentUid)) {
        c.add("error", "PARENT_ASSET_MISSING", { ...tg, field: "parentUid" }, "The parent asset does not exist.");
      } else if (!index.isAttached(a.uid)) {
        c.add("error", "ASSET_CYCLE", { ...tg, field: "parentUid" }, "The asset's parent chain is cyclic.");
      } else {
        const level = index.levelOf(a.uid);
        limitIssue(c, settings, "technical", "TECH_HIERARCHY_DEPTH", tg, level, TECHNICAL_LIMITS.maxAssetHierarchyDepth,
          `Hierarchy level ${level} — technical limit is ${TECHNICAL_LIMITS.maxAssetHierarchyDepth}. ${GUARDRAIL_NOTES.assetHierarchyDepth}`,
          "Flatten the hierarchy: group by attributes instead of extra levels.");
      }
      if (a.name) {
        const key = `${a.parentUid}\u0000${lc(a.name)}`;
        const first = siblingNames.get(key);
        if (first) c.add("error", "ASSET_SIBLING_DUPLICATE", { ...tg, field: "name" }, `Another asset under the same parent is named "${first.name}" (case-insensitive). Deployment matches assets by parent and name.`);
        else siblingNames.set(key, a);
      }
    }

    // Timezone & twin type (create-only)
    if (a.timezone !== undefined) {
      const check = checkTimezone(a.timezone);
      const msg = timezoneMessage(check, a.timezone);
      if (msg) c.add("error", "TIMEZONE_INVALID", { ...tg, field: "timezone" }, msg);
    }
    if (a.baseline) {
      if ((a.baseline.timezone ?? "") !== (a.timezone ?? "")) {
        c.add("error", "TIMEZONE_IMMUTABLE", { ...tg, field: "timezone" }, `Timezone can only be set at creation (was "${a.baseline.timezone ?? "tenant default"}").`);
      }
      if (a.baseline.twinType !== a.twinType) {
        c.add("error", "TWIN_TYPE_IMMUTABLE", { ...tg, field: "twinType" }, `Twin type can only be set at creation (was ${a.baseline.twinType}).`);
      }
    }
    checkLocation(c, tg, a.location);
    checkFileAssignments(c, index, tg, a.fileAssignments);

    // Type
    const key = a.type.kind === "project" ? `p:${a.type.uid}` : `${a.type.kind}:${a.type.id}`;
    let cached = typeCache.get(key);
    if (!cached) {
      const resolved = index.resolveAssetType(a.type);
      cached = { resolved, staticVars: resolved ? staticVariablesByName(resolved) : new Map() };
      typeCache.set(key, cached);
    }
    const resolved = cached.resolved;
    if (!resolved) {
      c.add("error", "ASSET_TYPE_MISSING", { ...tg, field: "type" }, "The asset type does not exist.");
      totalAttributes += 1;
      continue;
    }
    if (resolved.known && !resolved.instantiable) {
      c.add("error", "ASSET_TYPE_ABSTRACT", { ...tg, field: "type" }, `"${resolved.name}" is not instantiable (abstract) — choose an instantiable type.`);
    }
    if (resolved.chain.some((r) => r.kind === "core" && lc(r.id) === ROOT_HIERARCHY_TYPE_ID)) {
      c.add("error", "ASSET_ROOT_TYPE", { ...tg, field: "type" }, "Assets derived from a root hierarchy type cannot be created via the API (reserved for tenant roots).");
    }
    if (a.type.kind === "core" && lc(a.type.id) !== BASIC_ASSET_TYPE_ID) {
      c.add("info", "ASSET_OOTB_TYPE", { ...tg, field: "type" }, `Instances of OOTB type ${a.type.id} count 1 asset attribute each.`);
    }

    // Values
    const seenVar = new Set<string>();
    for (const val of a.variables) {
      const vt = { ...tg, field: `variables.${val.name}` };
      if (seenVar.has(lc(val.name))) c.add("error", "VALUE_DUPLICATE", vt, `Value for "${val.name}" is set twice.`);
      seenVar.add(lc(val.name));
      const def = cached.staticVars.get(lc(val.name));
      if (!def) {
        c.add(resolved.incomplete ? "warning" : "error", "VALUE_UNKNOWN_VARIABLE", vt, `"${val.name}" is not a variable of type "${resolved.name}".`);
        continue;
      }
      const err = checkValue(def.dataType, val.value, def.length);
      if (err) c.add("error", "VALUE_INVALID", vt, `"${val.name}": ${err}`);
    }
    const aspectsByName = new Map(resolved.aspects.map((x) => [lc(x.name), x]));
    for (const av of a.aspects) {
      const at = { ...tg, field: `aspects.${av.name}` };
      const aspect = aspectsByName.get(lc(av.name));
      if (!aspect) {
        c.add(resolved.incomplete ? "warning" : "error", "VALUE_UNKNOWN_ASPECT", at, `"${av.name}" is not an aspect of type "${resolved.name}".`);
        continue;
      }
      if (aspect.aspectType.category === "dynamic" && av.variables.length > 0) {
        c.add("error", "VALUE_DYNAMIC_ASPECT", at, `"${av.name}" is a dynamic (time series) aspect; static values cannot be set.`);
        continue;
      }
      const vars = new Map(aspect.aspectType.variables.map((v) => [lc(v.name), v]));
      for (const val of av.variables) {
        const def = vars.get(lc(val.name));
        const vt = { ...tg, field: `aspects.${av.name}.${val.name}` };
        if (!def) {
          c.add(aspect.aspectType.known ? "error" : "warning", "VALUE_UNKNOWN_VARIABLE", vt, `"${val.name}" is not a variable of aspect "${av.name}".`);
          continue;
        }
        const err = checkValue(def.dataType, val.value, def.length);
        if (err) c.add("error", "VALUE_INVALID", vt, `"${av.name}.${val.name}": ${err}`);
      }
    }

    const attrs = Math.max(1, resolved.billableAttributes);
    totalAttributes += attrs;
    limitIssue(c, settings, "technical", "TECH_ATTRIBUTES_PER_ASSET", tg, attrs, TECHNICAL_LIMITS.maxAttributesPerAsset,
      `${attrs} asset attributes — technical limit per asset is ${TECHNICAL_LIMITS.maxAttributesPerAsset}.`,
      "Use a purpose-specific asset type with fewer aspects.");
  }
  return totalAttributes;
}

function validateFiles(c: Collector, index: ModelIndex): void {
  const { project } = index;
  checkUniqueNames(project.files, (f) => f.name, (f) =>
    c.add("warning", "FILE_NAME_DUPLICATE", { kind: "file", uid: f.uid, label: f.name, field: "name" }, `Another file is also named "${f.name}"; deployments match existing files by name.`),
  );
  for (const f of project.files) {
    const tg: IssueTarget = { kind: "file", uid: f.uid, label: f.name || "(unnamed file)" };
    if (!f.name) c.add("error", "NAME_REQUIRED", { ...tg, field: "name" }, "File name is required.");
    else {
      if (!PATTERNS.fileName.test(f.name)) c.add("error", "FILE_NAME_PATTERN", { ...tg, field: "name" }, "File name must not contain whitespace or any of * & % / \\.");
      if (f.name.length > LIMITS.fileNameMax) c.add("error", "NAME_TOO_LONG", { ...tg, field: "name" }, `File name is longer than ${LIMITS.fileNameMax} characters.`);
    }
    if (f.description && f.description.length > LIMITS.fileDescriptionMax) {
      c.add("error", "DESCRIPTION_TOO_LONG", { ...tg, field: "description" }, `Description is longer than ${LIMITS.fileDescriptionMax} characters.`);
    }
    if (f.size > LIMITS.fileSizeMaxBytes) c.add("error", "FILE_TOO_LARGE", { ...tg, field: "size" }, "Files may not be larger than 5 MB.");
    const mime = checkContentType(f.name, f.mimeType);
    if (!mime.ok) {
      const msg =
        mime.reason === "no-extension"
          ? "The file name has no extension; the content type cannot be verified."
          : mime.reason === "unknown-extension"
            ? `Unknown extension — the platform may reject content type ${f.mimeType}.`
            : `Content type ${f.mimeType} does not match the extension (expected ${mime.expected?.join(" or ")}).`;
      c.add(mime.reason === "mismatch" ? "error" : "warning", "FILE_CONTENT_TYPE", { ...tg, field: "mimeType" }, msg);
    }
    const usage = index.fileUsage(f.uid);
    if (usage.assets.length === 0 && usage.assetTypes.length === 0) {
      c.add("info", "FILE_UNASSIGNED", tg, "File is not assigned to any asset or asset type.");
    }
  }
}

export function validateProject(
  index: ModelIndex,
  settings: GuardrailSettings = DEFAULT_GUARDRAILS,
): ValidationResult {
  const c = new Collector();
  validateAspectTypes(c, index, settings);
  validateAssetTypes(c, index, settings);
  const totalAttributes = validateAssets(c, index, settings);
  validateFiles(c, index);
  limitIssue(c, settings, "technical", "TECH_ATTRIBUTES_PER_TENANT", { kind: "project", uid: index.project.id, label: index.project.name },
    totalAttributes, TECHNICAL_LIMITS.maxAttributesPerTenant,
    `${totalAttributes} asset attributes in the project — technical limit per tenant is ${TECHNICAL_LIMITS.maxAttributesPerTenant}.`);

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  const issues = c.issues.sort((a, b) => order[a.severity] - order[b.severity]);
  const byEntity = new Map<string, Issue[]>();
  for (const i of issues) {
    const list = byEntity.get(i.target.uid) ?? [];
    list.push(i);
    byEntity.set(i.target.uid, list);
  }
  return {
    issues,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    infos: issues.filter((i) => i.severity === "info").length,
    byEntity,
  };
}
