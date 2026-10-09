// Asset types tab: list (client search + server name filter), details with
// inherited (exploded) variables/aspects read-only, create / edit / delete,
// file assignments, batch delete.

import { useCallback, useMemo, useState } from "react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { IxButton, IxCard, IxCardContent, IxChip, IxEmptyState, IxIcon, IxInput, IxTypography } from "@siemens/ix-react";
import { iconAdd, iconAttach, iconPen, iconRefresh, iconSearch, iconTrashcan } from "@siemens/ix-icons/icons";
import type { AmAssetTypeResource, AmVariableDefinition } from "@/api/amTypes";
import { isCoreId } from "@/domain/coreLibrary";
import { planDeleteTypes } from "@/online/batch";
import { buildFilter, matchesSearch, textCondition } from "@/online/filters";
import { useLoader, useTenantList } from "@/online/hooks";
import { childAssetTypes, directAspects, directVariables } from "@/online/impact";
import {
  deleteAssetType,
  fetchExplodedType,
  openAssetTypeCreateDialog,
  openAssetTypeEditDialog,
  openAssetTypeFileDialog,
  removeAssetTypeFile,
} from "./AssetTypeDialogs";
import { openBatchDialog } from "./BatchDialog";
import { itemsOf, type Catalog } from "./catalog";
import { Grid } from "./Grid";
import { ErrorBanner, KeyValueGrid, Loading, PartialFailureBanner } from "./ui";
import styles from "./explorer.module.css";

function FlagsCell({ data }: ICellRendererParams<AmAssetTypeResource>) {
  if (!data) return null;
  return (
    <div className={styles.row}>
      {isCoreId(data.id) ? (
        <IxChip variant="neutral" inactive>
          core
        </IxChip>
      ) : null}
      {data.instantiable ? (
        <IxChip variant="success" outline inactive>
          instantiable
        </IxChip>
      ) : (
        <IxChip variant="neutral" outline inactive>
          abstract
        </IxChip>
      )}
    </div>
  );
}

const COLUMNS: ColDef<AmAssetTypeResource>[] = [
  { field: "name", headerName: "Name", flex: 2, minWidth: 160 },
  { field: "id", headerName: "Id", flex: 2, minWidth: 180 },
  { field: "parentTypeId", headerName: "Parent", flex: 2, minWidth: 160 },
  { headerName: "Flags", width: 210, cellRenderer: FlagsCell, valueGetter: (p) => (p.data?.instantiable ? "instantiable" : "abstract") },
  { headerName: "Variables", width: 110, type: "rightAligned", valueGetter: (p) => (p.data ? directVariables(p.data).length : 0) },
  { headerName: "Aspects", width: 100, type: "rightAligned", valueGetter: (p) => (p.data ? directAspects(p.data).length : 0) },
];

