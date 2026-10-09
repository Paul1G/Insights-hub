// Assets tab: lazy hierarchy navigator starting at GET /assets/root. Each
// level is loaded with listAll filter {"parentId": id} into a virtualised
// grid with multi-select for batch operations; a tenant-wide server search
// (name contains, type incl. derived types) jumps to any asset.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import {
  IxButton,
  IxCard,
  IxCardContent,
  IxChip,
  IxEmptyState,
  IxIcon,
  IxInput,
  IxSelect,
  IxSelectItem,
  IxTypography,
} from "@siemens/ix-react";
import {
  iconAdd,
  iconArrowUp,
  iconAttach,
  iconHierarchy,
  iconLocation,
  iconMove,
  iconPen,
  iconRefresh,
  iconSearch,
  iconTrashcan,
} from "@siemens/ix-icons/icons";
import type { AmAssetResource } from "@/api/amTypes";
import { notifyInfo } from "@/components/notify";
import { assetBreadcrumb, hasOwnLocation } from "@/online/assets";
import { mapWithConcurrency, planDeleteAssets, planMoveAssets, planSetVariable, type AssetChildInfo } from "@/online/batch";
import { fetchWithEtag } from "@/online/etag";
import { assetFilters, buildFilter, matchesSearch, textCondition } from "@/online/filters";
import { useLoader, useTenantList } from "@/online/hooks";
import { countAssets } from "@/online/impact";
import { amPath, defaultTransport } from "@/online/transport";
import {
  deleteAsset,
  fetchAsset,
  moveAsset,
  openAssetCreateDialog,
  openAssetEditDialog,
  openAssetFileDialog,
  openLocationDialog,
  openMoveTargetDialog,
  openSetVariableDialog,
  removeAssetFile,
  removeLocation,
} from "./AssetDialogs";
import { openBatchDialog } from "./BatchDialog";
import { itemsOf, type Catalog } from "./catalog";
import { Grid } from "./Grid";
import { ErrorBanner, KeyValueGrid, Loading, notifyFailure, PartialFailureBanner } from "./ui";
import styles from "./explorer.module.css";

function OpenCell({ data, context }: ICellRendererParams<AmAssetResource, unknown, { open: (a: AmAssetResource) => void }>) {
  if (!data) return null;
  return (
    <div className={styles.cellButton}>
      <IxButton variant="subtle-tertiary" icon={iconHierarchy} onClick={() => context.open(data)}>
        Open {data.name}
      </IxButton>
    </div>
  );
}

function Breadcrumbs({ path, onNavigate }: { path: { assetId: string; name: string }[]; onNavigate: (id: string) => void }) {
  return (
    <nav aria-label="Hierarchy path" className={styles.breadcrumbs}>
      {path.map((p, i) => {
        const last = i === path.length - 1;
        return (
          <span key={p.assetId} className={styles.row}>
            {last ? (
              <span className={styles.crumbCurrent} aria-current="page">
                <IxTypography format="body-sm" bold>
                  {p.name}
                </IxTypography>
              </span>
            ) : (
              <button type="button" className={styles.crumbButton} onClick={() => onNavigate(p.assetId)}>
                {p.name}
              </button>
            )}
            {!last ? (
              <IxTypography format="body-sm" textColor="soft" aria-hidden="true">
                ›
              </IxTypography>
            ) : null}
          </span>
        );
      })}
    </nav>
  );
}

