// Spreadsheet tables (CSV / XLSX) for the project model.
//
// Export: one table per entity collection. References between tables use
// natural keys that survive an Excel round trip:
//   - project types by idSuffix, core types by their id (`core.*`), external
//     types by their full id (`<tenant>.<id>`);
//   - assets by parentPath (" / "-joined names below the tenant root) + name,
//     and by uid when present.
//
// Import: rows are matched by uid when present, otherwise by natural key
// (idSuffix for types, owner + name for variables/aspects, parentPath + name
// for assets; case-insensitive). The planner produces a preview per row
// (create / update / unchanged / error with Change[] diffs) and the final
// version of every entity that changes; applyTableImport() writes them in one
// undoable store.apply. Imports never delete and never touch baselines (the
// validator then reports immutability violations).
//
// Cell semantics: a column that is absent leaves the field untouched; a
// present but empty cell clears an optional field (required fields report an
// error).

import type { CoreLibraryIndex } from "@/domain/coreLibrary";
import { diffValues, type Change } from "@/domain/diff";
import {
  ASPECT_CATEGORIES,
  DATA_TYPES,
  ROOT_ASSET_UID,
  TWIN_TYPES,
  newUid,
  type AspectCategory,
  type AspectTypeDef,
  type AssetDef,
  type AssetTypeDef,
  type DataType,
  type Location,
  type Project,
  type TwinType,
  type TypeRef,
  type VariableDef,
  type VariableValue,
} from "@/domain/model";
import {
  DomainError,
  renameAspect,
  renameAspectTypeVariable,
  renameAssetTypeVariable,
  toIdentifier,
  uniqueName,
} from "@/domain/ops";
import { ModelIndex, TENANT_PLACEHOLDER, type ResolvedAssetType } from "@/domain/resolve";
import { checkTimezone, timezoneMessage } from "@/domain/timezone";
import { checkValue } from "@/domain/values";
import { toCsv, type CsvTable } from "./csv";

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