export function AssetTypesTab({ catalog }: { catalog: Catalog }) {
  const [search, setSearch] = useState("");
  const [serverInput, setServerInput] = useState("");
  const [serverFilter, setServerFilter] = useState<string | undefined>();
  const [selected, setSelected] = useState<AmAssetTypeResource[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const filtered = useTenantList<AmAssetTypeResource>(catalog.connectionId, { resource: "assettypes", filter: serverFilter }, !!serverFilter);
  const source = serverFilter ? filtered : catalog.assetTypes;
  const all = itemsOf(source);
  const rows = useMemo(() => all.filter((t) => matchesSearch(search, t.name, t.id, t.parentTypeId, t.description)), [all, search]);
  const active = all.find((t) => t.id === activeId) ?? null;

  const refresh = useCallback(() => {
    catalog.assetTypes.reload();
    if (serverFilter) filtered.reload();
  }, [catalog.assetTypes, filtered, serverFilter]);

  async function create(parent?: string) {
    const created = await openAssetTypeCreateDialog(catalog, parent);
    if (created) {
      refresh();
      setActiveId(created.id);
    }
  }

  async function batchDelete() {
    const types = itemsOf(catalog.assetTypes);
    const items = planDeleteTypes(
      "assettypes",
      selected.map((t) => {
        const children = childAssetTypes(t.id, types).filter((c) => !selected.some((s) => s.id === c.id));
        const reason = isCoreId(t.id)
          ? "Core asset types are read-only."
          : children.length
            ? `Has ${children.length} child type${children.length === 1 ? "" : "s"} that are not part of this batch.`
            : undefined;
        return { id: t.id, name: t.name, etag: t.etag, blockedReason: reason };
      }),
    );
    await openBatchDialog({
      connectionId: catalog.connectionId,
      title: "Batch delete asset types",
      auditAction: "batch.delete-assettypes",
      items,
      danger: true,
      intro:
        "Types with child types outside the selection are blocked. Insights Hub rejects types that still have instances " +
        "or children (the per-item result shows it). Deleting cannot be undone.",
    });
    setSelected([]);
    refresh();
  }

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <search aria-label="Asset type search and filters" className={styles.toolbarSearch}>
          <IxInput
            className={styles.searchInput}
            label="Search loaded asset types"
            placeholder="Name, id, parent…"
            value={search}
            onValueChange={(e) => setSearch(e.detail)}
          >
            <IxIcon slot="start" name={iconSearch} size="16" aria-hidden="true" />
          </IxInput>
          <IxInput
            className={styles.searchInput}
            label="Server filter: name contains"
            value={serverInput}
            onValueChange={(e) => setServerInput(e.detail)}
          />
          <IxButton variant="secondary" onClick={() => setServerFilter(buildFilter({ name: textCondition("contains", serverInput) }))}>
            Apply filter
          </IxButton>
          {serverFilter ? (
            <IxButton
              variant="subtle-tertiary"
              onClick={() => {
                setServerFilter(undefined);
                setServerInput("");
              }}
            >
              Clear filter
            </IxButton>
          ) : null}
        </search>
        <div className={styles.toolbarActions}>
          <IxButton variant="secondary" icon={iconRefresh} loading={source.loading} onClick={refresh}>
            Refresh
          </IxButton>
          <IxButton variant="danger-secondary" icon={iconTrashcan} disabled={!selected.length} onClick={() => void batchDelete()}>
            Delete selected ({selected.length})
          </IxButton>
          <IxButton variant="primary" icon={iconAdd} onClick={() => void create()}>
            Create asset type
          </IxButton>
        </div>
      </div>

      <ErrorBanner error={source.error} prefix="Asset types could not be loaded" />
      <PartialFailureBanner result={source.data} what="asset type" />
      <div role="status" className={styles.srOnly}>
        {source.loading ? "" : `${rows.length} of ${all.length} asset types shown.`}
      </div>

      <div className={styles.split}>
        <div className={styles.stack}>
          {source.loading && !source.data ? <Loading label="Loading asset types…" /> : null}
          {source.data && rows.length === 0 ? (
            <IxEmptyState
              icon={iconSearch}
              header={all.length ? "No matching asset types" : "No asset types"}
              subHeader={all.length ? "Change the search or clear the server filter." : "Create the first asset type of this tenant."}
              action={all.length ? "Clear search" : "Create asset type"}
              onActionClick={() => (all.length ? setSearch("") : void create())}
            />
          ) : null}
          {rows.length ? (
            <Grid
              label="Asset types"
              rows={rows}
              columns={COLUMNS}
              rowId={(t) => t.id}
              multiSelect
              isRowSelectable={(t) => !isCoreId(t.id)}
              onSelectionChange={setSelected}
              onOpen={(t) => setActiveId(t.id)}
            />
          ) : null}
        </div>
        <AssetTypeDetails
          catalog={catalog}
          type={active}
          onChanged={refresh}
          onCreateChild={(id) => void create(id)}
          onDeleted={() => {
            setActiveId(null);
            refresh();
          }}
        />
      </div>
    </div>
  );
}

