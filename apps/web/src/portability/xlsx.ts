// XLSX workbook export/import for the spreadsheet tables (exceljs, loaded on
// demand so it stays out of the main bundle).

import type { Workbook, Worksheet, CellValue, DataValidation } from "exceljs";
import type { Project } from "@/domain/model";
import {
  TABLE_COLUMNS,
  TABLE_DESCRIPTIONS,
  TABLE_NAMES,
  VAR_PREFIX,
  ASPECT_PREFIX,
  PATH_SEPARATOR,
  columnDef,
  type TableData,
  type TableInput,
  type TableName,
} from "./tables";

type ExcelJsModule = typeof import("exceljs");

async function loadExcelJs(): Promise<ExcelJsModule> {
  const mod = (await import("exceljs")) as ExcelJsModule & { default?: ExcelJsModule };
  return mod.default && typeof mod.default.Workbook === "function" ? mod.default : mod;
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const README_SHEET = "README";

// ARGB colours of the generated workbook (a standalone artefact, not app UI).
const HEADER_FILL = "FF1F3A5F";
const HEADER_FONT = "FFFFFFFF";
const README_TITLE_FONT = "FF1F3A5F";

interface ValidatedSheet {
  dataValidations: { add(address: string, validation: DataValidation): void };
}

function columnLetter(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function addReadme(wb: Workbook, project: Pick<Project, "name">, exportedAt: Date): void {
  const ws = wb.addWorksheet(README_SHEET);
  ws.columns = [
    { header: "Sheet", key: "sheet", width: 22 },
    { header: "Column", key: "column", width: 28 },
    { header: "Description", key: "description", width: 110 },
  ];
  styleHeader(ws);
  const intro: string[] = [
    `Asset Model Studio — spreadsheet export of “${project.name}” (${exportedAt.toISOString()}).`,
    "Edit the sheets and import the workbook again on the “Import, export & docs” page; a preview lists every change before it is applied.",
    "Rows are matched by uid; rows without uid are matched by natural key (idSuffix for types, owner + name for variables and aspects, parentPath + name for assets) — case-insensitive.",
    "Rows that are missing from a sheet are left unchanged (an import never deletes). An absent column leaves the field untouched; an empty cell clears an optional field.",
    `Asset parentPath joins the names below the tenant root with "${PATH_SEPARATOR}". Value columns: ${VAR_PREFIX}<variable> and ${ASPECT_PREFIX}<aspect>.<variable> (static aspects only).`,
    "Booleans are true / false. Type references: project types by idSuffix, core types by id (core.*), external tenant types by their full id.",
  ];
  for (const line of intro) {
    const row = ws.addRow({ sheet: "", column: "", description: line });
    row.getCell(3).alignment = { wrapText: true, vertical: "top" };
  }
  ws.getRow(2).getCell(3).font = { bold: true, color: { argb: README_TITLE_FONT } };
  ws.addRow({});
  for (const t of TABLE_NAMES) {
    const head = ws.addRow({ sheet: t, column: "", description: TABLE_DESCRIPTIONS[t] });
    head.font = { bold: true };
    head.getCell(3).alignment = { wrapText: true, vertical: "top" };
    for (const c of TABLE_COLUMNS[t]) {
      const r = ws.addRow({ sheet: t, column: c.key, description: c.description + (c.list ? ` Allowed: ${c.list.join(", ")}.` : "") });
      r.getCell(3).alignment = { wrapText: true, vertical: "top" };
    }
    if (t === "Assets") {
      ws.addRow({ sheet: t, column: `${VAR_PREFIX}<variable>`, description: "Value of a static variable of the asset type (incl. inherited)." });
      ws.addRow({ sheet: t, column: `${ASPECT_PREFIX}<aspect>.<variable>`, description: "Value of a variable of a static aspect." });
    }
  }
}

function styleHeader(ws: Worksheet): void {
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: HEADER_FONT } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: "middle" };
  ws.views = [{ state: "frozen", ySplit: 1, xSplit: 0 }];
}

