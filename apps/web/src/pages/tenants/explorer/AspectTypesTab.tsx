// Aspect types tab: list (client search + server name filter), details,
// create / edit / delete, batch delete.

import { useCallback, useMemo, useState } from "react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { IxButton, IxCard, IxCardContent, IxChip, IxEmptyState, IxIcon, IxInput, IxTypography } from "@siemens/ix-react";
import { iconAdd, iconPen, iconRefresh, iconSearch, iconTrashcan } from "@siemens/ix-icons/icons";
import type { AmAspectTypeResource } from "@/api/amTypes";
import { isCoreId } from "@/domain/coreLibrary";
import { planDeleteTypes } from "@/online/batch";
import { buildFilter, matchesSearch, textCondition } from "@/online/filters";
import { useTenantList } from "@/online/hooks";
import { aspectTypeDeleteImpact, aspectTypeUsers } from "@/online/impact";
import { deleteAspectType, openAspectTypeCreateDialog, openAspectTypeEditDialog } from "./AspectTypeDialogs";
import { openBatchDialog } from "./BatchDialog";
import { itemsOf, type Catalog } from "./catalog";
import { Grid } from "./Grid";
import { ErrorBanner, KeyValueGrid, Loading, PartialFailureBanner } from "./ui";
import styles from "./explorer.module.css";

function CategoryCell({ data }: ICellRendererParams<AmAspectTypeResource>) {
  if (!data) return null;
  return (
    <IxChip variant={data.category === "dynamic" ? "info" : "neutral"} outline inactive>
      {data.category}
    </IxChip>
  );
}

function OriginCell({ data }: ICellRendererParams<AmAspectTypeResource>) {
  if (!data) return null;
  return isCoreId(data.id) ? (
    <IxChip variant="neutral" inactive>
      core · read-only
    </IxChip>
  ) : (
    <IxChip variant="primary" outline inactive>
      tenant
    </IxChip>
  );
}

const COLUMNS: ColDef<AmAspectTypeResource>[] = [
  { field: "name", headerName: "Name", flex: 2, minWidth: 160 },
  { field: "id", headerName: "Id", flex: 2, minWidth: 180 },
  { field: "category", headerName: "Category", width: 130, cellRenderer: CategoryCell },
  { headerName: "Variables", width: 120, type: "rightAligned", valueGetter: (p) => p.data?.variables.length ?? 0 },
  { headerName: "Origin", width: 170, cellRenderer: OriginCell, valueGetter: (p) => (p.data && isCoreId(p.data.id) ? "core" : "tenant") },
];

