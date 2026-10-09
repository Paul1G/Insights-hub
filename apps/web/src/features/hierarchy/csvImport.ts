// Bulk asset creation from CSV.
//
// Columns: parentPath, name, type, externalId, description, timezone.
//   - parentPath: names separated by " / ", starting below the tenant root;
//     empty = directly under the root. Segments may refer to existing assets
//     or to assets created by earlier rows of the same file.
//   - type: project asset type id (idSuffix, optionally "{tenant}.<id>") or a
//     core type id (e.g. core.basicsite).
// Rows are processed in order, so earlier rows can be parents of later ones.

import { bulkCreateAssets, type BulkAssetRow } from "@/domain/ops";
import { ROOT_ASSET_UID, type Project, type TypeRef } from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";
import { checkTimezone, timezoneMessage } from "@/domain/timezone";
import { parseCsv, toCsv } from "@/portability/csv";
import { BULK_MAX } from "./bulkTemplate";
import {
  assetNameError,
  descriptionError,
  externalIdError,
  resolveTypeToken,
  type TypeOption,
} from "./types";

export const CSV_COLUMNS = ["parentPath", "name", "type", "externalId", "description", "timezone"] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];
const REQUIRED_COLUMNS: CsvColumn[] = ["name", "type"];

export const PATH_SEPARATOR = " / ";

export type CsvParentRef = { kind: "existing"; uid: string } | { kind: "row"; key: string };

export interface CsvPlanRow {
  /** 1-based line number in the file (header = line 1). */
  line: number;
  key: string;
  parentPath: string;
  name: string;
  typeToken: string;
  externalId: string;
  description: string;
  timezone: string;
  parent?: CsvParentRef;
  type?: TypeRef;
  typeLabel?: string;
  errors: string[];
}

export interface CsvPlan {
  rows: CsvPlanRow[];
  /** File-level problems (missing columns, too many rows, empty file). */
  fileErrors: string[];
  unknownColumns: string[];
  valid: number;
  invalid: number;
}

/** Header-only template users fill in a spreadsheet. */
export function csvTemplate(): string {
  return toCsv([...CSV_COLUMNS], []);
}

export function splitParentPath(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed) return [];
  return trimmed.split("/").map((s) => s.trim());
}

/** Column lookup tolerant to case and surrounding spaces in the header. */
function columnMap(headers: string[]): { map: Map<CsvColumn, string>; unknown: string[] } {
  const map = new Map<CsvColumn, string>();
  const unknown: string[] = [];
  for (const h of headers) {
    const col = CSV_COLUMNS.find((c) => c.toLowerCase() === h.trim().toLowerCase());
    if (col && !map.has(col)) map.set(col, h);
    else if (h.trim()) unknown.push(h);
  }
  return { map, unknown };
}

type NodeId = string; // "e:<uid>" for existing assets, "r:<key>" for CSV rows

