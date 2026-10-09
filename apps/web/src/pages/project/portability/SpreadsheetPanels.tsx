// "Spreadsheets" panel: download the model as one XLSX workbook or as CSV
// tables, and import CSV/XLSX files with a preview of every planned change
// before it is applied in one undoable step.

import { useState } from "react";
import { IxButton, IxMessageBar, IxRadio, IxRadioGroup, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { iconDownload, iconEye } from "@siemens/ix-icons/icons";
import { DashboardPanel } from "@/components/DashboardPanel";
import { errorMessage, notifyError, notifySuccess } from "@/components/notify";
import type { CoreLibraryIndex } from "@/domain/coreLibrary";
import type { Project } from "@/domain/model";
import { ModelIndex } from "@/domain/resolve";
import { useProjectStore } from "@/state/projectStore";
import { parseCsv } from "@/portability/csv";
import { downloadBlob, exportFileName } from "@/portability/download";
import {
  TABLE_NAMES,
  applyTableImport,
  buildExportTables,
  detectTable,
  fromCsvTable,
  planChangeCount,
  planTableImport,
  tableToCsv,
  type TableImportPlan,
  type TableInput,
  type TableInputData,
  type TableName,
} from "@/portability/tables";
import { FileDrop, MessageList } from "./FileDrop";
import { ImportPreview } from "./ImportPreview";
import styles from "./Portability.module.css";

type Delimiter = "," | ";";

interface SourceFile {
  id: string;
  fileName: string;
  kind: "csv" | "xlsx";
  /** CSV: detected or chosen table. */
  table?: TableName;
  data?: TableInputData;
  /** XLSX: all sheets. */
  tables?: TableInput;
  warnings: string[];
  /** CSV whose table could not be detected: the user picks it. */
  needsChoice?: boolean;
}

function isXlsx(file: File): boolean {
  return /\.xlsx$/i.test(file.name) || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

async function readSource(file: File, id: string): Promise<SourceFile> {
  if (isXlsx(file)) {
    const { readWorkbook } = await import("@/portability/xlsx");
    const { tables, warnings } = await readWorkbook(await file.arrayBuffer());
    return { id, fileName: file.name, kind: "xlsx", tables, warnings };
  }
  const csv = parseCsv(await file.text());
  if (csv.headers.length === 0) throw new Error(`“${file.name}” is empty.`);
  const table = detectTable(file.name, csv.headers);
  return {
    id,
    fileName: file.name,
    kind: "csv",
    table,
    needsChoice: !table,
    data: fromCsvTable(csv),
    warnings: [],
  };
}

/** Merge the sources into one input; reports tables that appear in more than one file. */
function mergeSources(sources: SourceFile[]): { input: TableInput; errors: string[]; warnings: string[] } {
  const input: TableInput = {};
  const origin = new Map<TableName, string>();
  const errors: string[] = [];
  const warnings: string[] = [];
  const add = (table: TableName, data: TableInputData, fileName: string) => {
    const prev = origin.get(table);
    if (prev) {
      errors.push(`Table ${table} is contained in both “${prev}” and “${fileName}”. Import one of them at a time.`);
      return;
    }
    origin.set(table, fileName);
    input[table] = data;
  };
  for (const s of sources) {
    warnings.push(...s.warnings.map((w) => `${s.fileName}: ${w}`));
    if (s.kind === "xlsx") {
      for (const t of TABLE_NAMES) if (s.tables?.[t]) add(t, s.tables[t], s.fileName);
    } else if (s.table && s.data) add(s.table, s.data, s.fileName);
  }
  return { input, errors, warnings };
}

export function SpreadsheetPanels({ project, core }: { project: Project; core: CoreLibraryIndex }) {
  const [delimiter, setDelimiter] = useState<Delimiter>(",");
  const [exporting, setExporting] = useState(false);
  const [reading, setReading] = useState(false);
  const [sources, setSources] = useState<SourceFile[]>([]);
  const [readErrors, setReadErrors] = useState<string[]>([]);
  const [plan, setPlan] = useState<TableImportPlan | null>(null);
  const [planWarnings, setPlanWarnings] = useState<string[]>([]);

  const exportTables = () => buildExportTables(new ModelIndex(project, core));

  async function downloadWorkbook() {
    setExporting(true);
    try {
      const { buildWorkbook } = await import("@/portability/xlsx");
      const blob = await buildWorkbook(exportTables(), project);
      downloadBlob(blob, exportFileName(project.name, "xlsx", "model"));
      notifySuccess("Workbook exported.");
    } catch (e) {
      notifyError(e, "Workbook export failed");
    } finally {
      setExporting(false);
    }
  }

  function downloadCsv(table: TableName) {
    const csv = tableToCsv(exportTables()[table], delimiter);
    // BOM: lets Excel detect UTF-8; the importer strips it.
    downloadBlob(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), exportFileName(project.name, "csv", table));
  }

  function computePlan(list: SourceFile[]) {
    const { input, errors, warnings } = mergeSources(list);
    if (list.some((s) => s.kind === "csv" && !s.table)) {
      setPlan(null);
      setReadErrors(errors);
      return;
    }
    if (errors.length) {
      setPlan(null);
      setReadErrors(errors);
      return;
    }
    setReadErrors([]);
    try {
      const current = useProjectStore.getState().project ?? project;
      setPlan(planTableImport(current, core, input));
      setPlanWarnings(warnings);
    } catch (e) {
      setPlan(null);
      setReadErrors([`The preview could not be computed: ${errorMessage(e)}`]);
    }
  }

  async function onFiles(files: File[]) {
    setReading(true);
    setPlan(null);
    const errors: string[] = [];
    const read: SourceFile[] = [];
    for (const [i, f] of files.entries()) {
      try {
        read.push(await readSource(f, `${Date.now()}-${i}`));
      } catch (e) {
        errors.push(`${f.name}: ${errorMessage(e)}`);
      }
    }
    setReading(false);
    setSources(read);
    if (errors.length || read.length === 0) {
      setReadErrors(errors.length ? errors : ["No readable file was selected."]);
      return;
    }
    computePlan(read);
  }

  function chooseTable(id: string, table: TableName) {
    const next = sources.map((s) => (s.id === id ? { ...s, table } : s));
    setSources(next);
    setPlan(null);
  }

  function reset() {
    setSources([]);
    setPlan(null);
    setReadErrors([]);
    setPlanWarnings([]);
  }

  function apply() {
    if (!plan) return;
    const n = planChangeCount(plan);
    try {
      useProjectStore
        .getState()
        .apply(`Spreadsheet import: ${plan.counts.create} created, ${plan.counts.update} updated`, (d) => applyTableImport(d, plan));
      notifySuccess(`Applied ${n} change(s). Use Undo to revert the import.`);
      reset();
    } catch (e) {
      notifyError(e, "Import failed");
    }
  }

  const undetected = sources.filter((s) => s.needsChoice);
  const unresolved = sources.some((s) => s.kind === "csv" && !s.table);
  const stale = !!plan && plan.baseUpdatedAt !== project.updatedAt;

  return (
    <>
      <DashboardPanel title="Spreadsheets" span="span-2">
        <div className={styles.stack}>
          <div className={styles.group}>
            <h3 className={`typography-h5 ${styles.subTitle}`}>Export</h3>
            <IxTypography format="body-sm" textColor="soft" className={styles.text}>
              One workbook with a README sheet and one sheet per table (frozen headers, value lists for enumerations), or each table
              as CSV. Edit in Excel and import it again.
            </IxTypography>
            <div className={styles.row}>
              <IxButton variant="primary" icon={iconDownload} loading={exporting} disabled={exporting} onClick={() => void downloadWorkbook()}>
                Download workbook (.xlsx)
              </IxButton>
            </div>
            <IxRadioGroup
              label="CSV delimiter"
              direction="row"
              value={delimiter}
              onValueChange={(e) => setDelimiter(e.detail === ";" ? ";" : ",")}
            >
              <IxRadio label="Comma (,)" value="," />
              <IxRadio label="Semicolon (;) — Excel in many European locales" value=";" />
            </IxRadioGroup>
            <div className={styles.row} role="group" aria-label="Download a table as CSV">
              {TABLE_NAMES.map((t) => (
                <IxButton key={t} variant="subtle-secondary" icon={iconDownload} onClick={() => downloadCsv(t)}>
                  {`${t}.csv`}
                </IxButton>
              ))}
            </div>
          </div>

          <hr className={styles.divider} />

          <div className={styles.group}>
            <h3 className={`typography-h5 ${styles.subTitle}`}>Import</h3>
            <IxTypography format="body-sm" textColor="soft" className={styles.text}>
              Import a workbook or one or more CSV tables. Rows are matched by uid, otherwise by natural key; nothing is deleted.
              You review every change before it is applied.
            </IxTypography>
            <FileDrop
              buttonLabel="Choose files"
              hint="Drop an .xlsx workbook or .csv tables here, or"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              multiple
              busy={reading}
              onFiles={(files) => void onFiles(files)}
            />
            {undetected.length ? (
              <div className={styles.group}>
                <IxTypography format="body-sm" className={styles.text}>
                  Choose the table for the following file(s):
                </IxTypography>
                <ul className={styles.fileList}>
                  {undetected.map((s) => (
                    <li key={s.id} className={styles.fileItem}>
                      <IxTypography format="body-sm" className={styles.fileName}>
                        {s.fileName}
                      </IxTypography>
                      <IxSelect
                        label={`Table of ${s.fileName}`}
                        value={s.table ?? ""}
                        onValueChange={(e) => {
                          const v = Array.isArray(e.detail) ? e.detail[0] : e.detail;
                          if (v && (TABLE_NAMES as readonly string[]).includes(v)) chooseTable(s.id, v as TableName);
                        }}
                      >
                        {TABLE_NAMES.map((t) => (
                          <IxSelectItem key={t} value={t} label={t} />
                        ))}
                      </IxSelect>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {sources.length > 0 && !plan && !unresolved && readErrors.length === 0 ? (
              <div className={styles.row}>
                <IxButton variant="primary" icon={iconEye} onClick={() => computePlan(sources)}>
                  Preview changes
                </IxButton>
              </div>
            ) : null}
            {readErrors.length ? (
              <IxMessageBar type="alarm" onClosedChange={() => setReadErrors([])}>
                <MessageList items={readErrors} />
              </IxMessageBar>
            ) : null}
          </div>
        </div>
      </DashboardPanel>

      {plan ? (
        <ImportPreview
          plan={plan}
          fileWarnings={[...planWarnings, ...plan.warnings]}
          stale={stale}
          onRefresh={() => computePlan(sources)}
          onApply={apply}
          onCancel={reset}
        />
      ) : null}
    </>
  );
}
