// Detail editor of one asset type: identity, parent (cycle-safe), instantiable,
// inheritance chain, own + inherited variables, aspects, file assignments,
// attribute estimate and guardrails.

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router";
import {
  IxButton,
  IxCheckbox,
  IxChip,
  IxIcon,
  IxInput,
  IxSelect,
  IxSelectItem,
  IxTextarea,
  IxTypography,
} from "@siemens/ix-react";
import { iconAdd, iconChevronRightSmall, iconLock, iconTrashcan } from "@siemens/ix-icons/icons";
import { confirmDialog } from "@/components/dialogs";
import { IssueCounts, IssueList } from "@/components/IssueList";
import { notifyError } from "@/components/notify";
import { typeRefKey, type AssetTypeDef, type Project, type TypeRef } from "@/domain/model";
import { DomainError } from "@/domain/ops";
import { LIMITS } from "@/domain/rules";
import { MAX_ID_SUFFIX } from "@/domain/validator";
import { db } from "@/storage/db";
import { currentIndex } from "@/features/types/currentIndex";
import { fieldIssues, fieldProps } from "@/features/types/fieldState";
import { originLabel } from "@/features/types/labels";
import { DetailHeader, DetailSection } from "@/features/types/MasterDetail";
import { masterDetailStyles as md } from "@/features/types/styles";
import { parentOptions, wouldCreateCycle } from "@/features/types/parentOptions";
import { ReadonlyVariables } from "@/features/types/ReadonlyVariables";
import { VariableTable } from "@/features/types/VariableTable";
import { useEntityIssues, useModelIndex, useProject } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import { AspectsSection } from "./AspectsSection";
import { EstimatePanel } from "./EstimatePanel";
import { FileAssignmentsSection } from "./FileAssignmentsSection";
import styles from "./AssetTypes.module.css";

function findType(d: Project, uid: string): AssetTypeDef {
  const t = d.assetTypes.find((x) => x.uid === uid);
  if (!t) throw new DomainError("Asset type not found.");
  return t;
}

/** uids recorded in any deployment mapping of the project (deployed entities, variables and aspects). */
function useDeployedUids(projectId: string): Set<string> {
  const keys = useLiveQuery(
    async () => {
      const records = await db.mappings.where("projectId").equals(projectId).toArray();
      return records.flatMap((r) => Object.keys(r.entries));
    },
    [projectId],
    [] as string[],
  );
  return useMemo(() => new Set(keys), [keys]);
}

