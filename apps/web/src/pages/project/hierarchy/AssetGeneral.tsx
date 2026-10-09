// General asset fields: name, external id, description, type, timezone, twin type.

import { useMemo } from "react";
import { IxInput, IxMessageBar, IxSelect, IxSelectItem, IxTextarea } from "@siemens/ix-react";
import { confirmDialog } from "@/components/dialogs";
import { TWIN_TYPES, typeRefKey, type AssetDef, type TwinType } from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";
import { LIMITS } from "@/domain/rules";
import { checkTimezone, supportedTimezones } from "@/domain/timezone";
import type { Issue } from "@/domain/validator";
import { instantiableTypeOptions } from "@/features/hierarchy/types";
import { retainValuesForType, valuesNotOnType } from "@/features/hierarchy/values";
import { TypeSelect } from "./AssetDialogs";
import type { AssetEdit } from "./editAsset";
import { fieldState } from "./fields";
import styles from "./AssetDetail.module.css";

let timezoneCache: string[] | undefined;
function timezones(): string[] {
  timezoneCache ??= supportedTimezones();
  return timezoneCache;
}

const TWIN_LABEL: Record<TwinType, string> = {
  performance: "Performance (real asset)",
  simulation: "Simulation (microsecond timestamps)",
};

export function AssetGeneral({
  asset,
  index,
  issues,
  edit,
  labelName,
}: {
  asset: AssetDef;
  index: ModelIndex;
  issues: Issue[];
  edit: AssetEdit;
  /** Name of the asset when it was selected (stable changelog label while typing). */
  labelName: string;
}) {
  const options = useMemo(() => instantiableTypeOptions(index), [index]);
  const locked = !!asset.baseline;
  const typeKey = typeRefKey(asset.type);
  const currentLabel = `${index.assetTypeName(asset.type)} (${index.assetTypeDisplayId(asset.type)})`;
  const tz = asset.timezone ?? "";
  const tzCheck = tz ? checkTimezone(tz) : undefined;
  const tzList = timezones();

  async function changeType(key: string) {
    if (key === typeKey) return;
    const option = options.find((o) => o.key === key);
    if (!option) return;
    const resolved = index.resolveAssetType(option.ref);
    const dropped = valuesNotOnType(asset, resolved);
    const lost = [...dropped.variables, ...dropped.aspectValues];
    if (lost.length) {
      const ok = await confirmDialog({
        title: "Change asset type",
        message: `“${option.name}” does not define ${lost.length} value(s) set on this asset. They will be removed.`,
        confirmLabel: "Change type and drop values",
        danger: true,
        details: (
          <ul className={styles.list}>
            {lost.slice(0, 50).map((n) => (
              <li key={n}>{n}</li>
            ))}
            {lost.length > 50 ? <li>… and {lost.length - 50} more</li> : null}
          </ul>
        ),
      });
      if (!ok) return;
    }
    edit(`Change type of “${asset.name}” to ${option.name}`, (a) => {
      a.type = option.ref;
      retainValuesForType(a, resolved);
    });
  }

  function setTimezone(value: string) {
    const v = value.trim();
    edit(`Set timezone of “${asset.name}”`, (a) => {
      if (v) a.timezone = v;
      else delete a.timezone;
    });
  }

  const tzState = fieldState(issues, "timezone");

  return (
    <div className={styles.form}>
      {locked ? (
        <IxMessageBar persistent type="info">
          This asset was deployed or imported. Type, timezone and twin type are create-only and cannot be changed in the tenant.
        </IxMessageBar>
      ) : null}
      <div className={styles.fieldGrid}>
        <IxInput
          label="Name"
          required
          value={asset.name}
          maxLength={LIMITS.assetNameMax}
          helperText={"Unique among its siblings; must not contain / or \\."}
          {...fieldState(issues, "name")}
          onValueChange={(e) => edit(`Rename asset “${labelName}”`, (a) => void (a.name = e.detail), "name")}
        />
        <IxInput
          label="External id"
          value={asset.externalId ?? ""}
          maxLength={LIMITS.externalIdMax}
          helperText="Optional id from an external system."
          {...fieldState(issues, "externalId")}
          onValueChange={(e) =>
            edit(`Edit external id of “${labelName}”`, (a) => {
              if (e.detail) a.externalId = e.detail;
              else delete a.externalId;
            }, "externalId")
          }
        />
      </div>
      <IxTextarea textareaWidth="100%"
        label="Description"
        value={asset.description ?? ""}
        maxLength={LIMITS.descriptionMax}
        textareaRows={3}
        resizeBehavior="vertical"
        helperText="Up to 255 characters; single quotes (') are not allowed."
        {...fieldState(issues, "description")}
        onValueChange={(e) =>
          edit(`Edit description of “${labelName}”`, (a) => {
            if (e.detail) a.description = e.detail;
            else delete a.description;
          }, "description")
        }
      />
      <div className={styles.fieldGrid}>
        <TypeSelect
          options={options}
          value={typeKey}
          readonly={locked}
          extra={{ key: typeKey, label: currentLabel }}
          onChange={(key) => void changeType(key)}
          helperText={
            locked
              ? "Create-only: the type of a deployed asset cannot be changed."
              : "Changing the type drops values the new type does not define."
          }
          invalidText={fieldState(issues, "type").invalidText}
        />
        <IxSelect
          label="Twin type"
          value={asset.twinType}
          readonly={locked}
          helperText={locked ? "Create-only." : "Simulation allows high resolution (microsecond) timestamps. Create-only."}
          {...fieldState(issues, "twinType")}
          onValueChange={(e) => {
            const v = e.detail;
            if (v === "performance" || v === "simulation") edit(`Set twin type of “${asset.name}”`, (a) => void (a.twinType = v));
          }}
        >
          {TWIN_TYPES.map((t) => (
            <IxSelectItem key={t} value={t} label={TWIN_LABEL[t]} />
          ))}
        </IxSelect>
        <IxSelect
          label="Timezone"
          editable
          allowClear={!locked}
          readonly={locked}
          value={tz}
          i18nPlaceholder="Tenant default"
          i18nPlaceholderEditable="Tenant default — type to search or enter a zone id"
          helperText={
            tzState.invalidText || tzState.warningText
              ? undefined
              : locked
                ? "Create-only: set when the asset was created."
                : tzCheck?.ok
                  ? `Offsets: ${tzCheck.offsets.join(", ")}. Create-only once deployed.`
                  : "Empty = the tenant's default timezone. Zones 15 or 45 minutes off a UTC hour are not supported."
          }
          {...tzState}
          onValueChange={(e) => {
            const v = Array.isArray(e.detail) ? (e.detail[0] ?? "") : e.detail;
            if (v !== tz) setTimezone(v);
          }}
          onAddItem={(e) => setTimezone(e.detail)}
        >
          {tz && !tzList.includes(tz) ? <IxSelectItem value={tz} label={tz} /> : null}
          {tzList.map((z) => (
            <IxSelectItem key={z} value={z} label={z} />
          ))}
        </IxSelect>
      </div>
    </div>
  );
}
