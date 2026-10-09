// House table (iX-themed AG Grid, lists-tables/data-grid) with optional
// multi-row selection. Fixed-height container: AG Grid virtualises rows, so
// levels with thousands of entries stay fast.

import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type { CellKeyDownEvent, ColDef, GetRowIdParams, RowSelectionOptions, SelectionChangedEvent } from "ag-grid-community";
import styles from "./explorer.module.css";

export function Grid<T>({
  label,
  rows,
  columns,
  rowId,
  multiSelect,
  isRowSelectable,
  onSelectionChange,
  onOpen,
  size = "normal",
  context,
}: {
  /** Accessible name of the table region (AG Grid has no prop for the grid's own name). */
  label: string;
  rows: T[];
  columns: ColDef<T>[];
  rowId: (row: T) => string;
  multiSelect?: boolean;
  isRowSelectable?: (row: T) => boolean;
  onSelectionChange?: (rows: T[]) => void;
  /** Row click / Enter: show the row's details. */
  onOpen?: (row: T) => void;
  size?: "short" | "normal" | "tall";
  /** Passed to cell renderers as `context` (e.g. row action callbacks). */
  context?: unknown;
}) {
  const rowSelection = useMemo<RowSelectionOptions<T> | undefined>(
    () =>
      multiSelect
        ? {
            mode: "multiRow",
            checkboxes: true,
            headerCheckbox: true,
            enableClickSelection: false,
            isRowSelectable: isRowSelectable ? (node) => (node.data ? isRowSelectable(node.data) : false) : undefined,
          }
        : undefined,
    [multiSelect, isRowSelectable],
  );
  const cls = size === "short" ? styles.gridSectionShort : size === "tall" ? styles.gridSectionTall : styles.gridSection;
  return (
    <section aria-label={label} className={cls}>
      <AgGridReact<T>
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true, filter: false }}
        getRowId={(p: GetRowIdParams<T>) => rowId(p.data)}
        rowSelection={rowSelection}
        context={context}
        onSelectionChanged={(e: SelectionChangedEvent<T>) => onSelectionChange?.(e.api.getSelectedRows())}
        onRowClicked={(e) => {
          if (e.data) onOpen?.(e.data);
        }}
        onCellKeyDown={(e: CellKeyDownEvent<T>) => {
          const ke = e.event as KeyboardEvent | null | undefined;
          if (ke?.key === "Enter" && e.data) onOpen?.(e.data);
        }}
        overlayNoRowsTemplate="<span>No entries</span>"
      />
    </section>
  );
}
