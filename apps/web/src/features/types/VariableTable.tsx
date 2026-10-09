// Inline editor for the own variables of an aspect type or asset type.
//
// Shared by both type editors. Every field is validated inline through the
// validator (useEntityIssues). Edits go through the project store (undo/redo,
// autosave); renames propagate to asset values via the domain ops.
//
// Immutability (docs/reference: dataType and searchable cannot be updated,
// string length can only grow, dynamic STRING length is fixed): once a
// variable has a baseline these controls are locked and "Delete and
// recreate" replaces the variable (values stored on assets are lost).

import { useEffect, useState } from "react";
import {
  IxButton,
  IxCheckbox,
  IxChip,
  IxIconButton,
  IxInput,
  IxNumberInput,
  IxSelect,
  IxSelectItem,
  IxTypography,
} from "@siemens/ix-react";
import { iconAdd, iconArrowDown, iconArrowUp, iconLock, iconRefresh, iconTrashcan } from "@siemens/ix-icons/icons";
import { confirmDialog } from "@/components/dialogs";
import { notifyError, notifySuccess } from "@/components/notify";
import { DATA_TYPES, type AspectCategory, type DataType, type Project, type VariableDef } from "@/domain/model";
import {
  DomainError,
  aspectTypeVariableBlastRadius,
  assetTypeVariableBlastRadius,
  deleteAspectTypeVariable,
  deleteAssetTypeVariable,
  newVariable,
  recreateVariable,
  renameAspectTypeVariable,
  renameAssetTypeVariable,
  uniqueName,
  type BlastRadius,
} from "@/domain/ops";
import { DEFAULT_STRING_LENGTH, maxLengthFor, supportsLength } from "@/domain/rules";
import type { Issue } from "@/domain/validator";
import { useEntityIssues, useModelIndex } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import { BlastRadiusDetails } from "./BlastRadiusDetails";
import { currentIndex } from "./currentIndex";
import { fieldIssues, fieldProps } from "./fieldState";
import { formDialog } from "./formDialog";
import { dialogStyles } from "@/features/types/styles";
import styles from "./VariableTable.module.css";

export interface VariableOwner {
  kind: "aspectType" | "assetType";
  uid: string;
  name: string;
}

function variablesOf(d: Project, owner: VariableOwner): VariableDef[] {
  const list =
    owner.kind === "aspectType"
      ? d.aspectTypes.find((t) => t.uid === owner.uid)?.variables
      : d.assetTypes.find((t) => t.uid === owner.uid)?.variables;
  if (!list) throw new DomainError(owner.kind === "aspectType" ? "Aspect type not found." : "Asset type not found.");
  return list;
}

function blastRadius(owner: VariableOwner, name: string): BlastRadius {
  const index = currentIndex();
  return owner.kind === "aspectType"
    ? aspectTypeVariableBlastRadius(index, owner.uid, name)
    : assetTypeVariableBlastRadius(index, owner.uid, name);
}

function allowedDataTypes(owner: VariableOwner, category: AspectCategory | undefined, current: DataType): DataType[] {
  const bigStringAllowed = owner.kind === "aspectType" && category === "dynamic";
  return DATA_TYPES.filter((t) => t !== "BIG_STRING" || bigStringAllowed || current === "BIG_STRING");
}

function IssueNote({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <IxTypography format="body-xs" textColor={issues.some((i) => i.severity === "error") ? "alarm" : "soft"} className={styles.note}>
      {issues.map((i) => i.message).join(" ")}
    </IxTypography>
  );
}

interface RowProps {
  v: VariableDef;
  position: number;
  total: number;
  owner: VariableOwner;
  category?: AspectCategory;
  onRename: (v: VariableDef, name: string) => string | undefined;
  onPatch: (v: VariableDef, field: string, label: string, mutate: (draft: VariableDef) => void) => void;
  onMove: (v: VariableDef, delta: -1 | 1) => void;
  onDelete: (v: VariableDef) => void;
  onRecreate: (v: VariableDef) => void;
}

