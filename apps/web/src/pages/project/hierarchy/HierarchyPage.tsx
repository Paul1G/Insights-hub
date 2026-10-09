// Hierarchy editor (/p/:projectId/hierarchy[/:uid]). The route's <h1> is
// rendered by the shared PageHeader.
//
// Left: a virtualised tree (10,000+ assets) with search, expand/collapse and
// drag & drop re-parenting. Right: the selected asset's detail editor. The
// selection lives in the URL.

import { useCallback, useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router";
import { IxButton, IxIcon, IxInput, IxTypography } from "@siemens/ix-react";
import { iconCollapseAll, iconExpandAll, iconSearch } from "@siemens/ix-icons/icons";
import { notifyError, notifyInfo } from "@/components/notify";
import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { ROOT_ASSET_UID } from "@/domain/model";
import { moveAsset } from "@/domain/ops";
import { useModelIndex, useProject, useValidation } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import { allParents, ancestorUids, buildTreeStructure, flattenTree, normalizeQuery, searchTree } from "@/features/hierarchy/tree";
import { useHierarchyUiStore } from "@/features/hierarchy/uiStore";
import { siblingNameSet } from "@/features/hierarchy/types";
import { AssetDetail } from "./AssetDetail";
import { HierarchyTree } from "./HierarchyTree";
import styles from "./HierarchyPage.module.css";
import { LinkedTenantBanner } from "@/features/catalog/LinkedTenantBanner";

export function HierarchyPage() {
  const project = useProject();
  const index = useModelIndex();
  const validation = useValidation();
  const navigate = useNavigate();
  const { uid: routeUid } = useParams();
  const selectedUid = routeUid && index.assets.has(routeUid) ? routeUid : ROOT_ASSET_UID;
  const missing = !!routeUid && !index.assets.has(routeUid);

  const ui = useHierarchyUiStore((s) => s.byProject[project.id]);
  const { toggle, expandMany, setExpanded, setQuery } = useHierarchyUiStore.getState();
  const expanded = useMemo(() => ui?.expanded ?? new Set([ROOT_ASSET_UID]), [ui?.expanded]);
  const query = ui?.query ?? "";
  const searchCollapsed = ui?.searchCollapsed;
  const searching = normalizeQuery(query) !== "";

  const structure = useMemo(() => buildTreeStructure(index), [index]);
  const search = useMemo(() => searchTree(index, query), [index, query]);

  const rows = useMemo(() => {
    if (searching) {
      return flattenTree(structure, {
        visible: search.visible,
        isExpanded: (u) => search.ancestors.has(u) && !searchCollapsed?.has(u),
      });
    }
    return flattenTree(structure, { isExpanded: (u) => expanded.has(u) });
  }, [structure, searching, search, searchCollapsed, expanded]);

  // Reveal the selected asset (e.g. deep link, breadcrumb, issue link).
  useEffect(() => {
    if (selectedUid !== ROOT_ASSET_UID) expandMany(project.id, ancestorUids(index, selectedUid));
  }, [selectedUid, index, project.id, expandMany]);

  const select = useCallback(
    (uid: string) => navigate(uid === ROOT_ASSET_UID ? `/p/${project.id}/hierarchy` : `/p/${project.id}/hierarchy/${uid}`),
    [navigate, project.id],
  );

  const onMove = useCallback(
    (uid: string, parentUid: string) => {
      const a = index.assets.get(uid);
      if (!a) return;
      const target = index.assets.get(parentUid);
      try {
        useProjectStore.getState().apply(`Move “${a.name}”`, (d) => moveAsset(d, index, uid, parentUid));
        expandMany(project.id, [parentUid]);
        if (siblingNameSet(index, parentUid).has(a.name.toLowerCase())) {
          notifyInfo(`Moved — note that “${target?.name ?? ""}” already has a child named “${a.name}”; sibling names must be unique.`);
        }
      } catch (e) {
        notifyError(e);
      }
    },
    [index, project.id, expandMany],
  );

  const assetCount = project.assets.length - 1;

  return (
    <Page>
      <PageHeader
        title="Hierarchy"
        subtitle={`${assetCount.toLocaleString()} asset${assetCount === 1 ? "" : "s"} below the tenant root · drag rows to re-parent, or use “Move to…”`}
      />
      <LinkedTenantBanner focus="assets" />
      <div className={styles.layout}>
        <section className={styles.treePane} aria-labelledby="hierarchy-tree-title">
          <h2 id="hierarchy-tree-title" className={`typography-h4 ${styles.heading}`}>
            Assets
          </h2>
          <div className={styles.toolbar}>
            <search aria-label="Search assets" className={styles.search}>
              <IxInput
                label="Search by name or external id"
                value={query}
                placeholder="Search assets…"
                onValueChange={(e) => setQuery(project.id, e.detail)}
              >
                <IxIcon slot="start" name={iconSearch} size="16" aria-hidden="true" />
              </IxInput>
            </search>
            <div className={styles.toolbarButtons}>
              <IxButton
                variant="subtle-secondary"
                icon={iconExpandAll}
                disabled={searching}
                onClick={() => setExpanded(project.id, allParents(structure))}
              >
                Expand all
              </IxButton>
              <IxButton
                variant="subtle-secondary"
                icon={iconCollapseAll}
                disabled={searching}
                onClick={() => setExpanded(project.id, new Set([ROOT_ASSET_UID]))}
              >
                Collapse all
              </IxButton>
            </div>
          </div>
          <IxTypography format="body-xs" textColor="soft" role="status">
            {searching
              ? `${search.matches.size.toLocaleString()} match${search.matches.size === 1 ? "" : "es"} for “${query.trim()}”`
              : `${rows.length.toLocaleString()} visible row${rows.length === 1 ? "" : "s"} · arrow keys to navigate, Enter to open`}
          </IxTypography>
          <HierarchyTree
            rows={rows}
            index={index}
            selectedUid={selectedUid}
            query={query}
            matches={search.matches}
            issuesByEntity={validation.byEntity}
            onToggle={(uid, open) => toggle(project.id, uid, searching, open)}
            onSelect={select}
            onMove={onMove}
          />
        </section>
        <section className={styles.detailPane} aria-label="Selected asset">
          {missing ? (
            <IxTypography format="body" textColor="soft">
              The requested asset does not exist in this project (it may have been deleted). Showing the tenant root.
            </IxTypography>
          ) : null}
          <AssetDetail
            uid={selectedUid}
            index={index}
            onSelect={select}
            onExpand={(uids) => expandMany(project.id, uids)}
            onOpenFiles={() => navigate(`/p/${project.id}/files`)}
          />
        </section>
      </div>
    </Page>
  );
}