export const TABLE_NAMES = [
  "AspectTypes",
  "AspectTypeVariables",
  "AssetTypes",
  "AssetTypeVariables",
  "AssetTypeAspects",
  "Assets",
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

export const BOOLEAN_VALUES = ["true", "false"] as const;

export interface ColumnDef {
  key: string;
  description: string;
  /** Allowed values (used for XLSX data validation lists). */
  list?: readonly string[];
  /** Written as a number in XLSX. */
  numeric?: boolean;
}

export const TABLE_DESCRIPTIONS: Record<TableName, string> = {
  AspectTypes: "One row per aspect type of the project.",
  AspectTypeVariables: "One row per variable of an aspect type.",
  AssetTypes: "One row per asset type of the project.",
  AssetTypeVariables: "One row per static variable defined directly on an asset type.",
  AssetTypeAspects: "One row per aspect defined directly on an asset type.",
  Assets:
    "One row per asset (the tenant root placeholder is not listed). Columns var:<variable> hold static variable values, " +
    "aspect:<aspect>.<variable> hold values of static aspects. Add such a column to set a value that is not exported yet.",
};

const UID_COL: ColumnDef = {
  key: "uid",
  description: "Local unique id. Keep it to update the row's entity; leave empty to create a new one (matched by natural key).",
};
const VARIABLE_COLS: ColumnDef[] = [
  UID_COL,
  { key: "name", description: "Variable name (letters, digits, _; must start with a letter or _)." },
  { key: "dataType", description: "Data type.", list: DATA_TYPES },
  { key: "unit", description: "Unit (optional, max 32 characters, no single quote)." },
  { key: "searchable", description: "true / false.", list: BOOLEAN_VALUES },
  { key: "length", description: "Length for STRING / BIG_STRING (optional).", numeric: true },
  { key: "defaultValue", description: "Default value for static variables (optional; must fit the data type)." },
];

export const TABLE_COLUMNS: Record<TableName, ColumnDef[]> = {
  AspectTypes: [
    UID_COL,
    { key: "idSuffix", description: "Type id without tenant prefix (deployed as <tenant>.<idSuffix>)." },
    { key: "name", description: "Aspect type name (letters, digits, _)." },
    { key: "category", description: "static or dynamic.", list: ASPECT_CATEGORIES },
    { key: "description", description: "Description (optional)." },
  ],
  AspectTypeVariables: [
    { key: "aspectType", description: "idSuffix of the owning aspect type." },
    ...VARIABLE_COLS,
    { key: "qualityCode", description: "true / false (optional).", list: BOOLEAN_VALUES },
  ],
  AssetTypes: [
    UID_COL,
    { key: "idSuffix", description: "Type id without tenant prefix (deployed as <tenant>.<idSuffix>)." },
    { key: "name", description: "Asset type name." },
    { key: "description", description: "Description (optional)." },
    {
      key: "parent",
      description:
        "Parent type: a core id (core.basicasset), the idSuffix of a project asset type, or the full id of an external tenant type.",
    },
    { key: "instantiable", description: "true / false.", list: BOOLEAN_VALUES },
  ],
  AssetTypeVariables: [{ key: "assetType", description: "idSuffix of the owning asset type." }, ...VARIABLE_COLS],
  AssetTypeAspects: [
    { key: "assetType", description: "idSuffix of the owning asset type." },
    UID_COL,
    { key: "name", description: "Aspect name inside the asset type (letters, digits, _)." },
    {
      key: "aspectType",
      description: "Aspect type: idSuffix of a project aspect type, a core id (core.*) or the full id of an external type.",
    },
  ],
  Assets: [
    UID_COL,
    { key: "parentPath", description: 'Names of the ancestors below the tenant root, joined with " / " (empty = directly under the root).' },
    { key: "parentUid", description: "uid of the parent asset (root = directly under the tenant root)." },
    { key: "name", description: "Asset name (no / or \\)." },
    { key: "type", description: "Asset type: project idSuffix, core id (core.*) or full id of an external type." },
    { key: "externalId", description: "External id (optional)." },
    { key: "description", description: "Description (optional)." },
    { key: "timezone", description: "Java time zone id, e.g. Europe/Berlin (optional, create-only)." },
    { key: "twinType", description: "performance or simulation (create-only).", list: TWIN_TYPES },
    { key: "country", description: "Location: country (optional)." },
    { key: "region", description: "Location: region (optional)." },
    { key: "locality", description: "Location: locality (optional)." },
    { key: "streetAddress", description: "Location: street address (optional)." },
    { key: "postalCode", description: "Location: postal code (optional)." },
    { key: "latitude", description: "Location: latitude -90…90 (optional).", numeric: true },
    { key: "longitude", description: "Location: longitude -180…180 (optional).", numeric: true },
  ],
};

export const VAR_PREFIX = "var:";
export const ASPECT_PREFIX = "aspect:";
export const PATH_SEPARATOR = " / ";

export interface TableData {
  name: TableName;
  headers: string[];
  rows: Record<string, string>[];
}

/** Column definition for a header (dynamic Assets columns included). */
export function columnDef(table: TableName, header: string): ColumnDef | undefined {
  const lc = header.toLowerCase();
  const fixed = TABLE_COLUMNS[table].find((c) => c.key.toLowerCase() === lc);
  if (fixed) return fixed;
  if (table === "Assets" && lc.startsWith(VAR_PREFIX)) {
    return { key: header, description: `Value of static variable "${header.slice(VAR_PREFIX.length)}".` };
  }
  if (table === "Assets" && lc.startsWith(ASPECT_PREFIX)) {
    return { key: header, description: `Value of static aspect variable "${header.slice(ASPECT_PREFIX.length)}".` };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const lc = (s: string) => s.toLowerCase();
const bool = (b: boolean | undefined) => (b === undefined ? "" : b ? "true" : "false");
const num = (n: number | undefined) => (n === undefined ? "" : String(n));

export function assetTypeRefText(index: ModelIndex, ref: TypeRef): string {
  if (ref.kind === "project") return index.assetTypes.get(ref.uid)?.idSuffix ?? "";
  return ref.id;
}

export function aspectTypeRefText(index: ModelIndex, ref: TypeRef): string {
  if (ref.kind === "project") return index.aspectTypes.get(ref.uid)?.idSuffix ?? "";
  return ref.id;
}

/** " / "-joined names from below the tenant root down to (and including) `uid`. */
export function assetPathOf(index: ModelIndex, uid: string | null): string {
  if (uid === null || uid === ROOT_ASSET_UID) return "";
  return index
    .hierarchyPath(uid)
    .filter((a) => a.uid !== ROOT_ASSET_UID)
    .map((a) => a.name)
    .join(PATH_SEPARATOR);
}

function variableRow(v: VariableDef): Record<string, string> {
  return {
    uid: v.uid,
    name: v.name,
    dataType: v.dataType,
    unit: v.unit ?? "",
    searchable: bool(v.searchable),
    length: num(v.length),
    defaultValue: v.defaultValue ?? "",
  };
}

/** Assets in hierarchy order (depth-first from the root), detached assets last. */
function orderedAssets(index: ModelIndex): AssetDef[] {
  const out: AssetDef[] = [];
  const seen = new Set<string>([ROOT_ASSET_UID]);
  for (const uid of index.descendantsOf(ROOT_ASSET_UID)) {
    const a = index.assets.get(uid);
    if (a && !seen.has(uid)) {
      out.push(a);
      seen.add(uid);
    }
  }
  for (const a of index.project.assets) if (!seen.has(a.uid)) out.push(a);
  return out;
}

interface ValueColumns {
  variables: string[];
  /** "aspect.variable" */
  aspects: string[];
}

/** Dynamic value columns: billable static variables/aspects of used types plus every stored value. */
function valueColumns(index: ModelIndex, assets: AssetDef[]): ValueColumns {
  const vars = new Map<string, string>();
  const asps = new Map<string, string>();
  const add = (m: Map<string, string>, name: string) => {
    if (name && !m.has(lc(name))) m.set(lc(name), name);
  };
  const seenTypes = new Set<string>();
  for (const a of assets) {
    const key = a.type.kind === "project" ? `p:${a.type.uid}` : `${a.type.kind}:${a.type.id}`;
    if (!seenTypes.has(key)) {
      seenTypes.add(key);
      const r = index.resolveAssetType(a.type);
      for (const v of r?.variables ?? []) if (v.billable) add(vars, v.name);
      for (const asp of r?.aspects ?? []) {
        if (asp.aspectType.category !== "static" || asp.aspectType.isCore || asp.definedOn.kind === "core") continue;
        for (const v of asp.aspectType.variables) add(asps, `${asp.name}.${v.name}`);
      }
    }
    for (const v of a.variables) add(vars, v.name);
    for (const av of a.aspects) for (const v of av.variables) add(asps, `${av.name}.${v.name}`);
  }
  const sort = (m: Map<string, string>) => [...m.values()].sort((x, y) => x.localeCompare(y));
  return { variables: sort(vars), aspects: sort(asps) };
}

export function buildExportTables(index: ModelIndex): Record<TableName, TableData> {
  const p = index.project;
  const headers = (t: TableName) => TABLE_COLUMNS[t].map((c) => c.key);
  const byName = <T extends { name: string }>(list: T[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));

  const aspectTypes = byName(p.aspectTypes);
  const assetTypes = byName(p.assetTypes);

  const AspectTypes: TableData = {
    name: "AspectTypes",
    headers: headers("AspectTypes"),
    rows: aspectTypes.map((t) => ({
      uid: t.uid,
      idSuffix: t.idSuffix,
      name: t.name,
      category: t.category,
      description: t.description ?? "",
    })),
  };
  const AspectTypeVariables: TableData = {
    name: "AspectTypeVariables",
    headers: headers("AspectTypeVariables"),
    rows: aspectTypes.flatMap((t) =>
      t.variables.map((v) => ({ aspectType: t.idSuffix, ...variableRow(v), qualityCode: bool(v.qualityCode) })),
    ),
  };
  const AssetTypes: TableData = {
    name: "AssetTypes",
    headers: headers("AssetTypes"),
    rows: assetTypes.map((t) => ({
      uid: t.uid,
      idSuffix: t.idSuffix,
      name: t.name,
      description: t.description ?? "",
      parent: assetTypeRefText(index, t.parent),
      instantiable: bool(t.instantiable),
    })),
  };
  const AssetTypeVariables: TableData = {
    name: "AssetTypeVariables",
    headers: headers("AssetTypeVariables"),
    rows: assetTypes.flatMap((t) => t.variables.map((v) => ({ assetType: t.idSuffix, ...variableRow(v) }))),
  };
  const AssetTypeAspects: TableData = {
    name: "AssetTypeAspects",
    headers: headers("AssetTypeAspects"),
    rows: assetTypes.flatMap((t) =>
      t.aspects.map((a) => ({
        assetType: t.idSuffix,
        uid: a.uid,
        name: a.name,
        aspectType: aspectTypeRefText(index, a.aspectType),
      })),
    ),
  };

  const assets = orderedAssets(index).filter((a) => a.uid !== ROOT_ASSET_UID);
  const cols = valueColumns(index, assets);
  const Assets: TableData = {
    name: "Assets",
    headers: [
      ...headers("Assets"),
      ...cols.variables.map((v) => `${VAR_PREFIX}${v}`),
      ...cols.aspects.map((a) => `${ASPECT_PREFIX}${a}`),
    ],
    rows: assets.map((a) => {
      const row: Record<string, string> = {
        uid: a.uid,
        parentPath: assetPathOf(index, a.parentUid),
        parentUid: a.parentUid ?? "",
        name: a.name,
        type: assetTypeRefText(index, a.type),
        externalId: a.externalId ?? "",
        description: a.description ?? "",
        timezone: a.timezone ?? "",
        twinType: a.twinType,
        country: a.location?.country ?? "",
        region: a.location?.region ?? "",
        locality: a.location?.locality ?? "",
        streetAddress: a.location?.streetAddress ?? "",
        postalCode: a.location?.postalCode ?? "",
        latitude: num(a.location?.latitude),
        longitude: num(a.location?.longitude),
      };
      const values = new Map(a.variables.map((v) => [lc(v.name), v.value]));
      for (const v of cols.variables) row[`${VAR_PREFIX}${v}`] = values.get(lc(v)) ?? "";
      const aspectValues = new Map<string, string>();
      for (const av of a.aspects) for (const v of av.variables) aspectValues.set(lc(`${av.name}.${v.name}`), v.value);
      for (const k of cols.aspects) row[`${ASPECT_PREFIX}${k}`] = aspectValues.get(lc(k)) ?? "";
      return row;
    }),
  };

  return { AspectTypes, AspectTypeVariables, AssetTypes, AssetTypeVariables, AssetTypeAspects, Assets };
}

export function tableToCsv(table: TableData, delimiter = ","): string {
  return toCsv(table.headers, table.rows, delimiter);
}

// ---------------------------------------------------------------------------
// Import input
// ---------------------------------------------------------------------------

export interface TableRowInput {
  /** Row number in the source (header = row 1). */
  rowNumber: number;
  cells: Record<string, string>;
}

export interface TableInputData {
  headers: string[];
  rows: TableRowInput[];
}

export type TableInput = Partial<Record<TableName, TableInputData>>;

export function fromCsvTable(t: CsvTable): TableInputData {
  return { headers: t.headers, rows: t.rows.map((cells, i) => ({ rowNumber: i + 2, cells })) };
}

const SIGNATURES: { table: TableName; all: string[]; none?: string[] }[] = [
  { table: "AspectTypeVariables", all: ["aspecttype", "datatype"] },
  { table: "AssetTypeVariables", all: ["assettype", "datatype"] },
  { table: "AssetTypeAspects", all: ["assettype", "aspecttype"], none: ["datatype"] },
  { table: "AspectTypes", all: ["category"], none: ["datatype"] },
  { table: "AssetTypes", all: ["instantiable"], none: ["parentpath"] },
  { table: "AssetTypes", all: ["parent", "idsuffix"], none: ["parentpath"] },
  { table: "Assets", all: ["parentpath"] },
  { table: "Assets", all: ["parentuid"] },
  { table: "Assets", all: ["twintype"] },
];

/** Guess which table a CSV belongs to: by its headers, else by its file name. */
export function detectTable(fileName: string, headers: string[]): TableName | undefined {
  const hs = new Set(headers.map((h) => h.trim().toLowerCase()));
  for (const s of SIGNATURES) {
    if (s.all.every((h) => hs.has(h)) && !(s.none ?? []).some((h) => hs.has(h))) return s.table;
  }
  const name = fileName.toLowerCase();
  const byLength = [...TABLE_NAMES].sort((a, b) => b.length - a.length);
  return byLength.find((t) => name.includes(t.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Import plan
// ---------------------------------------------------------------------------

export type RowAction = "create" | "update" | "unchanged" | "error";

export interface ImportRowResult {
  table: TableName;
  rowNumber: number;
  /** Display label, e.g. "Pump", "Pump.rpm", "Plant / Line 1 / Pump 1". */
  label: string;
  action: RowAction;
  /** Field changes relative to the entity (or variable/aspect) before the import. */
  changes: Change[];
  errors: string[];
  warnings: string[];
}

export interface TableImportPlan {
  projectId: string;
  /** updatedAt of the revision the plan was computed against. */
  baseUpdatedAt: string;
  rows: ImportRowResult[];
  /** Final version of every entity that changes (directly or as a side effect). */
  entities: { aspectTypes: AspectTypeDef[]; assetTypes: AssetTypeDef[]; assets: AssetDef[] };
  counts: Record<RowAction, number>;
  /** Entities changed only as a side effect (e.g. values renamed with a variable). */
  indirect: number;
  /** File-level messages (unknown columns, missing key columns, …). */
  warnings: string[];
}

class Cells {
  constructor(
    private readonly row: Record<string, string>,
    private readonly cols: Map<string, string>,
  ) {}
  has(key: string): boolean {
    return this.cols.has(key.toLowerCase());
  }
  /** Raw cell text; undefined when the column is absent. */
  raw(key: string): string | undefined {
    const h = this.cols.get(key.toLowerCase());
    return h === undefined ? undefined : (this.row[h] ?? "");
  }
  /** Trimmed cell text; undefined when the column is absent. */
  text(key: string): string | undefined {
    return this.raw(key)?.trim();
  }
}

function headerMap(headers: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of headers) {
    const k = h.trim().toLowerCase();
    if (k && !m.has(k)) m.set(k, h);
  }
  return m;
}

const TRUE = new Set(["true", "yes", "1", "y", "x"]);
const FALSE = new Set(["false", "no", "0", "n"]);

function parseBool(value: string, field: string, errors: string[]): boolean | undefined {
  if (value === "") return undefined;
  const v = value.trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  errors.push(`${field}: expected true or false, got "${value}".`);
  return undefined;
}

function parseEnum<T extends string>(value: string, values: readonly T[], field: string, errors: string[]): T | undefined {
  if (value === "") return undefined;
  const hit = values.find((v) => v.toLowerCase() === value.trim().toLowerCase());
  if (!hit) errors.push(`${field}: "${value}" is not one of ${values.join(", ")}.`);
  return hit;
}

function parseNumberCell(value: string, field: string, errors: string[], integer: boolean): number | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  const normalized = !v.includes(".") && (v.match(/,/g) ?? []).length === 1 ? v.replace(",", ".") : v;
  const re = integer ? /^[+-]?\d+$/ : /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  const n = Number(normalized);
  if (!re.test(normalized) || !Number.isFinite(n)) {
    errors.push(`${field}: "${value}" is not a ${integer ? "whole number" : "number"}.`);
    return undefined;
  }
  return n;
}

/** Optional free text: empty → undefined, but keep an existing "" so round trips stay unchanged. */
function optText(cell: string, before: string | undefined): string | undefined {
  if (cell === "") return before === "" ? "" : undefined;
  return cell;
}

function setOpt<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete obj[key];
  else obj[key] = value;
}

/** Drop undefined / "" members and empty objects; drop aspect value groups without values. */
function compact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(compact)
      .filter(
        (v) =>
          !(
            typeof v === "object" &&
            v !== null &&
            "variables" in v &&
            "name" in v &&
            Object.keys(v).length === 2 &&
            Array.isArray((v as { variables: unknown[] }).variables) &&
            (v as { variables: unknown[] }).variables.length === 0
          ),
      );
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === "") continue;
      const c = compact(v);
      if (typeof c === "object" && c !== null && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out;
  }
  return value;
}

function entityChanges(before: unknown, after: unknown): Change[] {
  return diffValues(compact(before ?? {}), compact(after));
}

type RefResult = { ref: TypeRef } | { error: string };

interface RowCtx {
  result: ImportRowResult;
  cells: Cells;
}

class ImportPlanner {
  readonly next: Project;
  readonly origIndex: ModelIndex;
  readonly rows: ImportRowResult[] = [];
  readonly warnings: string[] = [];
  /** Entities modified by rows (as opposed to side effects). */
  private readonly touched = new Set<string>();
  /** lc idSuffix → uid, current (next) keys. */
  private readonly aspectKeys = new Map<string, string>();
  private readonly assetTypeKeys = new Map<string, string>();
  /** lc idSuffix → uid, keys before the import. */
  private readonly oldAspectKeys = new Map<string, string>();
  private readonly oldAssetTypeKeys = new Map<string, string>();

  constructor(
    readonly original: Project,
    readonly core: CoreLibraryIndex,
  ) {
    this.next = structuredClone(original);
    this.origIndex = new ModelIndex(original, core);
    for (const t of original.aspectTypes) {
      if (!this.oldAspectKeys.has(lc(t.idSuffix))) this.oldAspectKeys.set(lc(t.idSuffix), t.uid);
    }
    for (const t of original.assetTypes) {
      if (!this.oldAssetTypeKeys.has(lc(t.idSuffix))) this.oldAssetTypeKeys.set(lc(t.idSuffix), t.uid);
    }
    this.rebuildKeys();
  }

  private rebuildKeys(): void {
    this.aspectKeys.clear();
    this.assetTypeKeys.clear();
    for (const t of this.next.aspectTypes) if (!this.aspectKeys.has(lc(t.idSuffix))) this.aspectKeys.set(lc(t.idSuffix), t.uid);
    for (const t of this.next.assetTypes) if (!this.assetTypeKeys.has(lc(t.idSuffix))) this.assetTypeKeys.set(lc(t.idSuffix), t.uid);
  }

  // -- lookups ---------------------------------------------------------------

  private stripTenant(key: string): string {
    const prefix = `${TENANT_PLACEHOLDER}.`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  private aspectTypeUid(key: string): string | undefined {
    const k = lc(this.stripTenant(key.trim()));
    const uid = this.aspectKeys.get(k) ?? this.oldAspectKeys.get(k);
    return uid && this.next.aspectTypes.some((t) => t.uid === uid) ? uid : undefined;
  }

  private assetTypeUid(key: string): string | undefined {
    const k = lc(this.stripTenant(key.trim()));
    const uid = this.assetTypeKeys.get(k) ?? this.oldAssetTypeKeys.get(k);
    return uid && this.next.assetTypes.some((t) => t.uid === uid) ? uid : undefined;
  }

  /** Parse an asset type reference cell. */
  assetTypeRef(text: string): RefResult {
    const t = this.stripTenant(text.trim());
    if (lc(t).startsWith("core.")) {
      const core = this.core.assetType(t);
      return core ? { ref: { kind: "core", id: core.id } } : { error: `"${t}" is not a known core asset type.` };
    }
    if (t.includes(".")) return { ref: { kind: "external", id: t } };
    const uid = this.assetTypeUid(t);
    return uid ? { ref: { kind: "project", uid } } : { error: `Asset type "${t}" is not defined in the project.` };
  }

  aspectTypeRef(text: string): RefResult {
    const t = this.stripTenant(text.trim());
    if (lc(t).startsWith("core.")) {
      const core = this.core.aspectType(t);
      return core ? { ref: { kind: "core", id: core.id } } : { error: `"${t}" is not a known core aspect type.` };
    }
    if (t.includes(".")) return { ref: { kind: "external", id: t } };
    const uid = this.aspectTypeUid(t);
    return uid ? { ref: { kind: "project", uid } } : { error: `Aspect type "${t}" is not defined in the project.` };
  }

  // -- row bookkeeping -------------------------------------------------------

  private begin(table: TableName, row: TableRowInput, cols: Map<string, string>, label: string): RowCtx {
    const result: ImportRowResult = {
      table,
      rowNumber: row.rowNumber,
      label,
      action: "unchanged",
      changes: [],
      errors: [],
      warnings: [],
    };
    return { result, cells: new Cells(row.cells, cols) };
  }

  private finish(ctx: RowCtx, action: Exclude<RowAction, "error">, changes: Change[], touchedUid?: string): void {
    const r = ctx.result;
    if (r.errors.length) {
      r.action = "error";
      r.changes = [];
    } else {
      r.action = action;
      r.changes = changes;
      if (touchedUid && action !== "unchanged") this.touched.add(touchedUid);
    }
    this.rows.push(r);
  }

  private fail(ctx: RowCtx, message: string): void {
    ctx.result.errors.push(message);
    this.finish(ctx, "unchanged", []);
  }

  private checkColumns(table: TableName, data: TableInputData): Map<string, string> {
    const cols = headerMap(data.headers);
    const known = new Set(TABLE_COLUMNS[table].map((c) => lc(c.key)));
    const unknown = data.headers.filter((h) => {
      const k = lc(h.trim());
      if (!k || known.has(k)) return false;
      return !(table === "Assets" && (k.startsWith(VAR_PREFIX) || k.startsWith(ASPECT_PREFIX)));
    });
    if (unknown.length) this.warnings.push(`${table}: unknown column(s) ignored: ${unknown.join(", ")}.`);
    return cols;
  }

  // -- variables (shared by aspect and asset type tables) ---------------------

  private parseVariable(
    ctx: RowCtx,
    existing: VariableDef | undefined,
    ownerKind: "aspectType" | "assetType",
    matchedByName = false,
  ): VariableDef | undefined {
    const c = ctx.cells;
    const errors = ctx.result.errors;
    const v: VariableDef = existing
      ? structuredClone(existing)
      : { uid: newUid(), name: "", dataType: "STRING", searchable: false };
    const name = c.text("name");
    if (name !== undefined) {
      if (!name) errors.push("name: a variable name is required.");
      // A row matched by name keeps the existing spelling (names match case-insensitively).
      else if (!(matchedByName && existing && lc(existing.name) === lc(name))) v.name = name;
    } else if (!existing) errors.push("name: a variable name is required.");

    const dt = c.text("dataType");
    if (dt !== undefined) {
      const parsed = parseEnum<DataType>(dt, DATA_TYPES, "dataType", errors);
      if (dt === "") errors.push("dataType: a data type is required.");
      else if (parsed) v.dataType = parsed;
    } else if (!existing) errors.push("dataType: a data type is required.");

    const unit = c.raw("unit");
    if (unit !== undefined) setOpt(v, "unit", optText(unit.trim(), existing?.unit));
    const searchable = c.text("searchable");
    if (searchable !== undefined) {
      const b = parseBool(searchable, "searchable", errors);
      v.searchable = b ?? false;
    }
    const length = c.text("length");
    if (length !== undefined) setOpt(v, "length", parseNumberCell(length, "length", errors, true));
    const dv = c.raw("defaultValue");
    if (dv !== undefined) setOpt(v, "defaultValue", optText(dv, existing?.defaultValue));
    if (ownerKind === "aspectType") {
      const qc = c.text("qualityCode");
      if (qc !== undefined) setOpt(v, "qualityCode", qc === "" ? undefined : parseBool(qc, "qualityCode", errors));
    }
    if (v.defaultValue !== undefined && v.defaultValue !== "" && (v.defaultValue !== existing?.defaultValue || v.dataType !== existing?.dataType || v.length !== existing?.length)) {
      const err = checkValue(v.dataType, v.defaultValue, v.length);
      if (err) errors.push(`defaultValue: ${err}`);
    }
    if (c.has("uid") && !existing) {
      const uid = c.text("uid");
      if (uid) v.uid = uid;
    }
    return errors.length ? undefined : v;
  }

  // -- AspectTypes -------------------------------------------------------------

  importAspectTypes(data: TableInputData): void {
    const cols = this.checkColumns("AspectTypes", data);
    if (!cols.has("uid") && !cols.has("idsuffix") && !cols.has("name")) {
      this.warnings.push("AspectTypes: needs a uid, idSuffix or name column to match rows; the table was skipped.");
      return;
    }
    const matched = new Map<string, number>();
    for (const row of data.rows) {
      const c0 = new Cells(row.cells, cols);
      const ctx = this.begin("AspectTypes", row, cols, c0.text("idSuffix") || c0.text("name") || c0.text("uid") || "(unnamed)");
      const c = ctx.cells;
      const errors = ctx.result.errors;
      const uid = c.text("uid");
      let target = uid ? this.next.aspectTypes.find((t) => t.uid === uid) : undefined;
      const byKey = !target;
      const idSuffix = c.text("idSuffix");
      if (!target && idSuffix) {
        const found = this.aspectTypeUid(idSuffix);
        target = found ? this.next.aspectTypes.find((t) => t.uid === found) : undefined;
        if (target && uid) ctx.result.warnings.push(`Matched by idSuffix "${idSuffix}"; the uid in the file is unknown.`);
      }
      if (!target && !idSuffix && !uid) {
        const name = c.text("name");
        target = name ? this.next.aspectTypes.find((t) => lc(t.name) === lc(name)) : undefined;
      }
      if (target) {
        const prev = matched.get(target.uid);
        if (prev !== undefined) {
          this.fail(ctx, `Another row (${prev}) already updates this aspect type.`);
          continue;
        }
        matched.set(target.uid, row.rowNumber);
      }
      const before = target ? this.original.aspectTypes.find((t) => t.uid === target!.uid) : undefined;
      const after: AspectTypeDef = target
        ? structuredClone(target)
        : { uid: uid && !this.next.aspectTypes.some((t) => t.uid === uid) ? uid : newUid(), idSuffix: "", name: "", category: "dynamic", variables: [] };

      const name = c.text("name");
      if (name !== undefined) {
        if (!name) errors.push("name: a name is required.");
        else if (!(byKey && target && !idSuffix && lc(target.name) === lc(name))) after.name = name;
      }
      if (idSuffix !== undefined) {
        if (!idSuffix) errors.push("idSuffix: an id is required.");
        // A row matched by idSuffix keeps the existing spelling (ids match case-insensitively).
        else if (!(byKey && target && lc(target.idSuffix) === lc(idSuffix))) after.idSuffix = idSuffix;
        const owner = this.aspectKeys.get(lc(idSuffix));
        if (target && idSuffix && owner && owner !== target.uid) errors.push(`idSuffix "${idSuffix}" is already used by another aspect type.`);
      }
      const cat = c.text("category");
      if (cat !== undefined) {
        if (cat === "") errors.push("category: static or dynamic is required.");
        const parsed = parseEnum<AspectCategory>(cat, ASPECT_CATEGORIES, "category", errors);
        if (parsed) after.category = parsed;
      } else if (!target) errors.push("category: static or dynamic is required for a new aspect type.");
      const desc = c.raw("description");
      if (desc !== undefined) setOpt(after, "description", optText(desc, before?.description));
      if (!target) {
        if (!after.name && !after.idSuffix) errors.push("A new aspect type needs a name or an idSuffix.");
        if (!after.name) after.name = after.idSuffix;
        if (!after.idSuffix) after.idSuffix = uniqueName(toIdentifier(after.name), this.next.aspectTypes.map((t) => t.idSuffix));
        if (this.aspectKeys.has(lc(after.idSuffix))) errors.push(`idSuffix "${after.idSuffix}" is already used by another aspect type.`);
      }
      ctx.result.label = after.idSuffix || after.name || ctx.result.label;
      if (errors.length) {
        this.finish(ctx, "unchanged", []);
        continue;
      }
      const strip = (t: AspectTypeDef | undefined) => (t ? { ...t, variables: undefined } : undefined);
      if (target) {
        Object.assign(target, after);
        for (const k of ["description"] as const) if (!(k in after)) delete target[k];
        const changes = entityChanges(strip(before), strip(after));
        this.finish(ctx, changes.length ? "update" : "unchanged", changes, after.uid);
      } else {
        this.next.aspectTypes.push(after);
        this.finish(ctx, "create", entityChanges(undefined, strip(after)), after.uid);
      }
      this.rebuildKeys();
    }
  }

  importAspectTypeVariables(data: TableInputData): void {
    const cols = this.checkColumns("AspectTypeVariables", data);
    if (!cols.has("aspecttype")) {
      this.warnings.push("AspectTypeVariables: the aspectType column is missing; the table was skipped.");
      return;
    }
    const matched = new Map<string, number>();
    for (const row of data.rows) {
      const c0 = new Cells(row.cells, cols);
      const ownerKey = c0.text("aspectType") ?? "";
      const ctx = this.begin("AspectTypeVariables", row, cols, `${ownerKey}.${c0.text("name") || c0.text("uid") || "?"}`);
      const c = ctx.cells;
      if (!ownerKey) {
        this.fail(ctx, "aspectType: the owning aspect type is required.");
        continue;
      }
      const ownerUid = this.aspectTypeUid(ownerKey);
      const owner = ownerUid ? this.next.aspectTypes.find((t) => t.uid === ownerUid) : undefined;
      if (!owner) {
        this.fail(ctx, `aspectType: "${ownerKey}" is not an aspect type of the project.`);
        continue;
      }
      const uid = c.text("uid");
      const name = c.text("name");
      let existing = uid ? owner.variables.find((v) => v.uid === uid) : undefined;
      const byName = !existing;
      if (!existing && name) existing = owner.variables.find((v) => lc(v.name) === lc(name));
      if (existing) {
        const prev = matched.get(existing.uid);
        if (prev !== undefined) {
          this.fail(ctx, `Another row (${prev}) already updates this variable.`);
          continue;
        }
        matched.set(existing.uid, row.rowNumber);
      }
      const origOwner = this.original.aspectTypes.find((t) => t.uid === owner.uid);
      const before = existing ? origOwner?.variables.find((v) => v.uid === existing!.uid) : undefined;
      const after = this.parseVariable(ctx, existing, "aspectType", byName);
      ctx.result.label = `${owner.idSuffix}.${after?.name || name || "?"}`;
      if (!after) {
        this.finish(ctx, "unchanged", []);
        continue;
      }
      if (existing) {
        if (after.name !== existing.name) {
          try {
            renameAspectTypeVariable(this.next, owner.uid, existing.uid, after.name);
          } catch (e) {
            this.fail(ctx, e instanceof DomainError ? e.message : String(e));
            continue;
          }
        }
        const pos = owner.variables.findIndex((v) => v.uid === existing!.uid);
        owner.variables[pos] = after;
        const changes = entityChanges(before ?? existing, after);
        this.finish(ctx, changes.length ? "update" : "unchanged", changes, owner.uid);
      } else {
        if (owner.variables.some((v) => lc(v.name) === lc(after.name))) {
          this.fail(ctx, `A variable named "${after.name}" already exists in "${owner.name}".`);
          continue;
        }
        if (owner.variables.some((v) => v.uid === after.uid) || this.uidInUse(after.uid)) after.uid = newUid();
        owner.variables.push(after);
        this.finish(ctx, "create", entityChanges(undefined, after), owner.uid);
      }
    }
  }

  private uidInUse(uid: string): boolean {
    return (
      this.next.aspectTypes.some((t) => t.uid === uid || t.variables.some((v) => v.uid === uid)) ||
      this.next.assetTypes.some((t) => t.uid === uid || t.variables.some((v) => v.uid === uid) || t.aspects.some((a) => a.uid === uid))
    );
  }

  // -- AssetTypes ----------------------------------------------------------------

  importAssetTypes(data: TableInputData): void {
    const cols = this.checkColumns("AssetTypes", data);
    if (!cols.has("uid") && !cols.has("idsuffix") && !cols.has("name")) {
      this.warnings.push("AssetTypes: needs a uid, idSuffix or name column to match rows; the table was skipped.");
      return;
    }
    interface Pending {
      ctx: RowCtx;
      target?: AssetTypeDef;
      after: AssetTypeDef;
      before?: AssetTypeDef;
      parentText?: string;
      snapshot?: AssetTypeDef;
    }
    const pending: Pending[] = [];
    const matched = new Map<string, number>();

    // Pass 1: identity and plain fields; register new / renamed keys.
    for (const row of data.rows) {
      const c0 = new Cells(row.cells, cols);
      const ctx = this.begin("AssetTypes", row, cols, c0.text("idSuffix") || c0.text("name") || c0.text("uid") || "(unnamed)");
      const c = ctx.cells;
      const errors = ctx.result.errors;
      const uid = c.text("uid");
      const idSuffix = c.text("idSuffix");
      let target = uid ? this.next.assetTypes.find((t) => t.uid === uid) : undefined;
      const byKey = !target;
      if (!target && idSuffix) {
        const found = this.assetTypeUid(idSuffix);
        target = found ? this.next.assetTypes.find((t) => t.uid === found) : undefined;
        if (target && uid) ctx.result.warnings.push(`Matched by idSuffix "${idSuffix}"; the uid in the file is unknown.`);
      }
      if (!target && !idSuffix && !uid) {
        const name = c.text("name");
        target = name ? this.next.assetTypes.find((t) => lc(t.name) === lc(name)) : undefined;
      }
      if (target) {
        const prev = matched.get(target.uid);
        if (prev !== undefined) {
          this.fail(ctx, `Another row (${prev}) already updates this asset type.`);
          continue;
        }
        matched.set(target.uid, row.rowNumber);
      }
      const before = target ? this.original.assetTypes.find((t) => t.uid === target!.uid) : undefined;
      const after: AssetTypeDef = target
        ? structuredClone(target)
        : {
            uid: uid && !this.next.assetTypes.some((t) => t.uid === uid) ? uid : newUid(),
            idSuffix: "",
            name: "",
            parent: { kind: "core", id: "core.basicasset" },
            instantiable: true,
            variables: [],
            aspects: [],
            fileAssignments: [],
          };
      const name = c.raw("name");
      if (name !== undefined) {
        if (!name.trim()) errors.push("name: a name is required.");
        else if (!(byKey && target && !idSuffix && lc(target.name) === lc(name))) after.name = name;
      }
      if (idSuffix !== undefined) {
        if (!idSuffix) errors.push("idSuffix: an id is required.");
        else if (!(byKey && target && lc(target.idSuffix) === lc(idSuffix))) after.idSuffix = idSuffix;
        const owner = this.assetTypeKeys.get(lc(idSuffix));
        if (target && idSuffix && owner && owner !== target.uid) errors.push(`idSuffix "${idSuffix}" is already used by another asset type.`);
      }
      const desc = c.raw("description");
      if (desc !== undefined) setOpt(after, "description", optText(desc, before?.description));
      const inst = c.text("instantiable");
      if (inst !== undefined) {
        if (inst === "") errors.push("instantiable: true or false is required.");
        const b = parseBool(inst, "instantiable", errors);
        if (b !== undefined) after.instantiable = b;
      }
      const parentText = c.text("parent");
      if (parentText === "") errors.push("parent: a parent type is required (e.g. core.basicasset).");
      if (!target) {
        if (!after.name && !after.idSuffix) errors.push("A new asset type needs a name or an idSuffix.");
        if (!after.name) after.name = after.idSuffix;
        if (!after.idSuffix) after.idSuffix = uniqueName(toIdentifier(after.name), this.next.assetTypes.map((t) => t.idSuffix));
        if (this.assetTypeKeys.has(lc(after.idSuffix))) errors.push(`idSuffix "${after.idSuffix}" is already used by another asset type.`);
      }
      ctx.result.label = after.idSuffix || after.name || ctx.result.label;
      if (errors.length) {
        this.finish(ctx, "unchanged", []);
        continue;
      }
      // Register (parents are resolved in pass 2, against all registered keys).
      const snapshot = target ? structuredClone(target) : undefined;
      if (target) {
        Object.assign(target, { ...after, parent: target.parent });
        if (!("description" in after)) delete target.description;
      } else this.next.assetTypes.push({ ...after });
      this.rebuildKeys();
      pending.push({ ctx, target, after, before, parentText: parentText || undefined, snapshot });
    }

    // Pass 2: resolve parents.
    for (const p of pending) {
      if (p.parentText === undefined) continue;
      const r = this.assetTypeRef(p.parentText);
      if ("error" in r) p.ctx.result.errors.push(`parent: ${r.error}`);
      else if (r.ref.kind === "project" && r.ref.uid === p.after.uid) p.ctx.result.errors.push("parent: a type cannot be its own parent.");
      else p.after.parent = r.ref;
    }

    // Pass 3: revert failed rows until stable (cycles, parents that were reverted).
    const live = () => pending.filter((p) => p.ctx.result.errors.length === 0);
    const revert = (p: Pending) => {
      if (p.snapshot && p.target) {
        const pos = this.next.assetTypes.findIndex((t) => t.uid === p.target!.uid);
        this.next.assetTypes[pos] = p.snapshot;
      } else this.next.assetTypes = this.next.assetTypes.filter((t) => t.uid !== p.after.uid);
    };
    for (const p of pending) if (p.ctx.result.errors.length) revert(p);
    for (const p of live()) {
      const t = this.next.assetTypes.find((x) => x.uid === p.after.uid);
      if (t) t.parent = p.after.parent;
    }
    for (let guard = 0; guard < pending.length + 1; guard++) {
      let changed = false;
      const byUid = new Map(this.next.assetTypes.map((t) => [t.uid, t]));
      for (const p of live()) {
        const parent = p.after.parent;
        if (parent.kind === "project" && !byUid.has(parent.uid)) {
          p.ctx.result.errors.push("parent: the parent type could not be imported.");
        } else {
          const seen = new Set<string>([p.after.uid]);
          let cur = parent;
          while (cur.kind === "project") {
            if (seen.has(cur.uid)) {
              p.ctx.result.errors.push("parent: this parent would create a cyclic inheritance chain.");
              break;
            }
            seen.add(cur.uid);
            const t = byUid.get(cur.uid);
            if (!t) break;
            cur = t.parent;
          }
        }
        if (p.ctx.result.errors.length) {
          revert(p);
          changed = true;
        }
      }
      if (!changed) break;
    }
    this.rebuildKeys();
    for (const p of pending) {
      const strip = (t: AssetTypeDef | undefined) =>
        t ? { ...t, variables: undefined, aspects: undefined, fileAssignments: undefined } : undefined;
      if (p.target) {
        const changes = entityChanges(strip(p.before), strip(this.next.assetTypes.find((t) => t.uid === p.after.uid) ?? p.after));
        this.finish(p.ctx, changes.length ? "update" : "unchanged", changes, p.after.uid);
      } else this.finish(p.ctx, "create", entityChanges(undefined, strip(p.after)), p.after.uid);
    }
  }

  importAssetTypeVariables(data: TableInputData): void {
    const cols = this.checkColumns("AssetTypeVariables", data);
    if (!cols.has("assettype")) {
      this.warnings.push("AssetTypeVariables: the assetType column is missing; the table was skipped.");
      return;
    }
    const matched = new Map<string, number>();
    for (const row of data.rows) {
      const c0 = new Cells(row.cells, cols);
      const ownerKey = c0.text("assetType") ?? "";
      const ctx = this.begin("AssetTypeVariables", row, cols, `${ownerKey}.${c0.text("name") || c0.text("uid") || "?"}`);
      const c = ctx.cells;
      if (!ownerKey) {
        this.fail(ctx, "assetType: the owning asset type is required.");
        continue;
      }
      const ownerUid = this.assetTypeUid(ownerKey);
      const owner = ownerUid ? this.next.assetTypes.find((t) => t.uid === ownerUid) : undefined;
      if (!owner) {
        this.fail(ctx, `assetType: "${ownerKey}" is not an asset type of the project.`);
        continue;
      }
      const uid = c.text("uid");
      const name = c.text("name");
      let existing = uid ? owner.variables.find((v) => v.uid === uid) : undefined;
      const byName = !existing;
      if (!existing && name) existing = owner.variables.find((v) => lc(v.name) === lc(name));
      if (existing) {
        const prev = matched.get(existing.uid);
        if (prev !== undefined) {
          this.fail(ctx, `Another row (${prev}) already updates this variable.`);
          continue;
        }
        matched.set(existing.uid, row.rowNumber);
      }
      const origOwner = this.original.assetTypes.find((t) => t.uid === owner.uid);
      const before = existing ? origOwner?.variables.find((v) => v.uid === existing!.uid) : undefined;
      const after = this.parseVariable(ctx, existing, "assetType", byName);
      ctx.result.label = `${owner.idSuffix}.${after?.name || name || "?"}`;
      if (!after) {
        this.finish(ctx, "unchanged", []);
        continue;
      }
      if (existing) {
        if (after.name !== existing.name) {
          try {
            renameAssetTypeVariable(this.next, new ModelIndex(this.next, this.core), owner.uid, existing.uid, after.name);
          } catch (e) {
            this.fail(ctx, e instanceof DomainError ? e.message : String(e));
            continue;
          }
        }
        const pos = owner.variables.findIndex((v) => v.uid === existing!.uid);
        owner.variables[pos] = after;
        const changes = entityChanges(before ?? existing, after);
        this.finish(ctx, changes.length ? "update" : "unchanged", changes, owner.uid);
      } else {
        if (owner.variables.some((v) => lc(v.name) === lc(after.name))) {
          this.fail(ctx, `A variable named "${after.name}" already exists in "${owner.name}".`);
          continue;
        }
        if (this.uidInUse(after.uid)) after.uid = newUid();
        owner.variables.push(after);
        this.finish(ctx, "create", entityChanges(undefined, after), owner.uid);
      }
    }
  }

  importAssetTypeAspects(data: TableInputData): void {
    const cols = this.checkColumns("AssetTypeAspects", data);
    if (!cols.has("assettype")) {
      this.warnings.push("AssetTypeAspects: the assetType column is missing; the table was skipped.");
      return;
    }
    const matched = new Map<string, number>();
    for (const row of data.rows) {
      const c0 = new Cells(row.cells, cols);
      const ownerKey = c0.text("assetType") ?? "";
      const ctx = this.begin("AssetTypeAspects", row, cols, `${ownerKey}.${c0.text("name") || c0.text("uid") || "?"}`);
      const c = ctx.cells;
      const errors = ctx.result.errors;
      if (!ownerKey) {
        this.fail(ctx, "assetType: the owning asset type is required.");
        continue;
      }
      const ownerUid = this.assetTypeUid(ownerKey);
      const owner = ownerUid ? this.next.assetTypes.find((t) => t.uid === ownerUid) : undefined;
      if (!owner) {
        this.fail(ctx, `assetType: "${ownerKey}" is not an asset type of the project.`);
        continue;
      }
      const uid = c.text("uid");
      const name = c.text("name");
      let existing = uid ? owner.aspects.find((a) => a.uid === uid) : undefined;
      const byName = !existing;
      if (!existing && name) existing = owner.aspects.find((a) => lc(a.name) === lc(name));
      if (existing) {
        const prev = matched.get(existing.uid);
        if (prev !== undefined) {
          this.fail(ctx, `Another row (${prev}) already updates this aspect.`);
          continue;
        }
        matched.set(existing.uid, row.rowNumber);
      }
      const after = existing
        ? structuredClone(existing)
        : { uid: uid && !this.uidInUse(uid) ? uid : newUid(), name: "", aspectType: { kind: "core", id: "" } as TypeRef };
      if (name !== undefined) {
        if (!name) errors.push("name: an aspect name is required.");
        else if (!(byName && existing && lc(existing.name) === lc(name))) after.name = name;
      } else if (!existing) errors.push("name: an aspect name is required.");
      const at = c.text("aspectType");
      if (at !== undefined) {
        if (!at) errors.push("aspectType: an aspect type is required.");
        else {
          const r = this.aspectTypeRef(at);
          if ("error" in r) errors.push(`aspectType: ${r.error}`);
          else after.aspectType = r.ref;
        }
      } else if (!existing) errors.push("aspectType: an aspect type is required.");
      ctx.result.label = `${owner.idSuffix}.${after.name || "?"}`;
      if (errors.length) {
        this.finish(ctx, "unchanged", []);
        continue;
      }
      const origOwner = this.original.assetTypes.find((t) => t.uid === owner.uid);
      const before = existing ? origOwner?.aspects.find((a) => a.uid === existing!.uid) : undefined;
      if (existing) {
        if (after.name !== existing.name) {
          try {
            renameAspect(this.next, new ModelIndex(this.next, this.core), owner.uid, existing.uid, after.name);
          } catch (e) {
            this.fail(ctx, e instanceof DomainError ? e.message : String(e));
            continue;
          }
        }
        const pos = owner.aspects.findIndex((a) => a.uid === existing!.uid);
        owner.aspects[pos] = after;
        const changes = entityChanges(before ?? existing, after);
        this.finish(ctx, changes.length ? "update" : "unchanged", changes, owner.uid);
      } else {
        if (owner.aspects.some((a) => lc(a.name) === lc(after.name))) {
          this.fail(ctx, `An aspect named "${after.name}" already exists in "${owner.name}".`);
          continue;
        }
        owner.aspects.push(after);
        this.finish(ctx, "create", entityChanges(undefined, after), owner.uid);
      }
    }
  }

  // -- Assets -------------------------------------------------------------------

  importAssets(data: TableInputData): void {
    const cols = this.checkColumns("Assets", data);
    if (!cols.has("uid") && !cols.has("name")) {
      this.warnings.push("Assets: needs a uid or name column to match rows; the table was skipped.");
      return;
    }
    const index = new ModelIndex(this.next, this.core);
    const valueHeaders = data.headers.filter((h) => {
      const k = lc(h.trim());
      return k.startsWith(VAR_PREFIX) || k.startsWith(ASPECT_PREFIX);
    });

    const assetsByUid = new Map(this.next.assets.map((a) => [a.uid, a]));
    const origByUid = new Map(this.original.assets.map((a) => [a.uid, a]));
    const childKey = (parent: string, name: string) => `${parent}\u0000${lc(name.trim())}`;
    // Children by name: names before the import and names after planned changes.
    const oldChildren = new Map<string, string[]>();
    const newChildren = new Map<string, string[]>();
    const push = (m: Map<string, string[]>, k: string, uid: string) => {
      const list = m.get(k) ?? [];
      if (!list.includes(uid)) list.push(uid);
      m.set(k, list);
    };
    for (const a of this.original.assets) if (a.parentUid !== null) push(oldChildren, childKey(a.parentUid, a.name), a.uid);

    const matched = new Map<string, number>();
    const created = new Set<string>();

    interface PendingRow {
      row: TableRowInput;
      cells: Cells;
    }
    let pending: PendingRow[] = data.rows.map((row) => ({ row, cells: new Cells(row.cells, cols) }));

    type Lookup = { uid: string } | { wait: true } | { missing: string } | { ambiguous: string };

    type NameSet = { has(name: string): boolean };
    const lookupChild = (parent: string, name: string, pendingNames: NameSet): Lookup => {
      const k = childKey(parent, name);
      const live = (list: string[] | undefined) => (list ?? []).filter((u) => assetsByUid.has(u));
      const old = live(oldChildren.get(k));
      if (old.length === 1) return { uid: old[0]! };
      if (old.length > 1) return { ambiguous: name };
      const planned = live(newChildren.get(k));
      if (planned.length === 1) return { uid: planned[0]! };
      if (planned.length > 1) return { ambiguous: name };
      // Current names (e.g. renamed earlier in this import) of existing children.
      const current = this.next.assets.filter((a) => a.parentUid === parent && lc(a.name.trim()) === lc(name.trim()));
      if (current.length === 1) return { uid: current[0]!.uid };
      return pendingNames.has(lc(name.trim())) ? { wait: true } : { missing: name };
    };

    const resolvePath = (path: string, pendingNames: NameSet): Lookup => {
      const segments = path
        .split("/")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      let cur = ROOT_ASSET_UID;
      for (const seg of segments) {
        const r = lookupChild(cur, seg, pendingNames);
        if (!("uid" in r)) return r;
        cur = r.uid;
      }
      return { uid: cur };
    };

    const isAncestorOrSelf = (candidate: string, uid: string): boolean => {
      const seen = new Set<string>();
      let cur: string | null | undefined = candidate;
      while (cur && !seen.has(cur)) {
        if (cur === uid) return true;
        seen.add(cur);
        cur = assetsByUid.get(cur)?.parentUid;
      }
      return false;
    };

    // Sweeps: process rows whose parent can be resolved; defer rows that wait
    // for a parent created by a later row.
    while (pending.length > 0) {
      const nameCounts = new Map<string, number>();
      const nameOf = (p: PendingRow) => lc((p.cells.raw("name") ?? "").trim());
      for (const p of pending) nameCounts.set(nameOf(p), (nameCounts.get(nameOf(p)) ?? 0) + 1);
      const pendingNames = { has: (n: string) => (nameCounts.get(n) ?? 0) > 0 };
      const pendingUids = new Set(pending.map((p) => p.cells.text("uid") ?? "").filter(Boolean));
      const deferred: PendingRow[] = [];
      let progress = false;
      for (const p of pending) {
        const own = nameOf(p);
        nameCounts.set(own, (nameCounts.get(own) ?? 1) - 1);
        const ownUid = p.cells.text("uid");
        if (ownUid) pendingUids.delete(ownUid);
        const outcome = this.importAssetRow(p.row, p.cells, cols, {
          index,
          assetsByUid,
          origByUid,
          matched,
          created,
          valueHeaders,
          resolveParent: (matchedAsset) => {
            const pu = p.cells.text("parentUid");
            const pp = p.cells.raw("parentPath");
            let byUid: Lookup | undefined;
            if (pu !== undefined && pu !== "") {
              if (pu === ROOT_ASSET_UID || assetsByUid.has(pu)) byUid = { uid: pu };
              else if (pendingUids.has(pu)) byUid = { wait: true };
              else byUid = { missing: pu };
            }
            const byPath = pp !== undefined ? resolvePath(pp, pendingNames) : undefined;
            return { byUid, byPath, current: matchedAsset?.parentUid ?? undefined };
          },
          isAncestorOrSelf,
          register: (uid, parent, name) => push(newChildren, childKey(parent, name), uid),
        });
        if (outcome === "wait") {
          deferred.push(p);
          nameCounts.set(own, (nameCounts.get(own) ?? 0) + 1);
          if (ownUid) pendingUids.add(ownUid);
        } else progress = true;
      }
      pending = deferred;
      if (!progress) {
        for (const p of pending) {
          const label = p.cells.raw("name") || p.cells.text("uid") || "(unnamed)";
          const ctx = this.begin("Assets", p.row, cols, label);
          this.fail(ctx, "The parent asset could not be found (or the rows reference each other in a cycle).");
        }
        break;
      }
    }
  }

  private importAssetRow(
    row: TableRowInput,
    c: Cells,
    cols: Map<string, string>,
    env: {
      index: ModelIndex;
      assetsByUid: Map<string, AssetDef>;
      origByUid: Map<string, AssetDef>;
      matched: Map<string, number>;
      created: Set<string>;
      valueHeaders: string[];
      resolveParent: (matched: AssetDef | undefined) => {
        byUid?: { uid: string } | { wait: true } | { missing: string } | { ambiguous: string };
        byPath?: { uid: string } | { wait: true } | { missing: string } | { ambiguous: string };
        current?: string;
      };
      isAncestorOrSelf: (candidate: string, uid: string) => boolean;
      register: (uid: string, parent: string, name: string) => void;
    },
  ): "done" | "wait" {
    const uid = c.text("uid");
    const rawName = c.raw("name");
    const ctx = this.begin("Assets", row, cols, rawName || uid || "(unnamed)");
    const errors = ctx.result.errors;
    if (uid === ROOT_ASSET_UID) {
      this.fail(ctx, "The tenant root placeholder cannot be changed by an import.");
      return "done";
    }
    let target = uid ? env.assetsByUid.get(uid) : undefined;
    const byKey = !target;
    if (target && env.created.has(target.uid)) {
      this.fail(ctx, `Another row (${env.matched.get(target.uid) ?? "?"}) already creates this asset.`);
      return "done";
    }

    // Parent resolution.
    const { byUid, byPath, current } = env.resolveParent(target);
    let parentUid: string | undefined;
    const ok = (l?: { uid: string } | object): l is { uid: string } => !!l && "uid" in l;
    const waits = (l?: object) => !!l && "wait" in l;
    if (waits(byUid) || waits(byPath)) {
      if (!(ok(byUid) || ok(byPath)) || (waits(byUid) && waits(byPath))) return "wait";
    }
    const describe = (l: object | undefined, what: string): string =>
      l && "ambiguous" in l
        ? `${what}: several sibling assets are named "${(l as { ambiguous: string }).ambiguous}".`
        : l && "missing" in l
          ? `${what}: "${(l as { missing: string }).missing}" was not found.`
          : `${what}: not found.`;
    if (byUid === undefined && byPath === undefined) {
      parentUid = target?.parentUid ?? ROOT_ASSET_UID;
    } else if (byUid === undefined) {
      if (ok(byPath)) parentUid = byPath.uid;
      else if (waits(byPath)) return "wait";
      else errors.push(describe(byPath, "parentPath"));
    } else if (byPath === undefined) {
      if (ok(byUid)) parentUid = byUid.uid;
      else if (waits(byUid)) return "wait";
      else errors.push(describe(byUid, "parentUid"));
    } else if (ok(byUid) && ok(byPath)) {
      if (byUid.uid === byPath.uid) parentUid = byUid.uid;
      else if (target && current === byUid.uid) parentUid = byPath.uid;
      else if (target && current === byPath.uid) parentUid = byUid.uid;
      else errors.push("parentUid and parentPath point to different assets; correct or clear one of them.");
    } else if (ok(byUid)) {
      if (waits(byPath)) return "wait";
      parentUid = byUid.uid;
      ctx.result.warnings.push(`${describe(byPath, "parentPath")} Used parentUid instead.`);
    } else if (ok(byPath)) {
      if (waits(byUid)) return "wait";
      parentUid = byPath.uid;
      ctx.result.warnings.push(`${describe(byUid, "parentUid")} Used parentPath instead.`);
    } else {
      errors.push(describe(byPath, "parentPath"));
    }

    // Natural key match (parentPath + name) when there is no uid match.
    if (!target && parentUid !== undefined && rawName !== undefined && rawName.trim()) {
      const candidates = this.next.assets.filter(
        (a) => a.parentUid === parentUid && lc(a.name.trim()) === lc(rawName.trim()),
      );
      const origCandidates = this.original.assets.filter(
        (a) => a.parentUid === parentUid && lc(a.name.trim()) === lc(rawName.trim()),
      );
      const found = candidates[0] ?? (origCandidates[0] ? env.assetsByUid.get(origCandidates[0].uid) : undefined);
      if (found && env.created.has(found.uid)) {
        this.fail(ctx, `Another row (${env.matched.get(found.uid) ?? "?"}) already creates "${rawName}" under the same parent.`);
        return "done";
      }
      if (candidates.length > 1) {
        this.fail(ctx, `Several assets named "${rawName}" exist under the same parent; add the uid column to tell them apart.`);
        return "done";
      }
      target = found;
      if (target && uid) ctx.result.warnings.push("Matched by parentPath and name; the uid in the file is unknown.");
    }
    if (target) {
      const prev = env.matched.get(target.uid);
      if (prev !== undefined) {
        this.fail(ctx, `Another row (${prev}) already updates this asset.`);
        return "done";
      }
    }

    const before = target ? env.origByUid.get(target.uid) : undefined;
    const after: AssetDef = target
      ? structuredClone(target)
      : {
          uid: uid && !env.assetsByUid.has(uid) ? uid : newUid(),
          name: "",
          type: { kind: "core", id: "core.basicasset" },
          parentUid: ROOT_ASSET_UID,
          twinType: "performance",
          variables: [],
          aspects: [],
          fileAssignments: [],
        };
    if (parentUid !== undefined) {
      if (target && parentUid !== target.parentUid && env.isAncestorOrSelf(parentUid, target.uid)) {
        errors.push("An asset cannot be moved below itself or one of its descendants.");
      } else after.parentUid = parentUid;
    }

    if (rawName !== undefined) {
      if (!rawName.trim()) errors.push("name: a name is required.");
      // A row matched by parentPath + name keeps the existing spelling.
      else if (!(byKey && target && lc(target.name.trim()) === lc(rawName.trim()))) after.name = rawName;
    } else if (!target) errors.push("name: a name is required.");

    const typeText = c.text("type");
    if (typeText !== undefined) {
      if (!typeText) errors.push("type: an asset type is required.");
      else {
        const r = this.assetTypeRef(typeText);
        if ("error" in r) errors.push(`type: ${r.error}`);
        else after.type = r.ref;
      }
    } else if (!target) errors.push("type: an asset type is required.");

    const ext = c.raw("externalId");
    if (ext !== undefined) setOpt(after, "externalId", optText(ext, before?.externalId));
    const desc = c.raw("description");
    if (desc !== undefined) setOpt(after, "description", optText(desc, before?.description));
    const tz = c.text("timezone");
    if (tz !== undefined) {
      setOpt(after, "timezone", tz === "" ? undefined : tz);
      if (tz && tz !== before?.timezone) {
        const msg = timezoneMessage(checkTimezone(tz), tz);
        if (msg) errors.push(`timezone: ${msg}`);
      }
    }
    const twin = c.text("twinType");
    if (twin !== undefined) {
      if (twin === "") errors.push("twinType: performance or simulation is required.");
      const t = parseEnum<TwinType>(twin, TWIN_TYPES, "twinType", errors);
      if (t) after.twinType = t;
    }

    // Location
    const locKeys = ["country", "region", "locality", "streetAddress", "postalCode"] as const;
    if (locKeys.some((k) => c.has(k)) || c.has("latitude") || c.has("longitude")) {
      const loc: Location = { ...(after.location ?? {}) };
      for (const k of locKeys) {
        const v = c.raw(k);
        if (v !== undefined) setOpt(loc, k, optText(v, before?.location?.[k]));
      }
      for (const k of ["latitude", "longitude"] as const) {
        const v = c.text(k);
        if (v !== undefined) setOpt(loc, k, parseNumberCell(v, k, errors, false));
      }
      if (Object.keys(loc).length === 0 && !before?.location) delete after.location;
      else after.location = loc;
    }

    // Values
    if (env.valueHeaders.length && !errors.length) this.applyValues(ctx, c, env, after, target);

    ctx.result.label = this.assetLabel(after, env.assetsByUid);
    if (errors.length) {
      this.finish(ctx, "unchanged", []);
      return "done";
    }
    if (target) {
      env.matched.set(target.uid, row.rowNumber);
      const changes = entityChanges(before ?? target, after);
      const pos = this.next.assets.findIndex((a) => a.uid === target!.uid);
      if (changes.length || !before) {
        this.next.assets[pos] = after;
        env.assetsByUid.set(after.uid, after);
      }
      env.register(after.uid, after.parentUid ?? ROOT_ASSET_UID, after.name);
      this.finish(ctx, changes.length ? "update" : "unchanged", changes, after.uid);
    } else {
      this.next.assets.push(after);
      env.assetsByUid.set(after.uid, after);
      env.created.add(after.uid);
      env.matched.set(after.uid, row.rowNumber);
      env.register(after.uid, after.parentUid ?? ROOT_ASSET_UID, after.name);
      this.finish(ctx, "create", entityChanges(undefined, { ...after, uid: undefined }), after.uid);
    }
    return "done";
  }

  private assetLabel(a: AssetDef, byUid: Map<string, AssetDef>): string {
    const names: string[] = [a.name];
    const seen = new Set<string>([a.uid]);
    let cur = a.parentUid;
    while (cur && cur !== ROOT_ASSET_UID && !seen.has(cur)) {
      seen.add(cur);
      const p = byUid.get(cur);
      if (!p) break;
      names.unshift(p.name);
      cur = p.parentUid;
    }
    return names.join(PATH_SEPARATOR);
  }

  private applyValues(
    ctx: RowCtx,
    c: Cells,
    env: { index: ModelIndex; valueHeaders: string[] },
    after: AssetDef,
    target: AssetDef | undefined,
  ): void {
    const errors = ctx.result.errors;
    const resolved: ResolvedAssetType | undefined = env.index.resolveAssetType(after.type);
    const original = target ? this.original.assets.find((a) => a.uid === target.uid) : undefined;
    const origResolved = original ? this.origIndex.resolveAssetType(original.type) : undefined;
    if (!resolved) {
      if (env.valueHeaders.some((h) => (c.raw(h) ?? "") !== "")) errors.push("Values cannot be checked: the asset type does not exist.");
      return;
    }
    const staticVars = new Map(resolved.variables.map((v) => [lc(v.name), v]));
    const aspects = new Map(resolved.aspects.map((a) => [lc(a.name), a]));

    const setValue = (list: VariableValue[], names: string[], canonical: string, value: string): VariableValue[] => {
      const lcs = new Set(names.map(lc));
      const pos = list.findIndex((v) => lcs.has(lc(v.name)));
      if (value === "") return list.filter((v) => !lcs.has(lc(v.name)));
      if (pos >= 0) {
        const out = [...list];
        out[pos] = { name: canonical, value };
        return out;
      }
      return [...list, { name: canonical, value }];
    };
    const oldValue = (list: VariableValue[] | undefined, names: string[]) =>
      list?.find((v) => names.map(lc).includes(lc(v.name)))?.value;

    for (const header of env.valueHeaders) {
      const value = c.raw(header) ?? "";
      const key = header.trim();
      if (lc(key).startsWith(VAR_PREFIX)) {
        const name = key.slice(VAR_PREFIX.length).trim();
        if (!name) continue;
        let def = staticVars.get(lc(name));
        if (!def && origResolved) {
          const ov = origResolved.variables.find((v) => lc(v.name) === lc(name));
          if (ov?.uid) def = resolved.variables.find((v) => v.uid === ov.uid);
        }
        const canonical = def?.name ?? name;
        const prev = oldValue(original?.variables, [name, canonical]);
        if (!def && value !== "") {
          if (resolved.incomplete) ctx.result.warnings.push(`"${name}" is not known offline for type "${resolved.name}" (external parent); kept as is.`);
          else {
            errors.push(`${header}: "${name}" is not a variable of type "${resolved.name}".`);
            continue;
          }
        }
        if (def && value !== "" && (value !== prev || !original)) {
          const err = checkValue(def.dataType, value, def.length);
          if (err) errors.push(`${header}: ${err}`);
        }
        after.variables = setValue(after.variables, [name, canonical], canonical, value);
        continue;
      }
      const rest = key.slice(ASPECT_PREFIX.length).trim();
      const dot = rest.indexOf(".");
      if (dot <= 0 || dot === rest.length - 1) {
        if (value !== "") errors.push(`${header}: expected the column name aspect:<aspect>.<variable>.`);
        continue;
      }
      const aspectName = rest.slice(0, dot);
      const varName = rest.slice(dot + 1);
      let aspect = aspects.get(lc(aspectName));
      if (!aspect && origResolved) {
        const oa = origResolved.aspects.find((a) => lc(a.name) === lc(aspectName));
        if (oa?.uid) aspect = resolved.aspects.find((a) => a.uid === oa.uid);
      }
      const canonicalAspect = aspect?.name ?? aspectName;
      if (!aspect) {
        if (value !== "") {
          if (resolved.incomplete) ctx.result.warnings.push(`Aspect "${aspectName}" is not known offline for type "${resolved.name}"; kept as is.`);
          else {
            errors.push(`${header}: "${aspectName}" is not an aspect of type "${resolved.name}".`);
            continue;
          }
        }
      } else if (aspect.aspectType.category === "dynamic" && value !== "") {
        errors.push(`${header}: "${aspect.name}" is a dynamic (time series) aspect; static values cannot be set.`);
        continue;
      }
      let varDef = aspect?.aspectType.variables.find((v) => lc(v.name) === lc(varName));
      if (!varDef && aspect) {
        const origAspect = origResolved?.aspects.find((a) => lc(a.name) === lc(aspectName)) ?? origResolved?.aspects.find((a) => a.uid === aspect!.uid);
        const ov = origAspect?.aspectType.def?.variables.find((v) => lc(v.name) === lc(varName));
        const nv = ov ? aspect.aspectType.def?.variables.find((v) => v.uid === ov.uid) : undefined;
        if (nv) varDef = aspect.aspectType.variables.find((v) => v.name === nv.name);
      }
      if (aspect && !varDef && value !== "") {
        if (!aspect.aspectType.known) ctx.result.warnings.push(`Variable "${varName}" of external aspect type "${aspect.aspectType.name}" cannot be checked offline.`);
        else {
          errors.push(`${header}: "${varName}" is not a variable of aspect "${aspect.name}".`);
          continue;
        }
      }
      const canonicalVar = varDef?.name ?? varName;
      const groupNames = [aspectName, canonicalAspect].map(lc);
      const origGroup = original?.aspects.find((g) => groupNames.includes(lc(g.name)));
      const prev = oldValue(origGroup?.variables, [varName, canonicalVar]);
      if (varDef && value !== "" && (value !== prev || !original)) {
        const err = checkValue(varDef.dataType, value, varDef.length);
        if (err) errors.push(`${header}: ${err}`);
      }
      const gpos = after.aspects.findIndex((g) => groupNames.includes(lc(g.name)));
      if (gpos < 0) {
        if (value === "") continue;
        after.aspects = [...after.aspects, { name: canonicalAspect, variables: [{ name: canonicalVar, value }] }];
      } else {
        const g = after.aspects[gpos]!;
        const next = { name: canonicalAspect, variables: setValue(g.variables, [varName, canonicalVar], canonicalVar, value) };
        after.aspects = after.aspects.map((x, i) => (i === gpos ? next : x));
      }
    }
    after.aspects = after.aspects.filter((g) => g.variables.length > 0 || original?.aspects.some((o) => lc(o.name) === lc(g.name) && o.variables.length === 0));
  }

  // -- result --------------------------------------------------------------------

  result(): TableImportPlan {
    const changed = <T extends { uid: string }>(before: T[], after: T[]): T[] => {
      const b = new Map(before.map((x) => [x.uid, x]));
      return after.filter((x) => {
        const prev = b.get(x.uid);
        return !prev || JSON.stringify(prev) !== JSON.stringify(x);
      });
    };
    const entities = {
      aspectTypes: changed(this.original.aspectTypes, this.next.aspectTypes),
      assetTypes: changed(this.original.assetTypes, this.next.assetTypes),
      assets: changed(this.original.assets, this.next.assets),
    };
    const all = [...entities.aspectTypes, ...entities.assetTypes, ...entities.assets];
    const counts: Record<RowAction, number> = { create: 0, update: 0, unchanged: 0, error: 0 };
    for (const r of this.rows) counts[r.action]++;
    const order = new Map(TABLE_NAMES.map((t, i) => [t, i]));
    const rows = [...this.rows].sort(
      (a, b) => (order.get(a.table) ?? 0) - (order.get(b.table) ?? 0) || a.rowNumber - b.rowNumber,
    );
    return {
      projectId: this.original.id,
      baseUpdatedAt: this.original.updatedAt,
      rows,
      entities,
      counts,
      indirect: all.filter((e) => !this.touched.has(e.uid)).length,
      warnings: this.warnings,
    };
  }
}

/** Compute the preview / change plan of a spreadsheet import (pure; the project is not modified). */
export function planTableImport(project: Project, core: CoreLibraryIndex, input: TableInput): TableImportPlan {
  const planner = new ImportPlanner(project, core);
  if (input.AspectTypes) planner.importAspectTypes(input.AspectTypes);
  if (input.AspectTypeVariables) planner.importAspectTypeVariables(input.AspectTypeVariables);
  if (input.AssetTypes) planner.importAssetTypes(input.AssetTypes);
  if (input.AssetTypeVariables) planner.importAssetTypeVariables(input.AssetTypeVariables);
  if (input.AssetTypeAspects) planner.importAssetTypeAspects(input.AssetTypeAspects);
  if (input.Assets) planner.importAssets(input.Assets);
  if (!TABLE_NAMES.some((t) => input[t])) planner.warnings.push("No known table was found in the input.");
  return planner.result();
}

/** Number of entities the plan changes. */
export function planChangeCount(plan: TableImportPlan): number {
  return plan.entities.aspectTypes.length + plan.entities.assetTypes.length + plan.entities.assets.length;
}

/**
 * Write the planned entities into a project draft (use inside
 * useProjectStore.apply). Throws DomainError when the project changed since
 * the plan was computed.
 */
export function applyTableImport(draft: Project, plan: TableImportPlan): void {
  if (draft.id !== plan.projectId || draft.updatedAt !== plan.baseUpdatedAt) {
    throw new DomainError("The project changed after the preview was created. Run the preview again.");
  }
  const put = <T extends { uid: string }>(list: T[], items: T[]) => {
    const pos = new Map(list.map((x, i) => [x.uid, i]));
    for (const item of items) {
      const copy = structuredClone(item);
      const i = pos.get(item.uid);
      if (i === undefined) {
        pos.set(item.uid, list.length);
        list.push(copy);
      } else list[i] = copy;
    }
  };
  put(draft.aspectTypes, plan.entities.aspectTypes);
  put(draft.assetTypes, plan.entities.assetTypes);
  put(draft.assets, plan.entities.assets);
}