function VariableRow({ v, position, total, owner, category, onRename, onPatch, onMove, onDelete, onRecreate }: RowProps) {
  const issues = useEntityIssues(owner.uid, v.uid);
  const [draftName, setDraftName] = useState(v.name);
  const [nameError, setNameError] = useState<string | undefined>();
  useEffect(() => {
    setDraftName(v.name);
    setNameError(undefined);
  }, [v.name]);

  const locked = !!v.baseline;
  const isDynamicAspect = owner.kind === "aspectType" && category === "dynamic";
  const showDefault = owner.kind === "assetType" || category === "static" || v.defaultValue !== undefined;
  const showQualityCode = owner.kind === "aspectType" || !!v.qualityCode;
  const lengthLocked = isDynamicAspect && v.baseline?.length !== undefined;
  const minLength = v.baseline?.length ?? 1;
  const label = v.name || "(unnamed)";
  const rowIssues = issues.filter((i) => !i.target.field);

  const changeName = (name: string) => {
    setDraftName(name);
    if (name === v.name) {
      setNameError(undefined);
      return;
    }
    setNameError(onRename(v, name));
  };

  const changeText = (field: "unit" | "notes" | "defaultValue", text: string, labelText: string) => {
    const next = text === "" ? undefined : text;
    if ((v[field] ?? undefined) === next) return;
    onPatch(v, field, labelText, (d) => {
      if (next === undefined) delete d[field];
      else d[field] = next;
    });
  };

  const changeDataType = (dt: DataType) => {
    if (dt === v.dataType) return;
    onPatch(v, "dataType", `Change data type of ${label}`, (d) => {
      d.dataType = dt;
      if (dt === "STRING") {
        if (d.length === undefined || d.length > DEFAULT_STRING_LENGTH) d.length = DEFAULT_STRING_LENGTH;
      } else if (dt !== "BIG_STRING") {
        delete d.length;
      }
    });
  };

  const changeLength = (n: number | null | undefined) => {
    const next = typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : undefined;
    if (next === v.length) return;
    onPatch(v, "length", `Change length of ${label}`, (d) => {
      if (next === undefined) delete d.length;
      else d.length = next;
    });
  };

  const changeFlag = (field: "searchable" | "qualityCode", checked: boolean, labelText: string) => {
    if (!!v[field] === checked) return;
    onPatch(v, field, labelText, (d) => {
      if (field === "qualityCode" && !checked) delete d.qualityCode;
      else d[field] = checked;
    });
  };

  const lengthMax = maxLengthFor(v.dataType);
  const lengthHelper = lengthLocked
    ? `Locked: the length of a dynamic string variable cannot change (${v.baseline?.length}).`
    : v.baseline?.length !== undefined
      ? `Can only grow: ${minLength}–${lengthMax}.`
      : `1–${lengthMax}; empty uses the platform default.`;

  return (
    <li className={`${styles.row} ${locked ? styles.lockedRow : ""}`} aria-label={`Variable ${label}`}>
      <div className={styles.rowHead}>
        <span className={styles.rowTitle}>
          <IxTypography format="label-sm" textColor="soft">
            #{position + 1}
          </IxTypography>
          <IxTypography format="code" className={styles.text}>
            {label}
          </IxTypography>
          {locked ? (
            <IxChip variant="neutral" outline icon={iconLock} inactive>
              Exists in tenant
            </IxChip>
          ) : null}
        </span>
        <span className={styles.rowActions}>
          <IxIconButton
            icon={iconArrowUp}
            variant="subtle-tertiary"
            size="24"
            disabled={position === 0}
            aria-label={`Move ${label} up`}
            onClick={() => onMove(v, -1)}
          />
          <IxIconButton
            icon={iconArrowDown}
            variant="subtle-tertiary"
            size="24"
            disabled={position === total - 1}
            aria-label={`Move ${label} down`}
            onClick={() => onMove(v, 1)}
          />
          {locked ? (
            <IxButton variant="subtle-secondary" icon={iconRefresh} onClick={() => onRecreate(v)}>
              Delete and recreate
            </IxButton>
          ) : null}
          <IxIconButton
            icon={iconTrashcan}
            variant="danger-tertiary"
            size="24"
            aria-label={`Delete variable ${label}`}
            onClick={() => onDelete(v)}
          />
        </span>
      </div>

      <div className={styles.fields}>
        <IxInput
          label="Name"
          value={draftName}
          required
          maxLength={64}
          onValueChange={(e) => changeName(e.detail)}
          onIxBlur={() => {
            if (nameError) {
              setDraftName(v.name);
              setNameError(undefined);
            }
          }}
          {...fieldProps(fieldIssues(issues, "name"), nameError)}
        />
        <IxSelect
          label="Data type"
          value={v.dataType}
          disabled={locked}
          helperText={locked ? "Immutable once created in the tenant." : undefined}
          onValueChange={(e) => changeDataType(String(e.detail) as DataType)}
          {...fieldProps(fieldIssues(issues, "dataType"))}
        >
          {allowedDataTypes(owner, category, v.dataType).map((t) => (
            <IxSelectItem key={t} value={t} label={t} />
          ))}
        </IxSelect>
        <IxInput
          label="Unit"
          value={v.unit ?? ""}
          maxLength={32}
          onValueChange={(e) => changeText("unit", e.detail, `Change unit of ${label}`)}
          {...fieldProps(fieldIssues(issues, "unit"))}
        />
        {supportsLength(v.dataType) ? (
          <IxNumberInput
            label="Length"
            value={v.length}
            min={minLength}
            max={lengthMax}
            readonly={lengthLocked}
            helperText={lengthHelper}
            onValueChange={(e) => changeLength(e.detail)}
            {...fieldProps(fieldIssues(issues, "length"))}
          />
        ) : null}
        {showDefault ? (
          <IxInput
            label="Default value"
            value={v.defaultValue ?? ""}
            maxLength={255}
            helperText={isDynamicAspect ? "Dynamic aspect variables have no default values — clear this field." : "Applied to new assets of the type."}
            onValueChange={(e) => changeText("defaultValue", e.detail, `Change default value of ${label}`)}
            {...fieldProps(fieldIssues(issues, "defaultValue"))}
          />
        ) : null}
        <IxInput
          label="Design notes (not deployed)"
          value={v.notes ?? ""}
          onValueChange={(e) => changeText("notes", e.detail, `Edit notes of ${label}`)}
        />
        <div className={styles.flags}>
          <IxCheckbox
            label={locked ? "Searchable (immutable)" : "Searchable"}
            checked={v.searchable}
            disabled={locked}
            onCheckedChange={(e) => changeFlag("searchable", e.detail, `Change searchable of ${label}`)}
          />
          {showQualityCode ? (
            <IxCheckbox
              label="Quality code"
              checked={!!v.qualityCode}
              onCheckedChange={(e) => changeFlag("qualityCode", e.detail, `Change quality code of ${label}`)}
            />
          ) : null}
          <IssueNote issues={[...fieldIssues(issues, "searchable"), ...fieldIssues(issues, "qualityCode")]} />
        </div>
      </div>
      <IssueNote issues={rowIssues} />
    </li>
  );
}