export function AssetsTab({ catalog }: { catalog: Catalog }) {
  const id = catalog.connectionId;
  const root = useLoader(
    () => fetchWithEtag<AmAssetResource>(defaultTransport, id, amPath.rootAsset()).then((r) => r.resource),
    `root:${id}`,
  );
  const [parent, setParent] = useState<AmAssetResource | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<AmAssetResource[]>([]);
  const [detailNonce, setDetailNonce] = useState(0);
  // tenant-wide server search
  const [qName, setQName] = useState("");
  const [qType, setQType] = useState("");
  const [query, setQuery] = useState<string | undefined>();

  useEffect(() => {
    if (root.data && !parent) {
      setParent(root.data);
      setActiveId(root.data.assetId);
    }
  }, [root.data, parent]);

  const level = useTenantList<AmAssetResource>(id, { resource: "assets", filter: parent ? assetFilters.children(parent.assetId) : undefined }, !!parent);
  const found = useTenantList<AmAssetResource>(id, { resource: "assets", filter: query, maxItems: 500 }, !!query);
  const all = itemsOf(level);
  const rows = useMemo(() => all.filter((a) => matchesSearch(search, a.name, a.typeId, a.externalId, a.description)), [all, search]);
  const typeName = useCallback(
    (typeId: string) => itemsOf(catalog.assetTypes).find((t) => t.id === typeId)?.name ?? typeId,
    [catalog.assetTypes],
  );

  const navigate = useCallback(
    async (assetId: string, select?: string) => {
      try {
        const a = assetId === parent?.assetId ? parent : (await fetchAsset(id, assetId)).resource;
        setParent(a);
        setActiveId(select ?? a.assetId);
        setSelected([]);
        setSearch("");
      } catch (e) {
        notifyFailure(e, "Asset could not be opened");
      }
    },
    [id, parent],
  );

  const open = useCallback((a: AmAssetResource) => void navigate(a.assetId), [navigate]);
  const columns = useMemo<ColDef<AmAssetResource>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 2, minWidth: 160 },
      { headerName: "Type", flex: 2, minWidth: 150, valueGetter: (p) => (p.data ? typeName(p.data.typeId) : "") },
      { field: "externalId", headerName: "External id", flex: 1, minWidth: 120 },
      { field: "twinType", headerName: "Twin", width: 120 },
      { headerName: "Children", width: 200, cellRenderer: OpenCell, sortable: false },
    ],
    [typeName],
  );

  const refresh = () => {
    level.reload();
    setDetailNonce((n) => n + 1);
    if (query) found.reload();
  };

  async function batchDelete() {
    const targets = selected;
    let children: Map<string, AssetChildInfo>;
    try {
      const counts = await mapWithConcurrency(targets, 4, (a) => countAssets(defaultTransport, id, assetFilters.children(a.assetId), 1));
      children = new Map(targets.map((a, i) => [a.assetId, { childCount: counts[i]!.total }]));
    } catch (e) {
      notifyFailure(e, "Children could not be counted");
      return;
    }
    await openBatchDialog({
      connectionId: id,
      title: "Batch delete assets",
      auditAction: "batch.delete-assets",
      items: planDeleteAssets(targets, children),
      danger: true,
      intro: "Assets with children are blocked. Values and file assignments of deleted assets are lost.",
    });
    setSelected([]);
    refresh();
  }

  async function batchSetVariable() {
    const choice = await openSetVariableDialog(catalog, selected);
    if (!choice) return;
    await openBatchDialog({
      connectionId: id,
      title: "Batch set variable value",
      auditAction: "batch.set-variable",
      items: planSetVariable(selected, choice.target, choice.value, choice.applicable),
      intro: "Each asset is patched (merge patch) with its complete variables / aspects array and its ETag from the list.",
    });
    setSelected([]);
    refresh();
  }

  async function batchMove() {
    const target = await openMoveTargetDialog(catalog, selected, root.data);
    if (!target) return;
    await openBatchDialog({
      connectionId: id,
      title: `Batch move assets below ${target.name}`,
      auditAction: "batch.move-assets",
      items: planMoveAssets(selected, target),
      intro: "Each asset moves with all of its children.",
    });
    setSelected([]);
    refresh();
  }

  const crumbs = parent ? assetBreadcrumb(parent) : [];
  const allTypes = itemsOf(catalog.assetTypes);

  return (
    <div className={styles.stack}>
      <form
        className={styles.toolbar}
        role="search"
        aria-label="Search assets in the tenant"
        onSubmit={(e) => {
          e.preventDefault();
          const f = buildFilter({ name: textCondition("contains", qName), hasType: qType || undefined });
          if (!f) notifyInfo("Enter a name or choose a type to search the tenant.");
          setQuery(f);
        }}
      >
        <div className={styles.toolbarSearch}>
          <IxInput className={styles.searchInput} label="Tenant search: name contains" value={qName} onValueChange={(e) => setQName(e.detail)}>
            <IxIcon slot="start" name={iconSearch} size="16" aria-hidden="true" />
          </IxInput>
          <IxSelect
            className={styles.selectInput}
            label="Type (incl. derived types)"
            value={qType}
            allowClear
            onValueChange={(e) => setQType(typeof e.detail === "string" ? e.detail : "")}
          >
            {allTypes.map((t) => (
              <IxSelectItem key={t.id} value={t.id} label={`${t.name} (${t.id})`} />
            ))}
          </IxSelect>
          <IxButton variant="secondary" type="submit" loading={found.loading}>
            Search tenant
          </IxButton>
          {query ? (
            <IxButton
              variant="subtle-tertiary"
              onClick={() => {
                setQuery(undefined);
                setQName("");
                setQType("");
              }}
            >
              Clear search
            </IxButton>
          ) : null}
        </div>
      </form>

      <ErrorBanner error={root.error} prefix="The root asset could not be loaded" />
      {query ? (
        <section className={styles.stack} aria-label="Tenant search results">
          <ErrorBanner error={found.error} prefix="Search failed" />
          <PartialFailureBanner result={found.data} what="search result" />
          <IxTypography format="body-sm" role="status">
            {found.loading ? "Searching…" : found.data ? `${found.data.items.length} of ${found.data.totalElements} matching assets (open one to jump to its level).` : ""}
          </IxTypography>
          {found.data?.items.length ? (
            <Grid
              label="Search results"
              size="short"
              rows={found.data.items}
              columns={[
                { field: "name", headerName: "Name", flex: 2, minWidth: 160 },
                { headerName: "Type", flex: 2, valueGetter: (p) => (p.data ? typeName(p.data.typeId) : "") },
                { headerName: "Path", flex: 3, valueGetter: (p) => p.data?.hierarchyPath?.map((x) => x.name).join(" › ") ?? "" },
              ]}
              rowId={(a) => a.assetId}
              onOpen={(a) => void navigate(a.parentId ?? a.assetId, a.assetId)}
            />
          ) : null}
        </section>
      ) : null}

      <div className={styles.toolbar}>
        <div className={styles.toolbarSearch}>
          {parent && parent.parentId ? (
            <IxButton variant="subtle-primary" icon={iconArrowUp} onClick={() => void navigate(parent.parentId!)}>
              Up one level
            </IxButton>
          ) : null}
          <Breadcrumbs path={crumbs} onNavigate={(aid) => void navigate(aid)} />
        </div>
        <div className={styles.toolbarActions}>
          <IxButton variant="secondary" icon={iconRefresh} loading={level.loading} onClick={refresh}>
            Refresh
          </IxButton>
          {parent ? (
            <IxButton
              variant="primary"
              icon={iconAdd}
              onClick={async () => {
                const created = await openAssetCreateDialog(catalog, parent);
                if (created) {
                  level.reload();
                  setActiveId(created.assetId);
                }
              }}
            >
              Create child of {parent.name}
            </IxButton>
          ) : null}
        </div>
      </div>

      <div className={styles.toolbar}>
        <search aria-label="Filter this level" className={styles.toolbarSearch}>
          <IxInput
            className={styles.searchInput}
            label="Search this level"
            placeholder="Name, type, external id…"
            value={search}
            onValueChange={(e) => setSearch(e.detail)}
          >
            <IxIcon slot="start" name={iconSearch} size="16" aria-hidden="true" />
          </IxInput>
        </search>
        <div className={styles.toolbarActions} role="group" aria-label="Batch operations on selected assets">
          <IxTypography format="body-sm" textColor="soft">
            {selected.length} selected
          </IxTypography>
          <IxButton variant="secondary" icon={iconPen} disabled={!selected.length} onClick={() => void batchSetVariable()}>
            Set value
          </IxButton>
          <IxButton variant="secondary" icon={iconMove} disabled={!selected.length} onClick={() => void batchMove()}>
            Move selected
          </IxButton>
          <IxButton variant="danger-secondary" icon={iconTrashcan} disabled={!selected.length} onClick={() => void batchDelete()}>
            Delete selected
          </IxButton>
        </div>
      </div>

      <ErrorBanner error={level.error} prefix="This level could not be loaded" />
      <PartialFailureBanner result={level.data} what="asset" />
      <div role="status" className={styles.srOnly}>
        {level.loading ? "" : `${rows.length} of ${all.length} child assets shown.`}
      </div>

      <div className={styles.split}>
        <div className={styles.stack}>
          {(root.loading || level.loading) && !level.data ? <Loading label="Loading assets…" /> : null}
          {level.data && rows.length === 0 ? (
            <IxEmptyState
              icon={iconHierarchy}
              header={all.length ? "No matching assets on this level" : `${parent?.name ?? "This asset"} has no children`}
              subHeader={all.length ? "Change the search." : "Create a child asset or go up one level."}
              action={all.length ? "Clear search" : "Create child asset"}
              onActionClick={async () => {
                if (all.length) setSearch("");
                else if (parent) {
                  const created = await openAssetCreateDialog(catalog, parent);
                  if (created) level.reload();
                }
              }}
            />
          ) : null}
          {rows.length ? (
            <Grid
              label={`Children of ${parent?.name ?? ""}`}
              size="tall"
              rows={rows}
              columns={columns}
              rowId={(a) => a.assetId}
              multiSelect
              onSelectionChange={setSelected}
              onOpen={(a) => setActiveId(a.assetId)}
              context={{ open }}
            />
          ) : null}
        </div>
        {activeId ? (
          <AssetDetails
            key={activeId}
            catalog={catalog}
            assetId={activeId}
            nonce={detailNonce}
            isLevel={activeId === parent?.assetId}
            root={root.data}
            onOpen={(aid) => void navigate(aid)}
            onChanged={refresh}
            onDeleted={() => {
              setActiveId(parent?.assetId ?? null);
              refresh();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function AssetDetails({
  catalog,
  assetId,
  nonce,
  isLevel,
  root,
  onOpen,
  onChanged,
  onDeleted,
}: {
  catalog: Catalog;
  assetId: string;
  nonce: number;
  isLevel: boolean;
  root: AmAssetResource | null;
  onOpen: (assetId: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [localNonce, setLocalNonce] = useState(0);
  const loaded = useLoader(() => fetchAsset(catalog.connectionId, assetId).then((r) => r.resource), `asset:${assetId}:${nonce}:${localNonce}`);
  const a = loaded.data;
  const changed = () => {
    setLocalNonce((n) => n + 1);
    onChanged();
  };
  const fileName = (fid: string) => itemsOf(catalog.files).find((f) => f.id === fid)?.name ?? fid;
  const typeName = (tid: string) => itemsOf(catalog.assetTypes).find((t) => t.id === tid)?.name ?? tid;

  return (
    <IxCard variant="outline" className={styles.card} passive>
      <IxCardContent>
        <div className={styles.cardBody}>
          {loaded.loading && !a ? <Loading label="Loading the asset…" /> : null}
          <ErrorBanner error={loaded.error} prefix="The asset could not be loaded" />
          {a ? (
            <>
              <div className={styles.headerRow}>
                <div className={styles.headerText}>
                  <h2 className={`typography-h4 ${styles.heading}`}>{a.name}</h2>
                  <IxTypography format="code-sm" textColor="soft">
                    {a.assetId}
                  </IxTypography>
                </div>
                {!a.parentId ? (
                  <IxChip variant="neutral" inactive>
                    root asset
                  </IxChip>
                ) : null}
              </div>
              <nav aria-label="Path of the asset" className={styles.breadcrumbs}>
                {assetBreadcrumb(a).map((p, i, arr) => (
                  <IxTypography key={p.assetId} format="body-xs" textColor="soft">
                    {p.name}
                    {i < arr.length - 1 ? " ›" : ""}
                  </IxTypography>
                ))}
              </nav>
              <div className={styles.row}>
                {!isLevel ? (
                  <IxButton variant="secondary" icon={iconHierarchy} onClick={() => onOpen(a.assetId)}>
                    Open children
                  </IxButton>
                ) : null}
                <IxButton
                  variant="secondary"
                  icon={iconAdd}
                  onClick={async () => {
                    if (await openAssetCreateDialog(catalog, a)) changed();
                  }}
                >
                  Create child
                </IxButton>
                <IxButton
                  variant="secondary"
                  icon={iconPen}
                  onClick={async () => {
                    if (await openAssetEditDialog(catalog, a)) changed();
                  }}
                >
                  Edit values
                </IxButton>
                {a.parentId ? (
                  <>
                    <IxButton
                      variant="secondary"
                      icon={iconMove}
                      onClick={async () => {
                        const target = await openMoveTargetDialog(catalog, [a], root);
                        if (target && (await moveAsset(catalog, a, target))) changed();
                      }}
                    >
                      Move asset
                    </IxButton>
                    <IxButton
                      variant="danger-secondary"
                      icon={iconTrashcan}
                      onClick={async () => {
                        if (await deleteAsset(catalog, a)) onDeleted();
                      }}
                    >
                      Delete asset
                    </IxButton>
                  </>
                ) : null}
              </div>
              <KeyValueGrid
                items={[
                  { label: "Type", value: `${typeName(a.typeId)} (${a.typeId})` },
                  { label: "Parent", value: a.parentId ?? "— (root)" },
                  { label: "Time zone", value: a.timezone ?? "tenant default" },
                  { label: "Twin type", value: a.twinType ?? "performance" },
                  { label: "External id", value: a.externalId ?? "" },
                  { label: "ETag", value: String(a.etag) },
                  { label: "Description", value: a.description ?? "" },
                ]}
              />
              <div className={styles.headerRow}>
                <h3 className={`typography-h6 ${styles.heading}`}>Location</h3>
                <div className={styles.row}>
                  <IxButton
                    variant="subtle-primary"
                    icon={iconLocation}
                    onClick={async () => {
                      if (await openLocationDialog(catalog, a)) changed();
                    }}
                  >
                    {hasOwnLocation(a) ? "Edit location" : "Set location"}
                  </IxButton>
                  {hasOwnLocation(a) ? (
                    <IxButton
                      variant="subtle-tertiary"
                      icon={iconTrashcan}
                      onClick={async () => {
                        if (await removeLocation(catalog, a)) changed();
                      }}
                    >
                      Remove location
                    </IxButton>
                  ) : null}
                </div>
              </div>
              <IxTypography format="body-sm">
                {a.location
                  ? [a.location.streetAddress, a.location.postalCode, a.location.locality, a.location.region, a.location.country]
                      .filter(Boolean)
                      .join(", ") +
                    (a.location.latitude !== undefined && a.location.latitude !== null
                      ? ` (${a.location.latitude}, ${a.location.longitude})`
                      : "") +
                    (hasOwnLocation(a) ? "" : " — inherited from an ancestor")
                  : "No location."}
              </IxTypography>
              <h3 className={`typography-h6 ${styles.heading}`}>Variable values</h3>
              {a.variables.length ? (
                <ul className={styles.list}>
                  {a.variables.map((v) => (
                    <li key={v.name} className={styles.listItem}>
                      <IxTypography format="label-sm" textColor="soft">
                        {v.name}
                      </IxTypography>
                      <IxTypography format="body-sm">{v.value}</IxTypography>
                    </li>
                  ))}
                </ul>
              ) : (
                <IxTypography format="body-sm" textColor="soft">
                  No values set (type defaults apply).
                </IxTypography>
              )}
              {a.aspects.map((asp) => (
                <section key={asp.name} className={styles.tightStack} aria-label={`Aspect ${asp.name}`}>
                  <IxTypography format="label" bold>
                    Aspect {asp.name}
                  </IxTypography>
                  <ul className={styles.list}>
                    {asp.variables.map((v) => (
                      <li key={v.name} className={styles.listItem}>
                        <IxTypography format="label-sm" textColor="soft">
                          {v.name}
                        </IxTypography>
                        <IxTypography format="body-sm">{v.value}</IxTypography>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <div className={styles.headerRow}>
                <h3 className={`typography-h6 ${styles.heading}`}>File assignments</h3>
                <IxButton
                  variant="subtle-primary"
                  icon={iconAttach}
                  onClick={async () => {
                    if (await openAssetFileDialog(catalog, a)) changed();
                  }}
                >
                  Assign file
                </IxButton>
              </div>
              {a.fileAssignments.length ? (
                <ul className={styles.list}>
                  {a.fileAssignments.map((f) => (
                    <li key={f.key} className={styles.listItem}>
                      <IxTypography format="body-sm">{f.key}</IxTypography>
                      <IxTypography format="body-xs" textColor="soft">
                        {fileName(f.fileId)}
                        {f._links?.origin ? " · inherited from the type" : ""}
                      </IxTypography>
                      {!f._links?.origin ? (
                        <IxButton
                          variant="subtle-tertiary"
                          icon={iconTrashcan}
                          onClick={async () => {
                            if (await removeAssetFile(catalog, a, f.key)) changed();
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
            </>
          ) : null}
        </div>
      </IxCardContent>
    </IxCard>
  );
}