export function planCsvImport(index: ModelIndex, text: string, typeOptions: TypeOption[]): CsvPlan {
  const table = parseCsv(text);
  const fileErrors: string[] = [];
  if (table.headers.length === 0) {
    return { rows: [], fileErrors: ["The file is empty."], unknownColumns: [], valid: 0, invalid: 0 };
  }
  const { map, unknown } = columnMap(table.headers);
  const missing = REQUIRED_COLUMNS.filter((c) => !map.has(c));
  if (missing.length) fileErrors.push(`Missing required column(s): ${missing.join(", ")}.`);
  if (table.rows.length === 0) fileErrors.push("The file has a header but no rows.");
  if (table.rows.length > BULK_MAX) {
    fileErrors.push(`The file has ${table.rows.length.toLocaleString()} rows; at most ${BULK_MAX.toLocaleString()} can be created per run.`);
  }
  if (fileErrors.length) return { rows: [], fileErrors, unknownColumns: unknown, valid: 0, invalid: 0 };

  const cell = (r: Record<string, string>, c: CsvColumn) => {
    const h = map.get(c);
    return h === undefined ? "" : (r[h] ?? "").trim();
  };

  // Children by lower-cased name for every node (existing + created rows).
  const childIndex = new Map<NodeId, Map<string, NodeId[]>>();
  const childrenOf = (node: NodeId): Map<string, NodeId[]> => {
    let m = childIndex.get(node);
    if (!m) {
      m = new Map();
      if (node.startsWith("e:")) {
        for (const c of index.childrenOf(node.slice(2))) {
          const key = c.name.toLowerCase();
          m.set(key, [...(m.get(key) ?? []), `e:${c.uid}`]);
        }
      }
      childIndex.set(node, m);
    }
    return m;
  };
  const rowsByKey = new Map<string, CsvPlanRow>();

  const rows: CsvPlanRow[] = table.rows.map((r, i) => {
    const row: CsvPlanRow = {
      line: i + 2,
      key: `row-${i + 1}`,
      parentPath: cell(r, "parentPath"),
      name: cell(r, "name"),
      typeToken: cell(r, "type"),
      externalId: cell(r, "externalId"),
      description: cell(r, "description"),
      timezone: cell(r, "timezone"),
      errors: [],
    };

    // Parent
    let node: NodeId | undefined = `e:${ROOT_ASSET_UID}`;
    const walked: string[] = [];
    for (const seg of splitParentPath(row.parentPath)) {
      walked.push(seg);
      if (!seg) {
        row.errors.push(`Parent path "${row.parentPath}" has an empty segment.`);
        node = undefined;
        break;
      }
      const hits: NodeId[] = childrenOf(node).get(seg.toLowerCase()) ?? [];
      if (hits.length === 0) {
        row.errors.push(`Unknown parent "${walked.join(PATH_SEPARATOR)}".`);
        node = undefined;
        break;
      }
      if (hits.length > 1) {
        row.errors.push(`Parent "${walked.join(PATH_SEPARATOR)}" is ambiguous (several assets share that name).`);
        node = undefined;
        break;
      }
      node = hits[0]!;
    }
    if (node) {
      if (node.startsWith("r:")) {
        const parentRow = rowsByKey.get(node.slice(2))!;
        if (parentRow.errors.length) row.errors.push(`Parent "${parentRow.name}" (line ${parentRow.line}) has errors and will not be created.`);
        row.parent = { kind: "row", key: parentRow.key };
      } else {
        row.parent = { kind: "existing", uid: node.slice(2) };
      }
    }

    // Name + sibling uniqueness
    const nameErr = assetNameError(row.name);
    if (nameErr) row.errors.push(nameErr);
    else if (node && childrenOf(node).has(row.name.toLowerCase())) {
      row.errors.push(`Another asset named "${row.name}" already exists under this parent (case-insensitive).`);
    }

    // Type
    if (!row.typeToken) row.errors.push("Type is required.");
    else {
      const opt = resolveTypeToken(typeOptions, row.typeToken);
      if (!opt) row.errors.push(`Unknown or non-instantiable type "${row.typeToken}".`);
      else {
        row.type = opt.ref;
        row.typeLabel = opt.label;
      }
    }

    const tzMsg = row.timezone ? timezoneMessage(checkTimezone(row.timezone), row.timezone) : undefined;
    if (tzMsg) row.errors.push(tzMsg);
    const descErr = row.description ? descriptionError(row.description) : undefined;
    if (descErr) row.errors.push(descErr);
    const extErr = externalIdError(row.externalId);
    if (extErr) row.errors.push(extErr);

    // Register as a child so later rows can use it as parent (and duplicates are caught).
    if (node && !nameErr) {
      const siblings = childrenOf(node);
      const key = row.name.toLowerCase();
      siblings.set(key, [...(siblings.get(key) ?? []), `r:${row.key}`]);
    }
    rowsByKey.set(row.key, row);
    return row;
  });

  const invalid = rows.filter((r) => r.errors.length).length;
  return { rows, fileErrors, unknownColumns: unknown, valid: rows.length - invalid, invalid };
}

/**
 * Create the assets of a fully valid plan inside one draft. Rows are created
 * generation by generation (rows under existing assets first, then their
 * children, …) with bulkCreateAssets, so the number of passes is the nesting
 * depth inside the file, not the row count. Returns the created uids in file order.
 */
export function createFromCsvPlan(d: Project, plan: CsvPlan): string[] {
  if (plan.fileErrors.length || plan.invalid > 0) throw new Error("The CSV still has errors.");
  const byKey = new Map(plan.rows.map((r) => [r.key, r]));
  const generation = new Map<string, number>();
  const genOf = (r: CsvPlanRow): number => {
    const cached = generation.get(r.key);
    if (cached !== undefined) return cached;
    const g = r.parent?.kind === "row" ? genOf(byKey.get(r.parent.key)!) + 1 : 0;
    generation.set(r.key, g);
    return g;
  };
  const groups: CsvPlanRow[][] = [];
  for (const r of plan.rows) (groups[genOf(r)] ??= []).push(r);

  const created = new Map<string, string>();
  for (const group of groups) {
    if (!group) continue;
    const bulk: BulkAssetRow[] = group.map((r) => ({
      name: r.name,
      type: r.type!,
      parentUid: r.parent!.kind === "existing" ? r.parent!.uid : created.get(r.parent!.key)!,
      ...(r.externalId ? { externalId: r.externalId } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.timezone ? { timezone: r.timezone } : {}),
    }));
    const uids = bulkCreateAssets(d, bulk);
    group.forEach((r, i) => created.set(r.key, uids[i]!));
  }
  return plan.rows.map((r) => created.get(r.key)!);
}