function RecreateForm({
  value,
  patch,
  types,
  radius,
}: {
  value: { dataType: DataType; searchable: boolean; length?: number };
  patch: (p: Partial<{ dataType: DataType; searchable: boolean; length?: number }>) => void;
  types: DataType[];
  radius: BlastRadius;
}) {
  return (
    <>
      <IxTypography className={dialogStyles.text}>
        Data type and searchable cannot be changed once a variable exists in a tenant. The variable is replaced by a new
        one with the same name; on the next deployment the old variable is deleted and recreated, and every value stored
        for it is lost.
      </IxTypography>
      <IxSelect
        label="New data type"
        value={value.dataType}
        onValueChange={(e) => {
          const dt = String(e.detail) as DataType;
          patch({ dataType: dt, length: supportsLength(dt) ? (value.length ?? DEFAULT_STRING_LENGTH) : undefined });
        }}
      >
        {types.map((t) => (
          <IxSelectItem key={t} value={t} label={t} />
        ))}
      </IxSelect>
      {supportsLength(value.dataType) ? (
        <IxNumberInput
          label="Length"
          value={value.length}
          min={1}
          max={maxLengthFor(value.dataType)}
          onValueChange={(e) => patch({ length: Number.isFinite(e.detail) ? Math.trunc(e.detail) : undefined })}
        />
      ) : null}
      <IxCheckbox label="Searchable" checked={value.searchable} onCheckedChange={(e) => patch({ searchable: e.detail })} />
      <BlastRadiusDetails radius={radius} />
    </>
  );
}

