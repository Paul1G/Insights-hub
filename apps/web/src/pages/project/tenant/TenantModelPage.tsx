// Tenant model (route /p/:projectId/tenant; its <h1> is rendered by PageHeader):
// link the project to a tenant, read the tenant's existing aspect types,
// asset types and assets, see which of them the project already contains and
// import any selection as editable, deploy-ready definitions.

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router";
import {
  IxButton,
  IxCheckbox,
  IxMessageBar,
  IxTypography,
} from "@siemens/ix-react";
import { iconCloudDownload, iconImport } from "@siemens/ix-icons/icons";
import { correspondence, selectEverything } from "@/catalog/importToProject";
import { Page, Section } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { mappingId } from "@/deploy/mapping";
import {
  CatalogBrowser,
  EMPTY_SELECTION,
  type CatalogSelection,
} from "@/features/catalog/CatalogBrowser";
import { CatalogSource } from "@/features/catalog/CatalogSource";
import { importWithPreview } from "@/features/catalog/importFlow";
import { ConnectionPicker } from "@/pages/project/deploy/components/ConnectionPicker";
import { useConnections } from "@/pages/project/deploy/components/useConnections";
import { db } from "@/storage/db";
import { useCatalogStore, useLinkedCatalog } from "@/state/catalogStore";
import { useProject } from "@/state/hooks";
import { useSettingsStore } from "@/state/settingsStore";
import styles from "./TenantModelPage.module.css";

export function TenantModelPage() {
  const project = useProject();
  const navigate = useNavigate();
  const conns = useConnections();
  const core = useSettingsStore((s) => s.coreIndex);
  const { connectionId, catalog } = useLinkedCatalog(project.id);
  const connection = conns.connections.find((c) => c.id === connectionId);
  const [selection, setSelection] = useState<CatalogSelection>(EMPTY_SELECTION);
  const [includeSubtrees, setIncludeSubtrees] = useState(true);
  const [includeAssetTypes, setIncludeAssetTypes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [browserKey, setBrowserKey] = useState(0);

  const mapping = useLiveQuery(
    () =>
      connectionId
        ? db.mappings.get(mappingId(project.id, connectionId))
        : undefined,
    [project.id, connectionId],
  );
  const match = useMemo(
    () =>
      catalog
        ? correspondence(project, catalog.record.snapshot, mapping)
        : undefined,
    [project, catalog, mapping],
  );
  const missing = useMemo(() => {
    if (!catalog || !match) return undefined;
    const s = catalog.record.snapshot;
    return {
      aspectTypes: s.aspectTypes.tenant.filter(
        (t) => !match.aspectTypes.has(t.id.toLowerCase()),
      ).length,
      assetTypes: s.assetTypes.tenant.filter(
        (t) => !match.assetTypes.has(t.id.toLowerCase()),
      ).length,
      assets: s.assets.filter((a) => !match.assets.has(a.assetId)).length,
    };
  }, [catalog, match]);

  const selected =
    selection.assetIds.length +
    selection.assetTypeIds.length +
    selection.aspectTypeIds.length;

  async function runImport(sel: CatalogSelection | "everything") {
    if (!catalog) return;
    setBusy(true);
    const full =
      sel === "everything"
        ? selectEverything(catalog.record.snapshot)
        : { ...sel, includeSubtrees, includeAssetTypes };
    const done = await importWithPreview(
      project.id,
      project.name,
      catalog.record,
      full,
    );
    setBusy(false);
    if (done) {
      setSelection(EMPTY_SELECTION);
      setBrowserKey((k) => k + 1);
    }
  }

  return (
    <Page>
      <PageHeader
        title="Tenant model"
        subtitle="The existing aspect types, asset types and assets of the tenant this project is linked to."
      />

      <Section title="Linked tenant">
        <IxTypography format="body-sm" textColor="soft" className={styles.text}>
          Linking makes the tenant's existing types available everywhere in this
          project — as parents of asset types, as aspects and as types of new
          assets — and validates and estimates them with their real definitions,
          without copying them. Import existing objects below to edit them in
          the project.
        </IxTypography>
        <ConnectionPicker
          label="Tenant connection"
          state={conns}
          value={connectionId}
          onChange={(c) => {
            useCatalogStore.getState().link(project.id, c?.id ?? null);
            setSelection(EMPTY_SELECTION);
          }}
          helperText="Usually the tenant you deploy to."
        />
        {connectionId && !connection && !conns.loading && !conns.offline ? (
          <IxMessageBar type="warning" persistent>
            The linked connection no longer exists. Choose another connection.
          </IxMessageBar>
        ) : null}
        {connection ? <CatalogSource connection={connection} /> : null}
        {!connection && catalog ? (
          <IxTypography format="body-sm" textColor="soft">
            Showing the stored read from {catalog.record.connectionName} (
            {new Date(catalog.record.readAt).toLocaleString()}); the backend is
            needed to refresh it.
          </IxTypography>
        ) : null}
      </Section>

      {catalog && match && missing ? (
        <Section
          title="Existing objects"
          actions={
            <>
              <IxButton
                variant="secondary"
                icon={iconCloudDownload}
                disabled={
                  busy ||
                  missing.assetTypes + missing.aspectTypes + missing.assets ===
                    0
                }
                onClick={() => void runImport("everything")}
              >
                Import everything not in the project
              </IxButton>
              <IxButton
                variant="primary"
                icon={iconImport}
                disabled={busy || selected === 0}
                onClick={() => void runImport(selection)}
              >
                Import selected ({selected})
              </IxButton>
            </>
          }
        >
          <IxTypography
            format="body-sm"
            textColor="soft"
            className={styles.text}
          >
            Not in the project yet: {missing.assetTypes} asset type(s),{" "}
            {missing.aspectTypes} aspect type(s),{" "}
            {missing.assets.toLocaleString()} asset(s). Imports bring their
            dependencies along (parent types, aspect types, parent assets) and
            keep the tenant ids, so a deployment updates them instead of
            creating copies.
          </IxTypography>
          <div className={styles.options}>
            <IxCheckbox
              label="Include the whole subtree of selected assets"
              checked={includeSubtrees}
              onCheckedChange={(e) => setIncludeSubtrees(e.detail)}
            />
            <IxCheckbox
              label="Also import the asset types of imported assets (otherwise they are used as existing types)"
              checked={includeAssetTypes}
              onCheckedChange={(e) => setIncludeAssetTypes(e.detail)}
            />
          </div>
          <CatalogBrowser
            key={browserKey}
            snapshot={catalog.record.snapshot}
            core={core}
            external={catalog.external}
            match={match}
            selectable
            selection={selection}
            onSelectionChange={setSelection}
          />
          <div className={styles.footer}>
            <IxButton
              variant="tertiary"
              onClick={() => navigate(`/p/${project.id}/hierarchy`)}
            >
              Open hierarchy
            </IxButton>
            <IxButton
              variant="tertiary"
              onClick={() => navigate(`/p/${project.id}/asset-types`)}
            >
              Open asset types
            </IxButton>
          </div>
        </Section>
      ) : null}
    </Page>
  );
}
