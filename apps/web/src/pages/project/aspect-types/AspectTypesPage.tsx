// Aspect types of the open project: master list + detail editor.
// The route's <h1> is rendered by the shared PageHeader.

import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { IxChip, IxEmptyState, IxInput, IxRadio, IxRadioGroup, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { iconAdd, iconApps } from "@siemens/ix-icons/icons";
import { confirmDialog } from "@/components/dialogs";
import { IssueCounts } from "@/components/IssueList";
import { notifyError, notifySuccess } from "@/components/notify";
import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import type { AspectCategory } from "@/domain/model";
import { aspectTypeDeletionImpact, deleteAspectType, newAspectType } from "@/domain/ops";
import { LIMITS, PATTERNS } from "@/domain/rules";
import { currentIndex } from "@/features/types/currentIndex";
import { formDialog } from "@/features/types/formDialog";
import { dialogStyles, masterDetailStyles as md } from "@/features/types/styles";
import { MasterDetail, MasterItem, MasterList } from "@/features/types/MasterDetail";
import { textMatch } from "@/features/types/typeTree";
import { useModelIndex, useProject, useValidation } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import { AspectTypeEditor } from "./AspectTypeEditor";
import { LinkedTenantBanner } from "@/features/catalog/LinkedTenantBanner";

type CategoryFilter = "all" | AspectCategory;

function aspectTypeNameError(name: string, existing: string[]): string | undefined {
  if (!name.trim()) return "Enter a name.";
  if (!PATTERNS.aspectTypeName.test(name)) return "Use letters, digits and _ only.";
  if (name.length > LIMITS.aspectTypeNameMax) return `At most ${LIMITS.aspectTypeNameMax} characters.`;
  if (existing.some((n) => n.toLowerCase() === name.toLowerCase())) return "An aspect type with this name already exists (names are case-insensitive).";
  return undefined;
}

export function AspectTypesPage() {
  const project = useProject();
  const index = useModelIndex();
  const { byEntity } = useValidation();
  const apply = useProjectStore((s) => s.apply);
  const navigate = useNavigate();
  const { uid } = useParams();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const base = `/p/${project.id}/aspect-types`;

  const visible = useMemo(
    () =>
      [...project.aspectTypes]
        .sort((a, b) => a.name.localeCompare(b.name))
        .filter((t) => (category === "all" || t.category === category) && textMatch(query, t.name, t.idSuffix, t.description)),
    [project.aspectTypes, query, category],
  );
  const selected = uid ? index.aspectTypes.get(uid) : undefined;

  async function create() {
    const existing = project.aspectTypes.map((t) => t.name);
    const result = await formDialog<{ name: string; category: AspectCategory }>({
      title: "New aspect type",
      initial: { name: "", category: "dynamic" },
      confirmLabel: "Create aspect type",
      render: (v, patch) => {
        const error = v.name ? aspectTypeNameError(v.name, existing) : undefined;
        return (
          <>
            <IxInput
              label="Name"
              value={v.name}
              required
              helperText="Letters, digits and _. The name cannot be changed after deployment."
              invalidText={error}
              className={error ? "ix-invalid" : undefined}
              onValueChange={(e) => patch({ name: e.detail })}
            />
            <IxRadioGroup
              label="Category"
              value={v.category}
              helperText="Cannot be changed after deployment."
              onValueChange={(e) => patch({ category: e.detail as AspectCategory })}
            >
              <IxRadio label="Dynamic — time series data (e.g. sensor readings)" value="dynamic" checked={v.category === "dynamic"} />
              <IxRadio label="Static — values stored on each asset (e.g. nameplate data)" value="static" checked={v.category === "static"} />
            </IxRadioGroup>
            <IxTypography format="body-sm" textColor="soft" className={dialogStyles.text}>
              The new aspect type starts with one variable; edit it in the detail view.
            </IxTypography>
          </>
        );
      },
      validate: (v) => aspectTypeNameError(v.name, existing),
    });
    if (!result) return;
    try {
      let createdUid = "";
      apply(`Create aspect type ${result.name}`, (d) => {
        const t = newAspectType(d, result.name, result.category);
        createdUid = t.uid;
        d.aspectTypes.push(t);
      });
      navigate(`${base}/${createdUid}`);
    } catch (e) {
      notifyError(e);
    }
  }

  async function remove(typeUid: string) {
    const index = currentIndex();
    const t = index.aspectTypes.get(typeUid);
    if (!t) return;
    const impact = aspectTypeDeletionImpact(index, typeUid);
    if (impact.blocked) {
      const first = impact.usages[0]!.assetType;
      const open = await confirmDialog({
        title: `“${t.name}” is still in use`,
        message: "The Asset Management API only deletes aspect types that no asset type uses. Remove these aspects first:",
        details: (
          <ul className={dialogStyles.list}>
            {impact.usages.map((u) => (
              <li key={`${u.assetType.uid}:${u.aspectName}`}>
                <IxTypography format="body-sm">
                  {u.assetType.name} — aspect “{u.aspectName}”
                </IxTypography>
              </li>
            ))}
          </ul>
        ),
        confirmLabel: `Open ${first.name}`,
      });
      if (open) navigate(`/p/${project.id}/asset-types/${first.uid}`);
      return;
    }
    const ok = await confirmDialog({
      title: `Delete aspect type “${t.name}”?`,
      message: t.baseline
        ? "This aspect type exists in a tenant. The next deployment deletes it there as well. You can undo the deletion in this project until then."
        : "The aspect type and its variables are removed from the project. You can undo this.",
      confirmLabel: "Delete aspect type",
      danger: true,
    });
    if (!ok) return;
    try {
      apply(`Delete aspect type ${t.name}`, (d) => deleteAspectType(d, currentIndex(), typeUid));
      notifySuccess(`Aspect type “${t.name}” deleted.`);
      navigate(base);
    } catch (e) {
      notifyError(e);
    }
  }

  const master = (
    <MasterList
      title={`Aspect types (${project.aspectTypes.length})`}
      searchLabel="Search aspect types"
      query={query}
      onQuery={setQuery}
      status={`${visible.length} of ${project.aspectTypes.length} shown`}
      filters={
        <IxSelect label="Category" value={category} onValueChange={(e) => setCategory(String(e.detail) as CategoryFilter)}>
          <IxSelectItem value="all" label="All categories" />
          <IxSelectItem value="dynamic" label="Dynamic" />
          <IxSelectItem value="static" label="Static" />
        </IxSelect>
      }
    >
      {visible.map((t) => {
        const usedBy = index.aspectTypeUsage(t.uid).length;
        return (
          <MasterItem
            key={t.uid}
            selected={t.uid === uid}
            onSelect={() => navigate(`${base}/${t.uid}`)}
            primary={t.name || "(unnamed)"}
            secondary={`${t.category} · ${t.variables.length} var${t.variables.length === 1 ? "" : "s"} · used by ${usedBy}`}
            trailing={<IssueCounts issues={byEntity.get(t.uid) ?? []} />}
          />
        );
      })}
    </MasterList>
  );

  let detail;
  if (selected) {
    detail = <AspectTypeEditor key={selected.uid} type={selected} onDelete={() => void remove(selected.uid)} />;
  } else if (uid) {
    detail = (
      <IxEmptyState
        header="Aspect type not found"
        subHeader="It may have been deleted or undone."
        icon={iconApps}
        action="Back to the list"
        onActionClick={() => navigate(base)}
      />
    );
  } else {
    detail = (
      <div className={md.empty}>
        <IxEmptyState
          header={project.aspectTypes.length ? "Select an aspect type" : "No aspect types yet"}
          subHeader={
            project.aspectTypes.length
              ? "Choose an aspect type from the list to edit it, or create a new one."
              : "Aspect types group variables (time series or static) that asset types reuse as aspects."
          }
          icon={iconAdd}
          action="Create aspect type"
          onActionClick={() => void create()}
        />
      </div>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Aspect types"
        subtitle="Reusable groups of variables. Dynamic aspect types hold time series; static ones hold values stored on each asset."
        primaryAction={{ label: "New aspect type", icon: iconAdd, onClick: () => void create() }}
        meta={
          project.aspectTypes.some((t) => t.baseline) ? (
            <IxChip variant="neutral" outline inactive>
              {project.aspectTypes.filter((t) => t.baseline).length} exist in a tenant
            </IxChip>
          ) : undefined
        }
      />
      <LinkedTenantBanner focus="aspectTypes" />
      <MasterDetail master={master} detail={detail} />
    </Page>
  );
}