function addTableSheet(wb: Workbook, table: TableData): void {
  const ws = wb.addWorksheet(table.name);
  ws.columns = table.headers.map((h) => ({
    header: h,
    key: h,
    width: Math.min(48, Math.max(12, h.length + 4, ...table.rows.slice(0, 200).map((r) => (r[h] ?? "").length + 2))),
  }));
  for (const r of table.rows) {
    const values: Record<string, string | number> = {};
    for (const h of table.headers) {
      const v = r[h] ?? "";
      const def = columnDef(table.name, h);
      values[h] = def?.numeric && v !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
    }
    ws.addRow(values);
  }
  styleHeader(ws);
  if (table.headers.length) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.headers.length } };
  }
  // Text cells: keep values such as "007" or "1e5" as typed.
  const lastRow = Math.max(table.rows.length + 1, 2) + 2000;
  table.headers.forEach((h, i) => {
    const def = columnDef(table.name, h);
    const col = columnLetter(i + 1);
    if (!def?.numeric) ws.getColumn(i + 1).numFmt = "@";
    if (def?.list) {
      (ws as unknown as ValidatedSheet).dataValidations.add(`${col}2:${col}${lastRow}`, {
        type: "list",
        allowBlank: true,
        formulae: [`"${def.list.join(",")}"`],
        showErrorMessage: true,
        errorTitle: "Invalid value",
        error: `Allowed: ${def.list.join(", ")}`,
      });
    }
  });
}

/** One workbook with a README sheet and one sheet per table. */
export async function buildWorkbook(
  tables: Record<TableName, TableData>,
  project: Pick<Project, "name">,
  exportedAt: Date = new Date(),
): Promise<Blob> {
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  wb.creator = "Asset Model Studio";
  wb.created = exportedAt;
  wb.modified = exportedAt;
  addReadme(wb, project, exportedAt);
  for (const t of TABLE_NAMES) addTableSheet(wb, tables[t]);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf as ArrayBuffer], { type: XLSX_MIME });
}

/** Cell value → text (formula results, rich text, hyperlinks, dates and booleans). */
export function cellText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if (Array.isArray(v.richText)) return (v.richText as { text: string }[]).map((t) => t.text).join("");
    if ("result" in v) return cellText(v.result as CellValue);
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("error" in v) return "";
    if ("sharedFormula" in v) return "";
  }
  return String(value);
}

export interface WorkbookReadResult {
  tables: TableInput;
  warnings: string[];
}

/** Read the table sheets of a workbook (sheet names are matched case-insensitively). */
export async function readWorkbook(data: ArrayBuffer): Promise<WorkbookReadResult> {
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data);
  } catch {
    throw new Error("The file is not a readable XLSX workbook.");
  }
  const tables: TableInput = {};
  const warnings: string[] = [];
  const names = new Map(TABLE_NAMES.map((t) => [t.toLowerCase(), t]));
  wb.eachSheet((ws) => {
    const table = names.get(ws.name.trim().toLowerCase());
    if (!table) {
      if (ws.name.trim().toLowerCase() !== README_SHEET.toLowerCase()) warnings.push(`Sheet “${ws.name}” is not a known table and was ignored.`);
      return;
    }
    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    const colIndex: number[] = [];
    headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
      const h = cellText(cell.value).trim();
      if (h) {
        headers.push(h);
        colIndex.push(col);
      }
    });
    const rows: { rowNumber: number; cells: Record<string, string> }[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const cells: Record<string, string> = {};
      let any = false;
      headers.forEach((h, i) => {
        const text = cellText(row.getCell(colIndex[i]!).value);
        if (text.trim() !== "") any = true;
        cells[h] = text;
      });
      if (any) rows.push({ rowNumber, cells });
    });
    tables[table] = { headers, rows };
  });
  if (!TABLE_NAMES.some((t) => tables[t])) warnings.push("The workbook contains none of the expected sheets.");
  return { tables, warnings };
}
