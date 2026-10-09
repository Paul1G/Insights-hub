// Library tab "Tenant types": every existing aspect type, asset type and asset
// of a tenant (not only the core ones), read through a connection and kept as
// a local catalog. Selected objects can be imported into any project.

import { useState } from "react";
import { useNavigate } from "react-router";
import { IxButton, IxCheckbox, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { iconImport } from "@siemens/ix-icons/icons";
import { confirmDialog } from "@/components/dialogs";
import { notifyInfo } from "@/components/notify";
import { CatalogBrowser, EMPTY_SELECTION, type CatalogSelection } from "@/features/catalog/CatalogBrowser";
import { CatalogSource } from "@/features/catalog/CatalogSource";
import { importWithPreview } from "@/features/catalog/importFlow";
import { formDialog } from "@/features/types/formDialog";
import { ConnectionPicker } from "@/pages/project/deploy/components/ConnectionPicker";
import { useConnections } from "@/pages/project/deploy/components/useConnections";
import { listProjects } from "@/storage/repository";
import { useCatalogStore } from "@/state/catalogStore";
import { useSettingsStore } from "@/state/settingsStore";
import styles from "./Library.module.css";

const LAST_CONNECTION_KEY = "ams.library.connection";

export function TenantTypesTab() {
  const conns = useConnections();
  const navigate = useNavigate();
  const core = useSettingsStore((s) => s.coreIndex);
  const [connectionId, setConnectionId] = useState<string | undefined>(() => localStorage.getItem(LAST_CONNECTION_KEY) ?? undefined);
  const catalog = useCatalogStore((s) => (connectionId ? s.catalogs[connectionId] : undefined));
  const [selection, setSelection] = useState<CatalogSelection>(EMPTY_SELECTION);
  const [browserKey, setBrowserKey] = useState(0);
  const connection = conns.connections.find((c) => c.id === connectionId);

  if (connectionId && !catalog) void useCatalogStore.getState().ensure(connectionId);

  const selected = selection.assetIds.length + selection.assetTypeIds.length + selection.aspectTypeIds.length;

  async function importSelected() {
    if (!catalog) return;
    const projects = await listProjects();
    if (projects.length === 0) {
      notifyInfo("Create a project first, then import existing objects into it.");
      return;
    }
    const choice = await formDialog({
      title: "Import into project",
      initial: { projectId: projects[0]!.id, subtrees: true, types: true, link: true },
      confirmLabel: "Preview import",
      render: (v, patch) => (
        <div className={styles.tab}>
          <IxSelect label="Project" value={v.projectId} onValueChange={(e) => patch({ projectId: String(e.detail) })}>
            {projects.map((p) => (
              <IxSelectItem key={p.id} value={p.id} label={p.name} />
            ))}
          </IxSelect>
          <IxCheckbox label="Include the whole subtree of selected assets" checked={v.subtrees} onCheckedChange={(e) => patch({ subtrees: e.detail })} />
          <IxCheckbox label="Also import the asset types of imported assets" checked={v.types} onCheckedChange={(e) => patch({ types: e.detail })} />
          <IxCheckbox label="Link the project to this tenant" checked={v.link} onCheckedChange={(e) => patch({ link: e.detail })} />
        </div>
      ),
    });
    if (!choice) return;
    const project = projects.find((p) => p.id === choice.projectId)!;
    const done = await importWithPreview(project.id, project.name, catalog.record, {
      ...selection,
      includeSubtrees: choice.subtrees,
      includeAssetTypes: choice.types,
    });
    if (!done) return;
    if (choice.link) useCatalogStore.getState().link(project.id, catalog.record.connectionId);
    setSelection(EMPTY_SELECTION);
    setBrowserKey((k) => k + 1);
    const open = await confirmDialog({
      title: "Import completed",
      message: `The objects were added to “${project.name}”.`,
      confirmLabel: "Open project",
      cancelLabel: "Stay here",
    });
    if (open) navigate(`/p/${project.id}/tenant`);
  }

  return (
    <div className={styles.tab}>
      <IxTypography format="body-sm" textColor="soft">
        Read a tenant to browse all of its existing types and assets — the tenant's own types, types shared with it and the core types —
        with their inherited variables, aspects and instance counts. The read is stored in this browser and stays available offline.
      </IxTypography>
      <ConnectionPicker
        label="Tenant connection"
        state={conns}
        value={connectionId}
        onChange={(c) => {
          setConnectionId(c?.id);
          setSelection(EMPTY_SELECTION);
          if (c) localStorage.setItem(LAST_CONNECTION_KEY, c.id);
          else localStorage.removeItem(LAST_CONNECTION_KEY);
        }}
      />
      {connection ? <CatalogSource connection={connection} /> : null}
      {catalog ? (
        <>
          <div>
            <IxButton variant="primary" icon={iconImport} disabled={selected === 0} onClick={() => void importSelected()}>
              Import selected into a project… ({selected})
            </IxButton>
          </div>
          <CatalogBrowser
            key={`${catalog.record.connectionId}:${browserKey}`}
            snapshot={catalog.record.snapshot}
            core={core}
            external={catalog.external}
            selectable
            selection={selection}
            onSelectionChange={setSelection}
          />
        </>
      ) : null}
    </div>
  );
}
