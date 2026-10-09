// Asset types of the open project: inheritance tree + detail editor.
// The route's <h1> is rendered by the shared PageHeader.

import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { IxEmptyState, IxInput, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { iconAdd, iconObjectsTree } from "@siemens/ix-icons/icons";
import { confirmDialog } from "@/components/dialogs";
import { IssueCounts } from "@/components/IssueList";
import { notifyError, notifySuccess } from "@/components/notify";
import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { typeRefKey, type AssetTypeDef, type TypeRef } from "@/domain/model";
import { assetTypeDeletionImpact, deleteAssetType, newAssetType } from "@/domain/ops";
import type { ModelIndex } from "@/domain/resolve";
import { LIMITS, PATTERNS } from "@/domain/rules";
import { currentIndex } from "@/features/types/currentIndex";
import { formDialog } from "@/features/types/formDialog";
import { dialogStyles, masterDetailStyles as md } from "@/features/types/styles";
import { MasterDetail, MasterItem, MasterList } from "@/features/types/MasterDetail";
import { parentOptions, type ParentOption } from "@/features/types/parentOptions";
import { filterTreeRows, flattenForest, textMatch } from "@/features/types/typeTree";
import { useModelIndex, useProject, useValidation } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import { AssetTypeEditor } from "./AssetTypeEditor";
import { LinkedTenantBanner } from "@/features/catalog/LinkedTenantBanner";

type KindFilter = "all" | "instantiable" | "abstract";

function assetTypeNameError(name: string, existing: string[]): string | undefined {
  if (!name.trim()) return "Enter a name.";
  if (!PATTERNS.assetTypeName.test(name)) return "Use letters, digits, _, . and spaces only.";
  if (name.length > LIMITS.typeNameMax) return `At most ${LIMITS.typeNameMax} characters.`;
  if (existing.some((n) => n.toLowerCase() === name.toLowerCase())) return "An asset type with this name already exists (names are case-insensitive).";
  return undefined;
}

function parentHint(option: ParentOption | undefined): string {
  if (!option) return "";
  if (option.recommended) return "Recommended: core.basicasset passes on no billable attributes — add purpose-specific variables yourself.";
  const notes: string[] = [];
  if (option.group === "core") notes.push("Core parents pass on no billable attributes, but their variables and aspects are inherited.");
  if (option.group === "project") notes.push("Variables and aspects of project parents are inherited and counted as attributes.");
  if (option.group === "external")
    notes.push("Existing tenant type: it is not deployed by this project, its variables and aspects are inherited and counted as attributes.");
  if (option.deprecated) notes.push("This core type is marked deprecated in the documentation.");
  if (option.abstract) notes.push("Abstract types can be extended but not instantiated.");
  return notes.join(" ");
}

function rootLabel(index: ModelIndex, t: AssetTypeDef): string {
  const p = t.parent;
  if (p.kind === "project") return index.assetTypes.has(p.uid) ? "" : "missing parent";
  return `extends ${index.assetTypeName(p)}${p.kind === "core" ? " (core)" : " (external)"}`;
}

export function AssetTypesPage() {
  const project = useProject();
  const index = useModelIndex();
  const { byEntity } = useValidation();
  const apply = useProjectStore((s) => s.apply);
  const navigate = useNavigate();
  const { uid } = useParams();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const base = `/p/${project.id}/asset-types`;

  const rows = useMemo(
    () =>
      flattenForest(
        project.assetTypes,
        (t) => t.uid,
        (t) => (t.parent.kind === "project" ? t.parent.uid : undefined),
        (a, b) => a.name.localeCompare(b.name),
      ),
    [project.assetTypes],
  );
  const matches = (t: AssetTypeDef) =>
    (kind === "all" || (kind === "instantiable" ? t.instantiable : !t.instantiable)) && textMatch(query, t.name, t.idSuffix, t.description);
  const filtering = query.trim() !== "" || kind !== "all";
  const visible = filtering ? filterTreeRows(rows, matches) : rows;
  const matchCount = filtering ? visible.filter((r) => matches(r.item)).length : rows.length;
  const selected = uid ? index.assetTypes.get(uid) : undefined;

  async function create(initialParent?: TypeRef) {
    const ix = currentIndex();
    const options = parentOptions(ix);
    const existing = ix.project.assetTypes.map((t) => t.name);
    const initialKey = initialParent ? typeRefKey(initialParent) : options[0]!.key;
    const result = await formDialog<{ name: string; parentKey: string }>({
      title: initialParent ? `New subtype of ${ix.assetTypeName(initialParent)}` : "New asset type",
      initial: { name: "", parentKey: initialKey },
      confirmLabel: "Create asset type",
      size: "600",
      render: (v, patch) => {
        const error = v.name ? assetTypeNameError(v.name, existing) : undefined;
        const option = options.find((o) => o.key === v.parentKey);
        return (
          <>
            <IxInput
              label="Name"
              value={v.name}
              required
              helperText="Letters, digits, _, . and spaces. The type id is derived from the name and can be edited before deployment."
              invalidText={error}
              className={error ? "ix-invalid" : undefined}
              onValueChange={(e) => patch({ name: e.detail })}
            />
            <IxSelect label="Parent type" value={v.parentKey} onValueChange={(e) => patch({ parentKey: String(e.detail) })}>
              {options.map((o) => (
                <IxSelectItem key={o.key} value={o.key} label={o.label} />
              ))}
            </IxSelect>
            <IxTypography format="body-sm" textColor="soft" className={dialogStyles.text}>
              {parentHint(option)}
            </IxTypography>
            <IxTypography format="body-xs" textColor="soft" className={dialogStyles.text}>
              Root hierarchy types (core.roothierarchy and its descendants) are reserved for tenant roots and cannot be extended.
            </IxTypography>
          </>
        );
      },
      validate: (v) => assetTypeNameError(v.name, existing) ?? (options.some((o) => o.key === v.parentKey) ? undefined : "Choose a parent type."),
    });
    if (!result) return;
    const parent = options.find((o) => o.key === result.parentKey)!.ref;
    try {
      let createdUid = "";
      apply(`Create asset type ${result.name}`, (d) => {
        const t = newAssetType(d, result.name, parent);
        createdUid = t.uid;
        d.assetTypes.push(t);
      });
      navigate(`${base}/${createdUid}`);
    } catch (e) {
      notifyError(e);
    }
  }

  async function remove(typeUid: string) {
    const ix = currentIndex();
    const t = ix.assetTypes.get(typeUid);
    if (!t) return;
    const impact = assetTypeDeletionImpact(ix, typeUid);
    if (impact.blocked) {
      const firstChild = impact.childTypes[0];
      const firstAsset = impact.assets[0];
      const open = await confirmDialog({
        title: `“${t.name}” cannot be deleted yet`,
        message: "The Asset Management API only deletes asset types without child types and without assets. Re-parent or delete these first:",
        details: (
          <div className={dialogStyles.stack}>
            {impact.childTypes.length ? (
              <>
                <IxTypography format="label">Child types ({impact.childTypes.length})</IxTypography>
                <ul className={dialogStyles.list}>
                  {impact.childTypes.map((c) => (
                    <li key={c.uid}>
                      <IxTypography format="body-sm">{c.name}</IxTypography>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {impact.assets.length ? (
              <>
                <IxTypography format="label">Assets ({impact.assets.length})</IxTypography>
                <ul className={dialogStyles.list}>
                  {impact.assets.slice(0, 20).map((a) => (
                    <li key={a.uid}>
                      <IxTypography format="body-sm">{a.name}</IxTypography>
                    </li>
                  ))}
                  {impact.assets.length > 20 ? (
                    <li>
                      <IxTypography format="body-sm" textColor="soft">
                        and {impact.assets.length - 20} more
                      </IxTypography>
                    </li>
                  ) : null}
                </ul>
              </>
            ) : null}
          </div>
        ),
        confirmLabel: firstChild ? `Open ${firstChild.name}` : "Open in hierarchy",
      });
      if (!open) return;
      if (firstChild) navigate(`${base}/${firstChild.uid}`);
      else if (firstAsset) navigate(`/p/${project.id}/hierarchy/${firstAsset.uid}`);
      return;
    }
    const ok = await confirmDialog({
      title: `Delete asset type “${t.name}”?`,
      message: t.baseline
        ? "This asset type exists in a tenant. The next deployment deletes it there as well. You can undo the deletion in this project until then."
        : "The asset type with its variables, aspects and file assignments is removed from the project. You can undo this.",
      confirmLabel: "Delete asset type",
      danger: true,
    });
    if (!ok) return;
    try {
      apply(`Delete asset type ${t.name}`, (d) => deleteAssetType(d, currentIndex(), typeUid));
      notifySuccess(`Asset type “${t.name}” deleted.`);
      navigate(base);
    } catch (e) {
      notifyError(e);
    }
  }

  const master = (
    <MasterList
      title={`Asset types (${project.assetTypes.length})`}
      searchLabel="Search asset types"
      query={query}
      onQuery={setQuery}
      status={`${matchCount} of ${project.assetTypes.length} match`}
      filters={
        <IxSelect label="Show" value={kind} onValueChange={(e) => setKind(String(e.detail) as KindFilter)}>
          <IxSelectItem value="all" label="All types" />
          <IxSelectItem value="instantiable" label="Instantiable types" />
          <IxSelectItem value="abstract" label="Abstract types" />
        </IxSelect>
      }
    >
      {visible.map((r) => {
        const t = r.item;
        const resolved = index.resolveAssetType({ kind: "project", uid: t.uid });
        const assets = index.assetsOfType({ kind: "project", uid: t.uid }, false).length;
        const parentInfo = r.level === 0 ? rootLabel(index, t) : "";
        return (
          <MasterItem
            key={t.uid}
            level={r.level}
            selected={t.uid === uid}
            muted={filtering && !matches(t)}
            onSelect={() => navigate(`${base}/${t.uid}`)}
            primary={t.name || "(unnamed)"}
            secondary={[
              parentInfo,
              `depth ${resolved?.depth ?? "?"}`,
              t.instantiable ? "instantiable" : "abstract",
              `${assets} asset${assets === 1 ? "" : "s"}`,
            ]
              .filter(Boolean)
              .join(" · ")}
            trailing={<IssueCounts issues={byEntity.get(t.uid) ?? []} />}
          />
        );
      })}
    </MasterList>
  );

  let detail;
  if (selected) {
    detail = (
      <AssetTypeEditor
        key={selected.uid}
        type={selected}
        onDelete={() => void remove(selected.uid)}
        onCreateSubtype={() => void create({ kind: "project", uid: selected.uid })}
      />
    );
  } else if (uid) {
    detail = (
      <IxEmptyState
        header="Asset type not found"
        subHeader="It may have been deleted or undone."
        icon={iconObjectsTree}
        action="Back to the list"
        onActionClick={() => navigate(base)}
      />
    );
  } else {
    detail = (
      <div className={md.empty}>
        <IxEmptyState
          header={project.assetTypes.length ? "Select an asset type" : "No asset types yet"}
          subHeader={
            project.assetTypes.length
              ? "Choose a type from the inheritance tree to edit it, or create a new one."
              : "Asset types are templates for assets. Start from core.basicasset, which adds no billable attributes."
          }
          icon={iconAdd}
          action="Create asset type"
          onActionClick={() => void create()}
        />
      </div>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Asset types"
        subtitle="Templates for assets: static variables, aspects and file assignments, inherited along the parent chain."
        primaryAction={{ label: "New asset type", icon: iconAdd, onClick: () => void create() }}
      />
      <LinkedTenantBanner focus="assetTypes" />
      <MasterDetail master={master} detail={detail} />
    </Page>
  );
}
