// Detail editor of one aspect type: identity, category, description,
// variables (shared VariableTable), guardrails and "used by".

import { useNavigate } from "react-router";
import {
  IxButton,
  IxChip,
  IxInput,
  IxSelect,
  IxSelectItem,
  IxTextarea,
  IxTypography,
} from "@siemens/ix-react";
import { iconLock, iconOpenExternal, iconTrashcan } from "@siemens/ix-icons/icons";
import { IssueCounts, IssueList } from "@/components/IssueList";
import { notifyError } from "@/components/notify";
import type { AspectCategory, AspectTypeDef, Project } from "@/domain/model";
import { DomainError } from "@/domain/ops";
import { LIMITS, TECHNICAL_LIMITS } from "@/domain/rules";
import { MAX_ID_SUFFIX } from "@/domain/validator";
import { fieldIssues, fieldProps } from "@/features/types/fieldState";
import { originLabel } from "@/features/types/labels";
import { GuardrailMeters } from "@/features/types/GuardrailMeter";
import { DetailHeader, DetailSection } from "@/features/types/MasterDetail";
import { masterDetailStyles as md } from "@/features/types/styles";
import { VariableTable } from "@/features/types/VariableTable";
import { useEntityIssues, useModelIndex, useProject } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import { useSettingsStore } from "@/state/settingsStore";

function findAspectType(d: Project, uid: string): AspectTypeDef {
  const t = d.aspectTypes.find((x) => x.uid === uid);
  if (!t) throw new DomainError("Aspect type not found.");
  return t;
}