export function AspectTypesTab({ catalog }: { catalog: Catalog }) {
  const [search, setSearch] = useState("");
  const [serverInput, setServerInput] = useState("");
  const [serverFilter, setServerFilter] = useState<string | undefined>();
  const [selected, setSelected] = useState<AmAspectTypeResource[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const filtered = useTenantList<AmAspectTypeResource>(
    catalog.connectionId,
    { resource: "aspecttypes", filter: serverFilter },
    !!serverFilter,
  );
  const source = serverFilter ? filtered : catalog.aspectTypes;
  const all = itemsOf(source);
  const rows = useMemo(
    () => all.filter((t) => matchesSearch(search, t.name, t.id, t.category, t.description)),
    [all, search],
  );
  const active = all.find((t) => t.id === activeId) ?? null;
  const assetTypes = itemsOf(catalog.assetTypes);

  const refresh = useCallback(() => {
    catalog.aspectTypes.reload();
    catalog.assetTypes.reload();
    if (serverFilter) filtered.reload();
  }, [catalog.aspectTypes, catalog.assetTypes, filtered, serverFilter]);

  async function create() {
    const created = await openAspectTypeCreateDialog(catalog);
    if (created) {
      refresh();
      setActiveId(created.id);
    }
  }

  async function batchDelete() {
    const items = planDeleteTypes(
      "aspecttypes",
      selected.map((t) => {
        const impact = aspectTypeDeleteImpact(t, assetTypes);
        return { id: t.id, name: t.name, etag: t.etag, blockedReason: impact.blocked ? impact.reasons.join(" ") : undefined };
      }),
    );
    await openBatchDialog({
      connectionId: catalog.connectionId,
      title: "Batch delete aspect types",
      auditAction: "batch.delete-aspecttypes",
      items,
      danger: true,
      intro: "Aspect types in use or core types are blocked. Deleting cannot be undone.",
    });
    setSelected([]);
    refresh();
  }

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <search aria-label="Aspect type search and filters" className={styles.toolbarSearch}>
          <IxInput
            className={styles.searchInput}
            label="Search loaded aspect types"
            placeholder="Name, id, description…"
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
          <IxButton
            variant="secondary"
            onClick={() => setServerFilter(buildFilter({ name: textCondition("contains", serverInput) }))}
          >
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
            Create aspect type
          </IxButton>
        </div>
      </div>

      <ErrorBanner error={source.error} prefix="Aspect types could not be loaded" />
      <PartialFailureBanner result={source.data} what="aspect type" />
      <div role="status" className={styles.srOnly}>
        {source.loading ? "" : `${rows.length} of ${all.length} aspect types shown.`}
      </div>

      <div className={styles.split}>
        <div className={styles.stack}>
          {source.loading && !source.data ? <Loading label="Loading aspect types…" /> : null}
          {source.data && rows.length === 0 ? (
            <IxEmptyState
              icon={iconSearch}
              header={all.length ? "No matching aspect types" : "No aspect types"}
              subHeader={all.length ? "Change the search or clear the server filter." : "Create the first aspect type of this tenant."}
              action={all.length ? "Clear search" : "Create aspect type"}
              onActionClick={() => (all.length ? setSearch("") : void create())}
            />
          ) : null}
          {rows.length ? (
            <Grid
              label="Aspect types"
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
        <AspectTypeDetails
          catalog={catalog}
          type={active}
          onChanged={refresh}
          onDeleted={() => {
            setActiveId(null);
            refresh();
          }}
        />
      </div>
    </div>
  );
}

function AspectTypeDetails({
  catalog,
  type,
  onChanged,
  onDeleted,
}: {
  catalog: Catalog;
  type: AmAspectTypeResource | null;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  if (!type) {
    return (
      <IxCard variant="outline" className={styles.card} passive>
        <IxCardContent>
          <div className={styles.cardBody}>
            <h2 className={`typography-h4 ${styles.heading}`}>Details</h2>
            <IxTypography format="body-sm" textColor="soft">
              Select an aspect type to see its variables and where it is used.
            </IxTypography>
          </div>
        </IxCardContent>
      </IxCard>
    );
  }
  const core = isCoreId(type.id);
  const users = aspectTypeUsers(type.id, itemsOf(catalog.assetTypes));
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
            {core ? (
              <IxChip variant="neutral" inactive>
                core · read-only
              </IxChip>
            ) : (
              <div className={styles.row}>
                <IxButton
                  variant="secondary"
                  icon={iconPen}
                  onClick={async () => {
                    if (await openAspectTypeEditDialog(catalog, type)) onChanged();
                  }}
                >
                  Edit aspect type
                </IxButton>
                <IxButton
                  variant="danger-secondary"
                  icon={iconTrashcan}
                  onClick={async () => {
                    if (await deleteAspectType(catalog, type)) onDeleted();
                  }}
                >
                  Delete aspect type
                </IxButton>
              </div>
            )}
          </div>
          <KeyValueGrid
            items={[
              { label: "Category", value: type.category },
              { label: "Scope", value: type.scope },
              { label: "ETag", value: String(type.etag) },
              { label: "Used by asset types", value: String(users.length) },
              { label: "Description", value: type.description ?? "" },
            ]}
          />
          <h3 className={`typography-h6 ${styles.heading}`}>Variables ({type.variables.length})</h3>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Name</IxTypography></th>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Type</IxTypography></th>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Unit</IxTypography></th>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Length</IxTypography></th>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Flags</IxTypography></th>
                  {type.category === "static" ? (
                    <th scope="col"><IxTypography format="label-sm" textColor="soft">Default</IxTypography></th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {type.variables.map((v) => (
                  <tr key={v.name}>
                    <td><IxTypography format="body-sm">{v.name}</IxTypography></td>
                    <td><IxTypography format="code-sm">{v.dataType}</IxTypography></td>
                    <td><IxTypography format="body-sm">{v.unit ?? "—"}</IxTypography></td>
                    <td><IxTypography format="body-sm">{v.length ?? "—"}</IxTypography></td>
                    <td>
                      <IxTypography format="body-xs" textColor="soft">
                        {[v.searchable ? "searchable" : null, v.qualityCode ? "quality code" : null].filter(Boolean).join(", ") || "—"}
                      </IxTypography>
                    </td>
                    {type.category === "static" ? (
                      <td><IxTypography format="body-sm">{v.defaultValue ?? "—"}</IxTypography></td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className={`typography-h6 ${styles.heading}`}>Used by</h3>
          {users.length ? (
            <ul className={styles.list}>
              {users.map((u) => (
                <li key={u.type.id} className={styles.listItem}>
                  <IxTypography format="body-sm">{u.type.name}</IxTypography>
                  <IxTypography format="body-xs" textColor="soft">
                    {u.type.id} · aspect {u.aspectNames.join(", ")}
                  </IxTypography>
                </li>
              ))}
            </ul>
          ) : (
            <IxTypography format="body-sm" textColor="soft">
              No asset type uses this aspect type{catalog.assetTypes.loading ? " (asset types are still loading)" : ""}.
            </IxTypography>
          )}
        </div>
      </IxCardContent>
    </IxCard>
  );
}
