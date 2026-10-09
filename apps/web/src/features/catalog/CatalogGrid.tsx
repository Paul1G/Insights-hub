// iX-themed AG Grid for catalog lists (lists-tables/data-grid): virtualised
// rows, quick filter, optional multi-row selection.

import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type { CellKeyDownEvent, ColDef, GetRowIdParams, RowSelectionOptions, SelectionChangedEvent } from "ag-grid-community";
import styles from "./catalog.module.css";

export function CatalogGrid<T>({
  label,
  rows,
  columns,
  rowId,
  quickFilter,
  selectable,
  isRowSelectable,
  selectedIds,
  onSelectionChange,
  onOpen,
}: {
  label: string;
  rows: T[];
  columns: ColDef<T>[];
  rowId: (row: T) => string;
  quickFilter: string;
  selectable: boolean;
  isRowSelectable?: (row: T) => boolean;
  /** Ids to (re)select when the grid is ready. */
  selectedIds?: ReadonlySet<string>;
  onSelectionChange?: (rows: T[]) => void;
  onOpen?: (row: T) => void;
}) {
  const rowSelection = useMemo<RowSelectionOptions<T> | undefined>(
    () =>
      selectable
        ? {
            mode: "multiRow",
            checkboxes: true,
            headerCheckbox: true,
            selectAll: "filtered",
            enableClickSelection: false,
            isRowSelectable: isRowSelectable ? (node) => (node.data ? isRowSelectable(node.data) : false) : undefined,
          }
        : undefined,
    [selectable, isRowSelectable],
  );
  return (
    <section aria-label={label} className={styles.grid}>
      <AgGridReact<T>
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true, filter: false }}
        getRowId={(p: GetRowIdParams<T>) => rowId(p.data)}
        rowSelection={rowSelection}
        quickFilterText={quickFilter}
        onFirstDataRendered={(e) => {
          if (!selectedIds?.size) return;
          e.api.forEachNode((n) => {
            if (n.data && selectedIds.has(rowId(n.data))) n.setSelected(true);
          });
        }}
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