function InheritanceChain({ chain, projectId }: { chain: TypeRef[]; projectId: string }) {
  const index = useModelIndex();
  const navigate = useNavigate();
  const rootFirst = [...chain].reverse();
  return (
    <nav aria-label="Inheritance chain">
      <ol className={styles.chain}>
        {rootFirst.map((ref, i) => {
          const name = index.assetTypeName(ref);
          const last = i === rootFirst.length - 1;
          return (
            <li key={typeRefKey(ref)} className={styles.chainItem}>
              {i > 0 ? <IxIcon name={iconChevronRightSmall} size="16" aria-hidden="true" /> : null}
              {ref.kind === "project" && !last ? (
                <IxButton variant="tertiary" onClick={() => navigate(`/p/${projectId}/asset-types/${ref.uid}`)}>
                  {name}
                </IxButton>
              ) : (
                <IxTypography format={last ? "label" : "body-sm"} textColor={ref.kind === "project" ? undefined : "soft"} aria-current={last ? "true" : "false"}>
                  {name}
                  {ref.kind === "core" ? " (core)" : ref.kind === "external" ? " (external)" : ""}
                </IxTypography>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function AssetTypeEditor({
  type,
  onDelete,
  onCreateSubtype,
}: {
  type: AssetTypeDef;
  onDelete: () => void;
  onCreateSubtype: () => void;
}) {
  const project = useProject();
  const index = useModelIndex();
  const apply = useProjectStore((s) => s.apply);
  const issues = useEntityIssues(type.uid);
  const ownIssues = issues.filter((i) => !i.target.memberUid);
  const deployedUids = useDeployedUids(project.id);
  const resolved = index.resolveAssetType({ kind: "project", uid: type.uid });
  const locked = !!type.baseline;
  const instantiableLocked = !!type.baseline?.instantiable && type.instantiable;
  const options = parentOptions(index, type.uid, type.parent);
  const origin = originLabel(type.origin);
  const descendants = index.descendantTypesOf(type.uid);
  const instances = index.assetsOfType({ kind: "project", uid: type.uid }, false).length;
  // Re-mounts the parent select when a change is cancelled, so it shows the stored parent again.
  const [parentSelectKey, setParentSelectKey] = useState(0);

  const patch = (field: string, label: string, mutate: (t: AssetTypeDef) => void) => {
    try {
      apply(label, (d) => mutate(findType(d, type.uid)), { coalesceKey: `${type.uid}:${field}` });
    } catch (e) {
      notifyError(e);
    }
  };

  const setText = (field: "name" | "idSuffix" | "description" | "notes", value: string, label: string) => {
    if ((type[field] ?? "") === value) return;
    patch(field, label, (t) => {
      if ((field === "description" || field === "notes") && value === "") delete t[field];
      else t[field] = value;
    });
  };

  const changeParent = async (key: string) => {
    const option = options.find((o) => o.key === key);
    if (!option || key === typeRefKey(type.parent)) return;
    const ix = currentIndex();
    if (wouldCreateCycle(ix, type.uid, option.ref)) {
      notifyError(new DomainError("That parent would create an inheritance cycle."));
      setParentSelectKey((k) => k + 1);
      return;
    }
    const affected = ix.descendantTypesOf(type.uid).length;
    const assets = ix.assetsOfType({ kind: "project", uid: type.uid }, true).length;
    if (affected || assets) {
      const ok = await confirmDialog({
        title: "Change the parent type?",
        message: `Inherited variables and aspects change for “${type.name}”, ${affected} descendant type${affected === 1 ? "" : "s"} and ${assets} asset${assets === 1 ? "" : "s"}. Values that assets set for variables or aspects that are no longer inherited are flagged by validation.`,
        confirmLabel: "Change parent",
      });
      if (!ok) {
        setParentSelectKey((k) => k + 1);
        return;
      }
    }
    patch("parent", `Change parent of ${type.name}`, (t) => (t.parent = option.ref));
  };

  const fieldMessages = (field: string) => fieldProps(fieldIssues(ownIssues, field));
  const parentName = index.assetTypeName(type.parent);
  const inheritedVariables = (resolved?.variables ?? [])
    .filter((v) => v.inherited)
    .map((v) => ({ ...v, origin: `${v.definedOnName}${v.definedOn.kind === "core" ? " (core, not billable)" : ""}` }));

  return (
    <>
      <DetailHeader
        title={type.name || "(unnamed asset type)"}
        subtitle={`{tenant}.${type.idSuffix || "…"} · extends ${parentName} · depth ${resolved?.depth ?? "?"} · ${instances} asset${instances === 1 ? "" : "s"}`}
        badges={
          <>
            <IssueCounts issues={issues} />
            <IxChip variant={type.instantiable ? "success" : "neutral"} outline inactive>
              {type.instantiable ? "Instantiable" : "Abstract"}
            </IxChip>
            {locked ? (
              <IxChip variant="neutral" outline icon={iconLock} inactive>
                Exists in tenant
              </IxChip>
            ) : null}
            {origin ? (
              <IxChip variant="neutral" outline inactive>
                {origin}
              </IxChip>
            ) : null}
          </>
        }
        actions={
          <>
            <IxButton variant="secondary" icon={iconAdd} onClick={onCreateSubtype}>
              New subtype
            </IxButton>
            <IxButton variant="danger-secondary" icon={iconTrashcan} onClick={onDelete}>
              Delete asset type
            </IxButton>
          </>
        }
      />

      {resolved ? <InheritanceChain chain={resolved.chain} projectId={project.id} /> : null}

      {ownIssues.length ? (
        <DetailSection title="Validation" description="Issues of this asset type (variable and aspect issues are shown next to each field).">
          <IssueList issues={ownIssues} />
        </DetailSection>
      ) : null}

      <DetailSection
        title="Definition"
        description={
          locked
            ? "This type exists in a tenant: its id and parent are fixed, and an instantiable type cannot become abstract. Name, description, variables and aspects stay editable."
            : "The id and the parent can no longer be changed once the type is deployed."
        }
      >
        <div className={md.fields}>
          <IxInput
            label="Name"
            value={type.name}
            required
            maxLength={LIMITS.typeNameMax}
            helperText="Letters, digits, _, . and spaces."
            onValueChange={(e) => setText("name", e.detail, "Rename asset type")}
            {...fieldMessages("name")}
          />
          <IxInput
            label="Type id suffix"
            value={type.idSuffix}
            required
            readonly={locked}
            maxLength={MAX_ID_SUFFIX}
            helperText={`Deployed as {tenant}.${type.idSuffix || "<id>"}${locked ? " — locked" : ""}`}
            onValueChange={(e) => setText("idSuffix", e.detail, "Change asset type id")}
            {...fieldMessages("idSuffix")}
          />
          <IxSelect
            key={parentSelectKey}
            label="Parent type"
            value={typeRefKey(type.parent)}
            disabled={locked}
            helperText={
              locked
                ? "Locked: the parent of a deployed type cannot be changed."
                : "core.basicasset passes on no billable attributes. Own types and descendants are excluded (no cycles)."
            }
            onValueChange={(e) => void changeParent(String(e.detail))}
            {...fieldMessages("parent")}
          >
            {options.map((o) => (
              <IxSelectItem key={o.key} value={o.key} label={o.label} />
            ))}
          </IxSelect>
          <div className={md.field}>
            <IxCheckbox
              label={instantiableLocked ? "Instantiable (cannot be switched off once deployed)" : "Instantiable (assets can be created from this type)"}
              checked={type.instantiable}
              disabled={instantiableLocked}
              onCheckedChange={(e) => {
                if (e.detail !== type.instantiable) patch("instantiable", e.detail ? "Make type instantiable" : "Make type abstract", (t) => (t.instantiable = e.detail));
              }}
            />
          </div>
          <div className={md.fieldWide}>
            <IxTextarea textareaWidth="100%"
              label="Description"
              value={type.description ?? ""}
              maxLength={LIMITS.descriptionMax}
              textareaRows={2}
              resizeBehavior="vertical"
              onValueChange={(e) => setText("description", e.detail, "Edit asset type description")}
              {...fieldMessages("description")}
            />
          </div>
          <div className={md.fieldWide}>
            <IxTextarea textareaWidth="100%"
              label="Design notes (not deployed)"
              value={type.notes ?? ""}
              textareaRows={2}
              resizeBehavior="vertical"
              onValueChange={(e) => setText("notes", e.detail, "Edit asset type notes")}
            />
          </div>
        </div>
        {descendants.length ? (
          <IxTypography format="body-sm" textColor="soft" className={md.text}>
            Descendant types: {descendants.map((d) => d.name).join(", ")}
          </IxTypography>
        ) : null}
      </DetailSection>

      <DetailSection
        title={`Own variables (${type.variables.length})`}
        description="Static variables of this type. Names must be unique in the whole type family (ancestors and descendants)."
      >
        <VariableTable owner={{ kind: "assetType", uid: type.uid, name: type.name }} variables={type.variables} />
      </DetailSection>

      {inheritedVariables.length ? (
        <DetailSection
          title={`Inherited variables (${inheritedVariables.length})`}
          description="Inherited variables cannot be modified on this type — edit the type that defines them."
          readOnly
        >
          <ReadonlyVariables caption="Inherited variables" variables={inheritedVariables} showOrigin />
        </DetailSection>
      ) : null}

      {resolved ? <AspectsSection type={type} resolved={resolved} deployedUids={deployedUids} /> : null}

      <FileAssignmentsSection type={type} />

      {resolved ? <EstimatePanel type={type} resolved={resolved} /> : null}
    </>
  );
}