export function AspectTypeEditor({ type, onDelete }: { type: AspectTypeDef; onDelete: () => void }) {
  const project = useProject();
  const index = useModelIndex();
  const navigate = useNavigate();
  const apply = useProjectStore((s) => s.apply);
  const guardrails = useSettingsStore((s) => s.guardrails);
  const issues = useEntityIssues(type.uid);
  const ownIssues = issues.filter((i) => !i.target.memberUid);
  const locked = !!type.baseline;
  const usage = index.aspectTypeUsage(type.uid);
  const inheritedBy = new Set(usage.flatMap((u) => index.descendantTypesOf(u.assetType.uid).map((d) => d.uid)));
  for (const u of usage) inheritedBy.delete(u.assetType.uid);
  const origin = originLabel(type.origin);

  const patch = (field: string, label: string, mutate: (t: AspectTypeDef) => void) => {
    try {
      apply(label, (d) => mutate(findAspectType(d, type.uid)), { coalesceKey: `${type.uid}:${field}` });
    } catch (e) {
      notifyError(e);
    }
  };

  const setText = (field: "name" | "idSuffix" | "description" | "notes", value: string, label: string) => {
    const current = type[field] ?? "";
    if (current === value) return;
    patch(field, label, (t) => {
      if ((field === "description" || field === "notes") && value === "") delete t[field];
      else t[field] = value;
    });
  };

  const fieldMessages = (field: string) => fieldProps(fieldIssues(ownIssues, field));

  return (
    <>
      <DetailHeader
        title={type.name || "(unnamed aspect type)"}
        subtitle={`{tenant}.${type.idSuffix || "…"} · ${type.category} · ${type.variables.length} variable${type.variables.length === 1 ? "" : "s"}`}
        badges={
          <>
            <IssueCounts issues={issues} />
            <IxChip variant={type.category === "dynamic" ? "info" : "neutral"} outline inactive>
              {type.category === "dynamic" ? "Dynamic (time series)" : "Static"}
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
          <IxButton variant="danger-secondary" icon={iconTrashcan} onClick={onDelete}>
            Delete aspect type
          </IxButton>
        }
      />

      {ownIssues.length ? (
        <DetailSection title="Validation" description="Issues of this aspect type (variable issues are shown next to each field).">
          <IssueList issues={ownIssues} />
        </DetailSection>
      ) : null}

      <DetailSection
        title="Definition"
        description={
          locked
            ? "This aspect type exists in a tenant: its id, name and category can no longer be changed (Asset Management API)."
            : "Id, name and category can no longer be changed once the aspect type is deployed."
        }
      >
        <div className={md.fields}>
          <IxInput
            label="Name"
            value={type.name}
            required
            readonly={locked}
            maxLength={LIMITS.aspectTypeNameMax}
            helperText={locked ? "Locked: the name cannot be changed later." : "Letters, digits and _ only."}
            onValueChange={(e) => setText("name", e.detail, "Rename aspect type")}
            {...fieldMessages("name")}
          />
          <IxInput
            label="Type id suffix"
            value={type.idSuffix}
            required
            readonly={locked}
            maxLength={MAX_ID_SUFFIX}
            helperText={`Deployed as {tenant}.${type.idSuffix || "<id>"}${locked ? " — locked" : ""}`}
            onValueChange={(e) => setText("idSuffix", e.detail, "Change aspect type id")}
            {...fieldMessages("idSuffix")}
          />
          <IxSelect
            label="Category"
            value={type.category}
            disabled={locked}
            helperText={locked ? "Locked: the category cannot be changed later." : "Static: values stored on the asset. Dynamic: time series."}
            onValueChange={(e) => {
              const next = String(e.detail) as AspectCategory;
              if (next !== type.category) patch("category", `Change category to ${next}`, (t) => (t.category = next));
            }}
            {...fieldMessages("category")}
          >
            <IxSelectItem value="static" label="Static" />
            <IxSelectItem value="dynamic" label="Dynamic (time series)" />
          </IxSelect>
          <div className={md.fieldWide}>
            <IxTextarea textareaWidth="100%"
              label="Description"
              value={type.description ?? ""}
              maxLength={LIMITS.descriptionMax}
              textareaRows={2}
              resizeBehavior="vertical"
              helperText="Up to 255 characters, no single quotes."
              onValueChange={(e) => setText("description", e.detail, "Edit aspect type description")}
              {...fieldMessages("description")}
            />
          </div>
          <div className={md.fieldWide}>
            <IxTextarea textareaWidth="100%"
              label="Design notes (not deployed)"
              value={type.notes ?? ""}
              textareaRows={2}
              resizeBehavior="vertical"
              onValueChange={(e) => setText("notes", e.detail, "Edit aspect type notes")}
            />
          </div>
        </div>
      </DetailSection>

      <DetailSection
        title={`Variables (${type.variables.length})`}
        description={
          type.category === "dynamic"
            ? "Time series variables. BIG_STRING is allowed here; default values are not."
            : "Static variables; their default values apply to new assets."
        }
      >
        <GuardrailMeters
          profile={guardrails.profile}
          limits={[
            { label: "Variables", actual: type.variables.length, max: guardrails.recommended.maxVariablesPerAspectType, kind: "recommended" },
            { label: "Variables", actual: type.variables.length, max: TECHNICAL_LIMITS.maxVariablesPerAspectType, kind: "technical" },
          ]}
        />
        <VariableTable owner={{ kind: "aspectType", uid: type.uid, name: type.name }} variables={type.variables} category={type.category} />
      </DetailSection>

      <DetailSection
        title={`Used by (${usage.length})`}
        description={
          usage.length
            ? `Asset types that include this aspect type${inheritedBy.size ? `; ${inheritedBy.size} more type${inheritedBy.size === 1 ? "" : "s"} inherit it` : ""}.`
            : "No asset type uses this aspect type yet. Add it as an aspect on the Asset types page."
        }
      >
        {usage.length ? (
          <ul className={md.list}>
            {usage.map((u) => (
              <li key={`${u.assetType.uid}:${u.aspectName}`} className={md.inlineRow}>
                <IxButton
                  variant="tertiary"
                  icon={iconOpenExternal}
                  onClick={() => navigate(`/p/${project.id}/asset-types/${u.assetType.uid}`)}
                >
                  {u.assetType.name || u.assetType.idSuffix}
                </IxButton>
                <IxTypography format="body-sm" textColor="soft" className={md.text}>
                  as aspect “{u.aspectName}”
                </IxTypography>
              </li>
            ))}
          </ul>
        ) : null}
      </DetailSection>
    </>
  );
}