export function VariableTable({
  owner,
  variables,
  category,
}: {
  owner: VariableOwner;
  variables: VariableDef[];
  /** Aspect type category (aspect types only). */
  category?: AspectCategory;
}) {
  const index = useModelIndex();
  const apply = useProjectStore((s) => s.apply);

  const takenNames = (): string[] => {
    if (owner.kind === "aspectType") return variables.map((v) => v.name);
    const resolved = index.resolveAssetType({ kind: "project", uid: owner.uid });
    return [
      ...(resolved?.variables.map((v) => v.name) ?? variables.map((v) => v.name)),
      ...index.descendantTypesOf(owner.uid).flatMap((t) => t.variables.map((v) => v.name)),
    ];
  };

  const onRename = (v: VariableDef, name: string): string | undefined => {
    try {
      apply(
        `Rename variable ${v.name || "(unnamed)"}`,
        (d) => {
          if (owner.kind === "aspectType") renameAspectTypeVariable(d, owner.uid, v.uid, name);
          else renameAssetTypeVariable(d, index, owner.uid, v.uid, name);
        },
        { coalesceKey: `${owner.uid}:${v.uid}:name` },
      );
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const onPatch = (v: VariableDef, field: string, label: string, mutate: (d: VariableDef) => void) => {
    try {
      apply(
        label,
        (d) => {
          const target = variablesOf(d, owner).find((x) => x.uid === v.uid);
          if (!target) throw new DomainError("Variable not found.");
          mutate(target);
        },
        { coalesceKey: `${owner.uid}:${v.uid}:${field}` },
      );
    } catch (e) {
      notifyError(e);
    }
  };

  const onMove = (v: VariableDef, delta: -1 | 1) => {
    try {
      apply(`Reorder variables of ${owner.name}`, (d) => {
        const list = variablesOf(d, owner);
        const from = list.findIndex((x) => x.uid === v.uid);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= list.length) return;
        const [item] = list.splice(from, 1);
        list.splice(to, 0, item!);
      });
    } catch (e) {
      notifyError(e);
    }
  };

  const onAdd = () => {
    const name = uniqueName("variable", takenNames());
    const dataType: DataType = owner.kind === "aspectType" && category === "dynamic" ? "DOUBLE" : "STRING";
    try {
      apply(`Add variable to ${owner.name}`, (d) => {
        variablesOf(d, owner).push(newVariable(name, dataType));
      });
    } catch (e) {
      notifyError(e);
    }
  };

  const onDelete = async (v: VariableDef) => {
    const label = v.name || "(unnamed)";
    let radius: BlastRadius;
    try {
      radius = blastRadius(owner, v.name);
    } catch (e) {
      notifyError(e);
      return;
    }
    const ok = await confirmDialog({
      title: `Delete variable “${label}”?`,
      message:
        owner.kind === "aspectType"
          ? `The variable is removed from the aspect type and from every asset type that uses it.${v.baseline ? " It exists in the tenant: the next deployment deletes it there, including its data." : ""}`
          : `The variable is removed from “${owner.name}” and its descendant types; values set on assets are removed too.${v.baseline ? " It exists in the tenant: the next deployment deletes it there." : ""}`,
      confirmLabel: "Delete variable",
      danger: true,
      details: <BlastRadiusDetails radius={radius} />,
    });
    if (!ok) return;
    try {
      apply(`Delete variable ${label} from ${owner.name}`, (d) => {
        if (owner.kind === "aspectType") deleteAspectTypeVariable(d, owner.uid, v.uid);
        else deleteAssetTypeVariable(d, currentIndex(), owner.uid, v.uid);
      });
      notifySuccess(`Variable “${label}” deleted.`);
    } catch (e) {
      notifyError(e);
    }
  };

  const onRecreate = async (v: VariableDef) => {
    const label = v.name || "(unnamed)";
    let radius: BlastRadius;
    try {
      radius = blastRadius(owner, v.name);
    } catch (e) {
      notifyError(e);
      return;
    }
    const types = allowedDataTypes(owner, category, v.dataType);
    const result = await formDialog({
      title: `Delete and recreate “${label}”`,
      initial: { dataType: v.dataType, searchable: v.searchable, length: v.length },
      confirmLabel: "Delete and recreate",
      danger: true,
      size: "600",
      render: (value, patch) => <RecreateForm value={value} patch={patch} types={types} radius={radius} />,
      validate: (value) =>
        value.dataType === (v.baseline?.dataType ?? v.dataType) && value.searchable === (v.baseline?.searchable ?? v.searchable)
          ? "Change the data type or the searchable flag — other properties can be edited in place."
          : undefined,
    });
    if (!result) return;
    try {
      apply(`Recreate variable ${label} (${result.dataType})`, (d) => {
        recreateVariable(d, currentIndex(), owner, v.uid, {
          dataType: result.dataType,
          searchable: result.searchable,
          length: supportsLength(result.dataType) ? (result.length ?? DEFAULT_STRING_LENGTH) : undefined,
          ...(result.dataType === v.dataType && v.defaultValue !== undefined ? { defaultValue: v.defaultValue } : {}),
        });
      });
      notifySuccess(`Variable “${label}” will be recreated as ${result.dataType} on the next deployment.`);
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <div className={styles.table}>
      {variables.length === 0 ? (
        <IxTypography format="body-sm" textColor="soft">
          {owner.kind === "assetType"
            ? "No own variables. Static variables count as billable asset attributes for every asset of this type."
            : "An aspect type needs at least one variable."}
        </IxTypography>
      ) : (
        <ol className={styles.rows}>
          {variables.map((v, i) => (
            <VariableRow
              key={v.uid}
              v={v}
              position={i}
              total={variables.length}
              owner={owner}
              category={category}
              onRename={onRename}
              onPatch={onPatch}
              onMove={onMove}
              onDelete={(x) => void onDelete(x)}
              onRecreate={(x) => void onRecreate(x)}
            />
          ))}
        </ol>
      )}
      <div>
        <IxButton variant="secondary" icon={iconAdd} onClick={onAdd}>
          Add variable
        </IxButton>
      </div>
    </div>
  );
}
