// Row editor for variable definitions (aspect type variables and direct asset
// type variables). Existing variables lock dataType / searchable /
// qualityCode unless "Delete and recreate" is chosen.

import { IxButton, IxCheckbox, IxInput, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { iconAdd, iconTrashcan, iconUndo } from "@siemens/ix-icons/icons";
import type { AmDataType } from "@/api/amTypes";
import {
  allowsBigString,
  allowsDefaultValue,
  allowsQualityCode,
  immutableChanged,
  newVariableDraft,
  VARIABLE_DATA_TYPES,
  type DraftIssue,
  type VariableDraft,
  type VariableOwner,
} from "@/online/variables";
import styles from "./explorer.module.css";

function issueText(issues: DraftIssue[], key: string, field: DraftIssue["field"], severity: DraftIssue["severity"]) {
  const msgs = issues.filter((i) => i.key === key && i.field === field && i.severity === severity).map((i) => i.message);
  return msgs.length ? msgs.join(" ") : undefined;
}

export function VariableDraftEditor({
  drafts,
  onChange,
  owner,
  issues,
  addLabel = "Add variable",
}: {
  drafts: VariableDraft[];
  onChange: (next: VariableDraft[]) => void;
  owner: VariableOwner;
  issues: DraftIssue[];
  addLabel?: string;
}) {
  const update = (key: string, patch: Partial<VariableDraft>) =>
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const remove = (d: VariableDraft) =>
    d.original ? update(d.key, { deleted: !d.deleted }) : onChange(drafts.filter((x) => x.key !== d.key));
  const types = VARIABLE_DATA_TYPES.filter((t) => t !== "BIG_STRING" || allowsBigString(owner));
  const withDefault = allowsDefaultValue(owner);
  const withQuality = allowsQualityCode(owner);

  return (
    <div className={styles.stack}>
      {drafts.length === 0 ? (
        <IxTypography format="body-sm" textColor="soft">
          No variables.
        </IxTypography>
      ) : null}
      {drafts.map((d, index) => {
        const locked = !!d.original && !d.recreate;
        const err = (f: DraftIssue["field"]) => issueText(issues, d.key, f, "error");
        const warn = (f: DraftIssue["field"]) => issueText(issues, d.key, f, "warning");
        const rowLabel = d.name.trim() || `variable ${index + 1}`;
        return (
          <div
            key={d.key}
            className={`${styles.editorRow} ${d.deleted ? styles.deletedRow : ""}`}
            role="group"
            aria-label={`Variable ${rowLabel}`}
          >
            <IxInput
              label="Name"
              required
              value={d.name}
              disabled={d.deleted}
              maxLength={64}
              invalidText={err("name")}
              className={err("name") ? "ix-invalid" : undefined}
              onValueChange={(e) => update(d.key, { name: e.detail })}
            />
            <IxSelect
              label="Data type"
              value={d.dataType}
              disabled={d.deleted || locked}
              invalidText={err("dataType")}
              className={err("dataType") ? "ix-invalid" : undefined}
              onValueChange={(e) => {
                if (typeof e.detail === "string") update(d.key, { dataType: e.detail as AmDataType });
              }}
            >
              {types.map((t) => (
                <IxSelectItem key={t} value={t} label={t} />
              ))}
            </IxSelect>
            <IxInput
              label="Unit"
              value={d.unit}
              disabled={d.deleted}
              maxLength={32}
              invalidText={err("unit")}
              warningText={warn("unit")}
              className={err("unit") ? "ix-invalid" : warn("unit") ? "ix-warning" : undefined}
              onValueChange={(e) => update(d.key, { unit: e.detail })}
            />
            <IxInput
              label="Length"
              value={d.length}
              disabled={d.deleted || (d.dataType !== "STRING" && d.dataType !== "BIG_STRING")}
              helperText={d.original?.length ? `Currently ${d.original.length}; can only grow` : "STRING ≤ 255, BIG_STRING ≤ 100000"}
              invalidText={err("length")}
              warningText={warn("length")}
              className={err("length") ? "ix-invalid" : warn("length") ? "ix-warning" : undefined}
              onValueChange={(e) => update(d.key, { length: e.detail })}
            />
            {withDefault ? (
              <IxInput
                label="Default value"
                value={d.defaultValue}
                disabled={d.deleted}
                maxLength={255}
                invalidText={err("defaultValue")}
                className={err("defaultValue") ? "ix-invalid" : undefined}
                onValueChange={(e) => update(d.key, { defaultValue: e.detail })}
              />
            ) : null}
            <IxCheckbox
              label="Searchable"
              checked={d.searchable}
              disabled={d.deleted || locked}
              onCheckedChange={(e) => update(d.key, { searchable: e.detail })}
            />
            {withQuality ? (
              <IxCheckbox
                label="Quality code"
                checked={d.qualityCode}
                disabled={d.deleted || locked}
                onCheckedChange={(e) => update(d.key, { qualityCode: e.detail })}
              />
            ) : null}
            <div className={styles.editorRowWide}>
              <div className={styles.row}>
                {d.original ? (
                  <IxCheckbox
                    label="Delete and recreate (to change data type / searchable)"
                    checked={d.recreate}
                    disabled={d.deleted}
                    onCheckedChange={(e) => {
                      const recreate = e.detail;
                      const o = d.original!;
                      update(
                        d.key,
                        recreate
                          ? { recreate }
                          : {
                              recreate,
                              name: o.name,
                              dataType: o.dataType,
                              searchable: !!o.searchable,
                              qualityCode: !!o.qualityCode,
                            },
                      );
                    }}
                  />
                ) : (
                  <IxTypography format="body-xs" textColor="soft">
                    New variable
                  </IxTypography>
                )}
              </div>
              <IxButton
                variant="subtle-tertiary"
                icon={d.deleted ? iconUndo : iconTrashcan}
                onClick={() => remove(d)}
              >
                {d.deleted ? `Keep ${rowLabel}` : `Remove ${rowLabel}`}
              </IxButton>
            </div>
            {d.recreate && immutableChanged(d) ? (
              <div className={styles.full}>
                <IxTypography format="body-xs" textColor="soft">
                  The variable is deleted and created again: all values stored for it on assets are lost.
                </IxTypography>
              </div>
            ) : null}
            {err("dataType") && locked ? (
              <div className={styles.full}>
                <IxTypography format="body-xs" textColor="alarm">
                  {err("dataType")}
                </IxTypography>
              </div>
            ) : null}
          </div>
        );
      })}
      <div>
        <IxButton variant="secondary" icon={iconAdd} onClick={() => onChange([...drafts, newVariableDraft(owner)])}>
          {addLabel}
        </IxButton>
      </div>
    </div>
  );
}