function VariableTable({ variables, caption }: { variables: AmVariableDefinition[]; caption: string }) {
  if (!variables.length) {
    return (
      <IxTypography format="body-sm" textColor="soft">
        None.
      </IxTypography>
    );
  }
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} aria-label={caption}>
        <thead>
          <tr>
            <th scope="col"><IxTypography format="label-sm" textColor="soft">Name</IxTypography></th>
            <th scope="col"><IxTypography format="label-sm" textColor="soft">Type</IxTypography></th>
            <th scope="col"><IxTypography format="label-sm" textColor="soft">Unit</IxTypography></th>
            <th scope="col"><IxTypography format="label-sm" textColor="soft">Length</IxTypography></th>
            <th scope="col"><IxTypography format="label-sm" textColor="soft">Default</IxTypography></th>
            <th scope="col"><IxTypography format="label-sm" textColor="soft">Origin</IxTypography></th>
          </tr>
        </thead>
        <tbody>
          {variables.map((v) => (
            <tr key={v.name}>
              <td><IxTypography format="body-sm">{v.name}{v.searchable ? " (searchable)" : ""}</IxTypography></td>
              <td><IxTypography format="code-sm">{v.dataType}</IxTypography></td>
              <td><IxTypography format="body-sm">{v.unit ?? "—"}</IxTypography></td>
              <td><IxTypography format="body-sm">{v.length ?? "—"}</IxTypography></td>
              <td><IxTypography format="body-sm">{v.defaultValue ?? "—"}</IxTypography></td>
              <td>
                <IxTypography format="body-xs" textColor="soft">
                  {v._links?.origin ? `inherited · ${originId(v._links.origin.href)}` : "own"}
                </IxTypography>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Type id at the end of an origin link (".../assettypes/acme.Base"). */
function originId(href: string): string {
  const m = /\/assettypes\/([^/?#]+)/.exec(href);
  return m ? decodeURIComponent(m[1]!) : href;
}

function AssetTypeDetails({
  catalog,
  type,
  onChanged,
  onDeleted,
  onCreateChild,
}: {
  catalog: Catalog;
  type: AmAssetTypeResource | null;
  onChanged: () => void;
  onDeleted: () => void;
  onCreateChild: (parentId: string) => void;
}) {
  const exploded = useLoader(
    () => fetchExplodedType(catalog.connectionId, type!.id).then((r) => r.resource),
    `exploded:${type?.id}:${type?.etag}`,
    !!type,
  );
  if (!type) {
    return (
      <IxCard variant="outline" className={styles.card} passive>
        <IxCardContent>
          <div className={styles.cardBody}>
            <h2 className={`typography-h4 ${styles.heading}`}>Details</h2>
            <IxTypography format="body-sm" textColor="soft">
              Select an asset type to see its own and inherited variables, aspects and files.
            </IxTypography>
          </div>
        </IxCardContent>
      </IxCard>
    );
  }
  const core = isCoreId(type.id);
  const full = exploded.data && exploded.data.id === type.id ? exploded.data : null;
  const variables = full?.variables ?? type.variables;
  const aspects = full?.aspects ?? type.aspects;
  const files = full?.fileAssignments ?? type.fileAssignments ?? [];
  const children = childAssetTypes(type.id, itemsOf(catalog.assetTypes));
  const fileName = (id: string) => itemsOf(catalog.files).find((f) => f.id === id)?.name ?? id;

  return (
    <IxCard variant="outline" className={styles.card} passive>
      <IxCardContent>
        <div className={styles.cardBody}>
          <div className={styles.headerRow}>
            <div className={styles.headerText}>
              <h2 className={`typography-h4 ${styles.heading}`}>{type.name}</h2>
              <IxTypography format="code-sm" textColor="soft">
                {type.id}
              </IxTypography>
            </div>
            <div className={styles.row}>
              <IxButton variant="secondary" icon={iconAdd} onClick={() => onCreateChild(type.id)}>
                Create child type
              </IxButton>
              {core ? (
                <IxChip variant="neutral" inactive>
                  core · read-only
                </IxChip>
              ) : (
                <>
                  <IxButton
                    variant="secondary"
                    icon={iconPen}
                    onClick={async () => {
                      if (await openAssetTypeEditDialog(catalog, type, full)) onChanged();
                    }}
                  >
                    Edit asset type
                  </IxButton>
                  <IxButton
                    variant="danger-secondary"
                    icon={iconTrashcan}
                    onClick={async () => {
                      if (await deleteAssetType(catalog, type)) onDeleted();
                    }}
                  >
                    Delete asset type
                  </IxButton>
                </>
              )}
            </div>
          </div>
          <KeyValueGrid
            items={[
              { label: "Parent type", value: type.parentTypeId },
              { label: "Instantiable", value: type.instantiable ? "yes" : "no" },
              { label: "Scope", value: type.scope },
              { label: "ETag", value: String(type.etag) },
              { label: "Child types", value: children.length ? children.map((c) => c.name).join(", ") : "none" },
              { label: "Description", value: type.description ?? "" },
            ]}
          />
          {exploded.loading && !full ? <Loading label="Loading inherited variables and aspects…" /> : null}
          <ErrorBanner error={exploded.error} prefix="Inherited definitions could not be loaded" />
          <h3 className={`typography-h6 ${styles.heading}`}>Variables</h3>
          <VariableTable variables={variables} caption={`Variables of ${type.name}`} />
          <h3 className={`typography-h6 ${styles.heading}`}>Aspects</h3>
          {aspects.length ? (
            <ul className={styles.list}>
              {aspects.map((a) => (
                <li key={a.aspectId ?? a.name} className={styles.listItem}>
                  <IxTypography format="body-sm">{a.name}</IxTypography>
                  <IxTypography format="body-xs" textColor="soft">
                    {a.aspectType?.id ?? ""} · {a.aspectType?.category ?? ""}
                    {a._links?.origin ? ` · inherited from ${originId(a._links.origin.href)}` : " · own"}
                  </IxTypography>
                </li>
              ))}
            </ul>
          ) : (
            <IxTypography format="body-sm" textColor="soft">
              None.
            </IxTypography>
          )}
          <div className={styles.headerRow}>
            <h3 className={`typography-h6 ${styles.heading}`}>File assignments</h3>
            {!core ? (
              <IxButton
                variant="subtle-primary"
                icon={iconAttach}
                onClick={async () => {
                  if (await openAssetTypeFileDialog(catalog, type)) onChanged();
                }}
              >
                Assign file
              </IxButton>
            ) : null}
          </div>
          {files.length ? (
            <ul className={styles.list}>
              {files.map((f) => (
                <li key={f.key} className={styles.listItem}>
                  <IxTypography format="body-sm">{f.key}</IxTypography>
                  <IxTypography format="body-xs" textColor="soft">
                    {fileName(f.fileId)}
                    {f._links?.origin ? " · inherited" : ""}
                  </IxTypography>
                  {!core && !f._links?.origin ? (
                    <IxButton
                      variant="subtle-tertiary"
                      icon={iconTrashcan}
                      onClick={async () => {
                        if (await removeAssetTypeFile(catalog, type, f.key)) onChanged();
                      }}
                    >
                      Remove {f.key}
                    </IxButton>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <IxTypography format="body-sm" textColor="soft">
              None.
            </IxTypography>
          )}
        </div>
      </IxCardContent>
    </IxCard>
  );
}
