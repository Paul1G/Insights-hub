// Detail panel of the selected asset: breadcrumb path, structural actions
// (add child, bulk create, move, clone, delete) and the tabbed editor.

import { useMemo, useRef, useState } from "react";
import {
  IxBreadcrumb,
  IxBreadcrumbItem,
  IxButton,
  IxCard,
  IxCardContent,
  IxMessageBar,
  IxTabItem,
  IxTabs,
  IxTypography,
} from "@siemens/ix-react";
import { iconAdd, iconDocumentBulk, iconDuplicate, iconMove, iconTrashcan } from "@siemens/ix-icons/icons";
import { confirmDialog } from "@/components/dialogs";
import { IssueList } from "@/components/IssueList";
import { notifyError, notifySuccess } from "@/components/notify";
import { ROOT_ASSET_UID } from "@/domain/model";
import { cloneSubtree, deleteAssetSubtree } from "@/domain/ops";
import type { ModelIndex } from "@/domain/resolve";
import { useEntityIssues } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import { openAddChildDialog, openBulkDialog, openMoveDialog } from "./AssetDialogs";
import { AssetFiles } from "./AssetFiles";
import { AssetGeneral } from "./AssetGeneral";
import { AssetLocation } from "./AssetLocation";
import { AssetValues } from "./AssetValues";
import { useAssetEdit } from "./editAsset";
import styles from "./AssetDetail.module.css";

type TabKey = "general" | "location" | "values" | "files" | "issues";
const TABS: { key: TabKey; label: string }[] = [
  { key: "general", label: "General" },
  { key: "location", label: "Location" },
  { key: "values", label: "Values" },
  { key: "files", label: "Files" },
  { key: "issues", label: "Issues" },
];

export interface AssetDetailProps {
  uid: string;
  index: ModelIndex;
  onSelect(uid: string): void;
  onExpand(uids: string[]): void;
  onOpenFiles(): void;
}

