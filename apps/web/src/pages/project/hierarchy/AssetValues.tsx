// Instance values: static variables of the resolved type (own + inherited)
// and variables of static aspects. Dynamic aspects are time series and are
// listed read-only. Clearing a field removes the override.

import { IxButton, IxInput, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { iconTrashcan } from "@siemens/ix-icons/icons";
import { Section } from "@/components/Page";
import type { AssetDef } from "@/domain/model";
import type { ModelIndex, ResolvedAssetType, VariableLike } from "@/domain/resolve";
import type { Issue } from "@/domain/validator";
import { checkValue } from "@/domain/values";
import { aspectValue, setAspectValue, setVariableValue, valuesNotOnType, variableValue } from "@/features/hierarchy/values";
import type { AssetEdit } from "./editAsset";
import { fieldState } from "./fields";
import styles from "./AssetDetail.module.css";

function describe(v: VariableLike): string {
  const parts: string[] = [v.dataType];
  if (v.unit) parts.push(`unit ${v.unit}`);
  if ((v.dataType === "STRING" || v.dataType === "BIG_STRING") && v.length) parts.push(`max ${v.length} chars`);
  return parts.join(" · ");
}

function ValueField({
  variable,
  value,
  origin,
  issues,
  field,
  onChange,
}: {
  variable: VariableLike;
  value: string | undefined;
  origin: string;
  issues: Issue[];
  field: string;
  onChange(v: string | undefined): void;
}) {
  const local = value !== undefined ? checkValue(variable.dataType, value, variable.length) : undefined;
  const state = fieldState(issues, field, local);
  const def = variable.defaultValue ?? undefined;
  const helper = `${describe(variable)} · ${origin}${def ? ` · default ${def}` : ""}`;
  if (variable.dataType === "BOOLEAN") {
    return (
      <IxSelect
        label={variable.name}
        value={value ?? ""}
        allowClear
        i18nPlaceholder={def ? `Default: ${def}` : "Not set"}
        helperText={state.invalidText ? undefined : helper}
        {...state}
        onValueChange={(e) => {
          const v = Array.isArray(e.detail) ? e.detail[0] : e.detail;
          onChange(v || undefined);
        }}
      >
        <IxSelectItem value="true" label="true" />
        <IxSelectItem value="false" label="false" />
      </IxSelect>
    );
  }
  return (
    <IxInput
      label={variable.name}
      value={value ?? ""}
      placeholder={def ? `Default: ${def}` : variable.dataType === "TIMESTAMP" ? "2018-01-01T00:00:00.00Z" : "Not set"}
      helperText={state.invalidText ? undefined : helper}
      {...state}
      onValueChange={(e) => onChange(e.detail === "" ? undefined : e.detail)}
    />
  );
}

export function AssetValues({
  asset,
  resolved,
  index,
  issues,
  edit,
  labelName,
}: {
  asset: AssetDef;
  resolved: ResolvedAssetType | undefined;
  index: ModelIndex;
  issues: Issue[];
  edit: AssetEdit;
  labelName: string;
}) {
  if (!resolved) {
    return (
      <IxTypography format="body" textColor="soft">
        The asset type could not be resolved, so its variables are unknown.
      </IxTypography>
    );
  }
  const staticAspects = resolved.aspects.filter((a) => a.aspectType.category === "static" && a.aspectType.known);
  const unknownAspects = resolved.aspects.filter((a) => !a.aspectType.known);
  const dynamicAspects = resolved.aspects.filter((a) => a.aspectType.category === "dynamic" && a.aspectType.known);
  const stray = valuesNotOnType(asset, resolved);

  return (
    <div className={styles.form}>
      {resolved.incomplete ? (
        <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
          Part of the type definition comes from external types that are unknown offline; additional variables may exist in the tenant.
        </IxTypography>
      ) : null}

      <Section title="Static variables" level="h3">
        {resolved.variables.length === 0 ? (
          <IxTypography format="body-sm" textColor="soft">
            {index.assetTypeName(asset.type)} defines no static variables.
          </IxTypography>
        ) : (
          <div className={styles.fieldGrid}>
            {resolved.variables.map((v) => (
              <ValueField
                key={`${v.definedOnName}:${v.name}`}
                variable={v}
                value={variableValue(asset, v.name)}
                origin={v.inherited ? `inherited from ${v.definedOnName}` : `defined on ${v.definedOnName}`}
                issues={issues}
                field={`variables.${v.name}`}
                onChange={(val) =>
                  edit(`Set ${v.name} on “${labelName}”`, (a) => setVariableValue(a, v.name, val), `variables.${v.name}`)
                }
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Static aspects" level="h3">
        {staticAspects.length === 0 ? (
          <IxTypography format="body-sm" textColor="soft">
            No static aspects.
          </IxTypography>
        ) : (
          staticAspects.map((asp) => (
            <div key={asp.name} className={styles.group}>
              <h4 className={`typography-h6 ${styles.heading}`}>
                {asp.name}{" "}
                <IxTypography format="body-sm" textColor="soft" className={styles.inline}>
                  {asp.aspectType.name} ({asp.aspectType.displayId}){asp.inherited ? ` · inherited from ${asp.definedOnName}` : ""}
                </IxTypography>
              </h4>
              <div className={styles.fieldGrid}>
                {asp.aspectType.variables.map((v) => (
                  <ValueField
                    key={v.name}
                    variable={v}
                    value={aspectValue(asset, asp.name, v.name)}
                    origin={`aspect ${asp.name}`}
                    issues={issues}
                    field={`aspects.${asp.name}.${v.name}`}
                    onChange={(val) =>
                      edit(
                        `Set ${asp.name}.${v.name} on “${labelName}”`,
                        (a) => setAspectValue(a, asp.name, v.name, val),
                        `aspects.${asp.name}.${v.name}`,
                      )
                    }
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </Section>

      <Section title="Dynamic aspects (time series)" level="h3">
        {dynamicAspects.length === 0 && unknownAspects.length === 0 ? (
          <IxTypography format="body-sm" textColor="soft">
            No dynamic aspects.
          </IxTypography>
        ) : (
          <ul className={styles.list}>
            {dynamicAspects.map((asp) => (
              <li key={asp.name} className={styles.wrap}>
                <IxTypography format="body-sm">
                  <strong>{asp.name}</strong> — {asp.aspectType.name} · {asp.aspectType.variables.length} time series variable(s):{" "}
                  {asp.aspectType.variables.map((v) => `${v.name} (${v.dataType}${v.unit ? `, ${v.unit}` : ""})`).join(", ")}. Values arrive
                  through time series ingestion and cannot be set here.
                </IxTypography>
              </li>
            ))}
            {unknownAspects.map((asp) => (
              <li key={asp.name} className={styles.wrap}>
                <IxTypography format="body-sm">
                  <strong>{asp.name}</strong> — {asp.aspectType.displayId}: external aspect type, definition unknown offline.
                </IxTypography>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {stray.variables.length || stray.aspectValues.length ? (
        <Section title="Values not defined by the type" level="h3">
          <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
            These values do not belong to a variable of {resolved.name} and would be rejected by the platform.
          </IxTypography>
          <ul className={styles.list}>
            {stray.variables.map((name) => (
              <li key={`v:${name}`} className={styles.inlineRow}>
                <IxTypography format="body-sm" className={styles.wrap}>
                  {name} = {variableValue(asset, name)}
                </IxTypography>
                <IxButton
                  variant="tertiary"
                  icon={iconTrashcan}
                  onClick={() => edit(`Remove value ${name} from “${labelName}”`, (a) => setVariableValue(a, name, undefined))}
                >
                  Remove value
                </IxButton>
              </li>
            ))}
            {stray.aspectValues.map((path) => {
              const [aspect, variable] = [path.slice(0, path.indexOf(".")), path.slice(path.indexOf(".") + 1)];
              return (
                <li key={`a:${path}`} className={styles.inlineRow}>
                  <IxTypography format="body-sm" className={styles.wrap}>
                    {path} = {aspectValue(asset, aspect, variable)}
                  </IxTypography>
                  <IxButton
                    variant="tertiary"
                    icon={iconTrashcan}
                    onClick={() => edit(`Remove value ${path} from “${labelName}”`, (a) => setAspectValue(a, aspect, variable, undefined))}
                  >
                    Remove value
                  </IxButton>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
