// Browse a tenant catalog: existing asset types, aspect types and assets, with
// search, status filter (in project / not in project), selection for import
// and read-only details.

import { useMemo, useState } from "react";
import { IxIcon, IxInput, IxSelect, IxSelectItem, IxTabItem, IxTabs, IxTypography } from "@siemens/ix-react";
import { iconSearch } from "@siemens/ix-icons/icons";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import type { ProjectCorrespondence } from "@/catalog/importToProject";
import type { CoreLibraryIndex } from "@/domain/coreLibrary";
import type { ExternalTypes } from "@/domain/external";
import type { TenantSnapshot } from "@/tenant/read";
import { CatalogGrid } from "./CatalogGrid";
import { AspectTypeDetails, AssetDetails, AssetTypeDetails, StatusChip } from "./CatalogDetails";
import { ORIGIN_LABEL, aspectTypeRows, assetRows, assetTypeRows, type AspectTypeRow, type AssetRow, type AssetTypeRow, type RowStatus } from "./rows";
import styles from "./catalog.module.css";

export type CatalogTab = "assetTypes" | "aspectTypes" | "assets";

export interface CatalogSelection {
  assetTypeIds: string[];
  aspectTypeIds: string[];
  assetIds: string[];
}

export const EMPTY_SELECTION: CatalogSelection = { assetTypeIds: [], aspectTypeIds: [], assetIds: [] };

type StatusFilter = "all" | RowStatus;
type OriginFilter = "all" | "tenant" | "external" | "core";

function StatusCell<T extends { status: RowStatus }>({ data }: ICellRendererParams<T>) {
  return data ? <StatusChip status={data.status} /> : null;
}

function IndentedName({ data }: ICellRendererParams<AssetRow>) {
  if (!data) return null;
  return (
    <span className={styles.indent} style={{ paddingInlineStart: `calc(${Math.max(0, data.depth - 1)} * var(--theme-space-3))` }}>
      {data.name}
    </span>
  );
}