export function AssetDetail({ uid, index, onSelect, onExpand, onOpenFiles }: AssetDetailProps) {
  const asset = index.assets.get(uid);
  const issues = useEntityIssues(uid);
  const edit = useAssetEdit(uid);
  const [tab, setTab] = useState<TabKey>("general");
  // Changelog labels use the name the asset had when it was selected, so
  // typing a new name coalesces into one entry.
  const nameAt = useRef<{ uid: string; name: string }>({ uid, name: asset?.name ?? "" });
  if (nameAt.current.uid !== uid) nameAt.current = { uid, name: asset?.name ?? "" };
  const labelName = nameAt.current.name;
  const resolved = useMemo(() => (asset ? index.resolveAssetType(asset.type) : undefined), [index, asset]);

  if (!asset) {
    return (
      <IxTypography format="body" textColor="soft">
        The asset no longer exists.
      </IxTypography>
    );
  }

  const isRoot = uid === ROOT_ASSET_UID;
  const path = index.hierarchyPath(uid);
  const descendants = index.descendantsOf(uid).length;
  const errorCount = issues.filter((i) => i.severity === "error").length;

  async function remove() {
    if (!asset) return;
    const total = descendants + 1;
    const ok = await confirmDialog({
      title: `Delete “${asset.name}”`,
      message:
        descendants > 0
          ? `This deletes “${asset.name}” and all ${descendants.toLocaleString()} descendant asset(s) — ${total.toLocaleString()} assets in total.`
          : `This deletes “${asset.name}”.`,
      confirmLabel: `Delete ${total.toLocaleString()} asset${total === 1 ? "" : "s"}`,
      danger: true,
      details: (
        <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
          Their values, locations and file assignments are removed from the project as well. The change can be undone (Ctrl+Z). Deployed
          assets are only deleted from a tenant by a sync deployment.
        </IxTypography>
      ),
    });
    if (!ok) return;
    const parent = asset.parentUid ?? ROOT_ASSET_UID;
    try {
      let removed = 0;
      useProjectStore.getState().apply(`Delete “${asset.name}” (${total} assets)`, (d) => {
        removed = deleteAssetSubtree(d, index, uid);
      });
      notifySuccess(`${removed.toLocaleString()} asset(s) deleted.`);
      onSelect(parent);
    } catch (e) {
      notifyError(e);
    }
  }

  function clone() {
    if (!asset) return;
    try {
      let created = "";
      useProjectStore.getState().apply(`Clone subtree “${asset.name}”`, (d) => {
        created = cloneSubtree(d, index, uid);
      });
      notifySuccess(`Cloned ${(descendants + 1).toLocaleString()} asset(s).`);
      onSelect(created);
    } catch (e) {
      notifyError(e);
    }
  }

  const tabCounter = (key: TabKey): number | undefined => (key === "issues" && issues.length ? issues.length : undefined);

  return (
    <IxCard variant="outline" className={styles.card}>
      <IxCardContent>
        <div className={styles.detail}>
          <IxBreadcrumb
            className={styles.breadcrumb}
            visibleItemCount={6}
            onItemClick={(e) => {
              const key = e.detail.breadcrumbKey;
              if (key && key !== uid) onSelect(key);
            }}
          >
            {path.map((a) => (
              <IxBreadcrumbItem key={a.uid} breadcrumbKey={a.uid} label={a.uid === ROOT_ASSET_UID ? "Tenant root" : a.name || "(unnamed)"} />
            ))}
          </IxBreadcrumb>

          <div className={styles.head}>
            <div className={styles.headText}>
              <h2 className={`typography-h3 ${styles.heading}`}>{isRoot ? "Tenant root" : asset.name || "(unnamed asset)"}</h2>
              <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
                {isRoot ? "core.basicenterprise · placeholder" : `${index.assetTypeName(asset.type)} · ${index.assetTypeDisplayId(asset.type)}`} · level{" "}
                {Number.isFinite(index.levelOf(uid)) ? index.levelOf(uid) : "—"} · {index.childrenOf(uid).length} child(ren),{" "}
                {descendants.toLocaleString()} descendant(s)
              </IxTypography>
            </div>
          </div>

          <div className={styles.actions} role="toolbar" aria-label="Asset actions">
            <IxButton
              variant="primary"
              icon={iconAdd}
              onClick={() =>
                openAddChildDialog(uid, (created) => {
                  onExpand([uid]);
                  onSelect(created);
                })
              }
            >
              Add child
            </IxButton>
            <IxButton variant="secondary" icon={iconDocumentBulk} onClick={() => openBulkDialog(uid, (parent) => onExpand([parent]))}>
              Bulk create
            </IxButton>
            {!isRoot ? (
              <>
                <IxButton
                  variant="secondary"
                  icon={iconMove}
                  onClick={() =>
                    openMoveDialog(uid, (moved, parent) => {
                      onExpand([parent]);
                      onSelect(moved);
                    })
                  }
                >
                  Move to…
                </IxButton>
                <IxButton variant="secondary" icon={iconDuplicate} onClick={clone}>
                  Clone subtree
                </IxButton>
                <IxButton variant="danger-secondary" icon={iconTrashcan} onClick={() => void remove()}>
                  Delete subtree
                </IxButton>
              </>
            ) : null}
          </div>

          {isRoot ? (
            <div className={styles.form}>
              <IxMessageBar persistent type="info">
                This placeholder stands for the target tenant&apos;s root asset (GET /assets/root). Deployments never create, change or
                delete it; add the top-level assets of your hierarchy below it. Root assets cannot be deleted independently of the tenant.
              </IxMessageBar>
              <IssueList issues={issues} empty="No issues." />
            </div>
          ) : (
            <>
              {errorCount ? (
                <IxMessageBar persistent type="alarm">
                  {errorCount} error(s) on this asset block deployment — see the Issues tab.
                </IxMessageBar>
              ) : null}
              <IxTabs activeTabKey={tab} onTabChange={(e) => setTab((TABS.find((t) => t.key === e.detail)?.key ?? "general") as TabKey)}>
                {TABS.map((t) => (
                  <IxTabItem key={t.key} tabKey={t.key} id={`asset-tab-${t.key}`} aria-controls={`asset-panel-${t.key}`} counter={tabCounter(t.key)}>
                    {t.label}
                  </IxTabItem>
                ))}
              </IxTabs>
              <div role="tabpanel" id={`asset-panel-${tab}`} aria-labelledby={`asset-tab-${tab}`} className={styles.panel}>
                {tab === "general" ? <AssetGeneral asset={asset} index={index} issues={issues} edit={edit} labelName={labelName} /> : null}
                {tab === "location" ? <AssetLocation asset={asset} issues={issues} edit={edit} labelName={labelName} /> : null}
                {tab === "values" ? (
                  <AssetValues asset={asset} resolved={resolved} index={index} issues={issues} edit={edit} labelName={labelName} />
                ) : null}
                {tab === "files" ? (
                  <AssetFiles
                    asset={asset}
                    resolved={resolved}
                    index={index}
                    issues={issues}
                    edit={edit}
                    labelName={labelName}
                    onOpenFiles={onOpenFiles}
                  />
                ) : null}
                {tab === "issues" ? <IssueList issues={issues} empty="No issues on this asset." /> : null}
              </div>
            </>
          )}
        </div>
      </IxCardContent>
    </IxCard>
  );
}