export function CatalogBrowser({
  snapshot,
  core,
  external,
  match,
  selectable,
  selection,
  onSelectionChange,
  tabs = ["assetTypes", "aspectTypes", "assets"],
}: {
  snapshot: TenantSnapshot;
  core: CoreLibraryIndex;
  external?: ExternalTypes;
  /** When given, rows show whether the project already contains them. */
  match?: ProjectCorrespondence;
  selectable: boolean;
  selection?: CatalogSelection;
  onSelectionChange?: (next: CatalogSelection) => void;
  tabs?: CatalogTab[];
}) {
  const [tab, setTab] = useState<CatalogTab>(tabs[0] ?? "assetTypes");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [origin, setOrigin] = useState<OriginFilter>("all");
  const [openId, setOpenId] = useState<string>();

  const typeRows = useMemo(() => assetTypeRows(snapshot, match), [snapshot, match]);
  const aspectRows = useMemo(() => aspectTypeRows(snapshot, match), [snapshot, match]);
  const assetList = useMemo(() => assetRows(snapshot, match), [snapshot, match]);

  const keep = <T extends { status: RowStatus; origin?: string }>(r: T) =>
    (status === "all" || r.status === status) && (origin === "all" || !r.origin || r.origin === origin);
  const shownTypes = useMemo(() => typeRows.filter(keep), [typeRows, status, origin]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownAspects = useMemo(() => aspectRows.filter(keep), [aspectRows, status, origin]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownAssets = useMemo(() => assetList.filter((r) => status === "all" || r.status === status), [assetList, status]);

  const usedBy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of typeRows) {
      for (const a of (t.resource.aspects ?? []).filter((x) => !x._links?.origin)) {
        const id = a.aspectType?.id?.toLowerCase();
        if (id) m.set(id, [...(m.get(id) ?? []), t.name]);
      }
    }
    return m;
  }, [typeRows]);

  const typeColumns = useMemo<ColDef<AssetTypeRow>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 2, minWidth: 180 },
      ...(match ? [{ field: "status", headerName: "Project", width: 150, cellRenderer: StatusCell } as ColDef<AssetTypeRow>] : []),
      { field: "id", headerName: "Id", flex: 2, minWidth: 180 },
      { field: "parentTypeId", headerName: "Parent", flex: 2, minWidth: 160 },
      { field: "origin", headerName: "Origin", width: 150, valueFormatter: (p) => (p.value ? ORIGIN_LABEL[p.value as AssetTypeRow["origin"]] : "") },
      { field: "variables", headerName: "Vars", width: 90, type: "rightAligned" },
      { field: "aspects", headerName: "Aspects", width: 100, type: "rightAligned" },
      { field: "instances", headerName: "Assets", width: 100, type: "rightAligned" },
    ],
    [match],
  );
  const aspectColumns = useMemo<ColDef<AspectTypeRow>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 2, minWidth: 180 },
      ...(match ? [{ field: "status", headerName: "Project", width: 150, cellRenderer: StatusCell } as ColDef<AspectTypeRow>] : []),
      { field: "id", headerName: "Id", flex: 2, minWidth: 180 },
      { field: "category", headerName: "Category", width: 120 },
      { field: "origin", headerName: "Origin", width: 150, valueFormatter: (p) => (p.value ? ORIGIN_LABEL[p.value as AspectTypeRow["origin"]] : "") },
      { field: "variables", headerName: "Vars", width: 90, type: "rightAligned" },
      { field: "usedBy", headerName: "Used by", width: 100, type: "rightAligned" },
    ],
    [match],
  );
  const assetColumns = useMemo<ColDef<AssetRow>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 3, minWidth: 220, cellRenderer: IndentedName, sortable: false },
      ...(match ? [{ field: "status", headerName: "Project", width: 150, cellRenderer: StatusCell } as ColDef<AssetRow>] : []),
      { field: "path", headerName: "Path", flex: 3, minWidth: 220, hide: false },
      { field: "typeName", headerName: "Type", flex: 2, minWidth: 160 },
      { field: "externalId", headerName: "External id", flex: 1, minWidth: 120 },
      { field: "children", headerName: "Children", width: 110, type: "rightAligned" },
    ],
    [match],
  );

  // Core types can neither be imported nor need to be: they exist in every tenant.
  const importable = (r: { status: RowStatus }) => r.status === "not-in-project";
  const sel = selection ?? EMPTY_SELECTION;
  const counts = { assetTypes: typeRows.length, aspectTypes: aspectRows.length, assets: assetList.length };
  const label: Record<CatalogTab, string> = { assetTypes: "Asset types", aspectTypes: "Aspect types", assets: "Assets" };

  const detail = (() => {
    if (!openId) return null;
    if (tab === "assetTypes") {
      const row = typeRows.find((r) => r.id === openId);
      return row ? <AssetTypeDetails row={row} core={core} external={external} showStatus={!!match} /> : null;
    }
    if (tab === "aspectTypes") {
      const row = aspectRows.find((r) => r.id === openId);
      return row ? <AspectTypeDetails row={row} usedBy={usedBy.get(row.id.toLowerCase()) ?? []} showStatus={!!match} /> : null;
    }
    const row = assetList.find((r) => r.assetId === openId);
    return row ? <AssetDetails row={row} showStatus={!!match} /> : null;
  })();

  return (
    <div className={styles.stack}>
      <IxTabs
        activeTabKey={tab}
        onTabChange={({ detail: key }) => {
          setTab((key as CatalogTab) ?? tabs[0]);
          setOpenId(undefined);
        }}
      >
        {tabs.map((t) => (
          <IxTabItem key={t} tabKey={t} counter={counts[t]}>
            {label[t]}
          </IxTabItem>
        ))}
      </IxTabs>
      <section role="tabpanel" aria-label={label[tab]} className={styles.stack}>
        <search aria-label={`Search ${label[tab].toLowerCase()}`} className={styles.toolbar}>
          <IxInput className={styles.search} label="Search" value={query} placeholder="Name, id, path, type…" onValueChange={(e) => setQuery(e.detail)}>
            <IxIcon slot="start" name={iconSearch} size="16" aria-hidden="true" />
          </IxInput>
          {match ? (
            <IxSelect className={styles.filter} label="Project status" value={status} onValueChange={(e) => setStatus((e.detail as StatusFilter) || "all")}>
              <IxSelectItem value="all" label="All" />
              <IxSelectItem value="not-in-project" label="Not in project" />
              <IxSelectItem value="in-project" label="In project" />
              {tab !== "assets" ? <IxSelectItem value="core" label="Core" /> : null}
            </IxSelect>
          ) : null}
          {tab !== "assets" ? (
            <IxSelect className={styles.filter} label="Origin" value={origin} onValueChange={(e) => setOrigin((e.detail as OriginFilter) || "all")}>
              <IxSelectItem value="all" label="All origins" />
              <IxSelectItem value="tenant" label="Tenant" />
              <IxSelectItem value="external" label="Shared / other tenant" />
              <IxSelectItem value="core" label="Core (OOTB)" />
            </IxSelect>
          ) : null}
        </search>
        {selectable ? (
          <IxTypography format="body-sm" textColor="soft">
            Selected: {sel.assetTypeIds.length} asset type(s), {sel.aspectTypeIds.length} aspect type(s), {sel.assetIds.length} asset(s).{" "}
            {match ? "Core types and objects already in the project cannot be selected." : "Core types exist in every tenant and cannot be selected."}
          </IxTypography>
        ) : null}
        <div className={styles.layout}>
          {tab === "assetTypes" ? (
            <CatalogGrid<AssetTypeRow>
              key="assetTypes"
              label="Existing asset types"
              rows={shownTypes}
              columns={typeColumns}
              rowId={(r) => r.id}
              quickFilter={query}
              selectable={selectable}
              isRowSelectable={importable}
              selectedIds={new Set(sel.assetTypeIds)}
              onSelectionChange={(rows) => onSelectionChange?.({ ...sel, assetTypeIds: rows.map((r) => r.id) })}
              onOpen={(r) => setOpenId(r.id)}
            />
          ) : tab === "aspectTypes" ? (
            <CatalogGrid<AspectTypeRow>
              key="aspectTypes"
              label="Existing aspect types"
              rows={shownAspects}
              columns={aspectColumns}
              rowId={(r) => r.id}
              quickFilter={query}
              selectable={selectable}
              isRowSelectable={importable}
              selectedIds={new Set(sel.aspectTypeIds)}
              onSelectionChange={(rows) => onSelectionChange?.({ ...sel, aspectTypeIds: rows.map((r) => r.id) })}
              onOpen={(r) => setOpenId(r.id)}
            />
          ) : (
            <CatalogGrid<AssetRow>
              key="assets"
              label="Existing assets"
              rows={shownAssets}
              columns={assetColumns}
              rowId={(r) => r.assetId}
              quickFilter={query}
              selectable={selectable}
              isRowSelectable={importable}
              selectedIds={new Set(sel.assetIds)}
              onSelectionChange={(rows) => onSelectionChange?.({ ...sel, assetIds: rows.map((r) => r.assetId) })}
              onOpen={(r) => setOpenId(r.assetId)}
            />
          )}
          <div>
            {detail ?? (
              <IxTypography format="body-sm" textColor="soft">
                Select a row to see its definition.
              </IxTypography>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
