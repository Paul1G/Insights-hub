// Asset location (PUT /assets/{id}/location): address fields and coordinates.

import { useEffect, useState } from "react";
import { IxInput } from "@siemens/ix-react";
import type { AssetDef, Location } from "@/domain/model";
import { LIMITS } from "@/domain/rules";
import type { Issue } from "@/domain/validator";
import type { AssetEdit } from "./editAsset";
import { fieldState, parseCoordinate } from "./fields";
import styles from "./AssetDetail.module.css";

type TextKey = "country" | "region" | "locality" | "streetAddress" | "postalCode";
type CoordKey = "latitude" | "longitude";

const TEXT_FIELDS: { key: TextKey; label: string; helper?: string }[] = [
  { key: "streetAddress", label: "Street address" },
  { key: "postalCode", label: "Postal code" },
  { key: "locality", label: "Locality", helper: "Letters, digits, spaces, _ - and ' only." },
  { key: "region", label: "Region", helper: "County or other region code or name." },
  { key: "country", label: "Country" },
];

function setLocationField(edit: AssetEdit, labelName: string, key: keyof Location, value: string | number | undefined) {
  edit(
    `Edit location of “${labelName}”`,
    (a) => {
      const loc: Location = { ...(a.location ?? {}) };
      if (value === undefined || value === "") delete loc[key];
      else (loc as Record<string, string | number>)[key] = value;
      if (Object.keys(loc).length) a.location = loc;
      else delete a.location;
    },
    `location.${key}`,
  );
}

function CoordinateInput({
  label,
  value,
  min,
  max,
  issues,
  field,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  issues: Issue[];
  field: string;
  onCommit(v: number | undefined): void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  // Follow external changes (undo/redo, another editor) without fighting the user's typing.
  useEffect(() => {
    const parsed = parseCoordinate(text);
    if (parsed !== value && !(Number.isNaN(parsed) && value === undefined)) setText(value === undefined ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const parsed = parseCoordinate(text);
  const localError =
    parsed !== undefined && Number.isNaN(parsed)
      ? "Enter a decimal number, e.g. 48.137."
      : parsed !== undefined && (parsed < min || parsed > max)
        ? `${label} must be between ${min} and ${max}.`
        : undefined;
  return (
    <IxInput
      label={label}
      value={text}
      helperText={`Decimal degrees, ${min} to ${max}.`}
      {...fieldState(issues, field, localError)}
      onValueChange={(e) => {
        setText(e.detail);
        const v = parseCoordinate(e.detail);
        if (v === undefined) onCommit(undefined);
        else if (!Number.isNaN(v)) onCommit(v);
      }}
    />
  );
}

export function AssetLocation({ asset, issues, edit, labelName }: { asset: AssetDef; issues: Issue[]; edit: AssetEdit; labelName: string }) {
  const loc = asset.location ?? {};
  return (
    <div className={styles.form}>
      <div className={styles.fieldGrid}>
        {TEXT_FIELDS.map((f) => (
          <IxInput
            key={f.key}
            label={f.label}
            value={loc[f.key] ?? ""}
            maxLength={LIMITS.locationFieldMax}
            helperText={f.helper}
            {...fieldState(issues, `location.${f.key}`)}
            onValueChange={(e) => setLocationField(edit, labelName, f.key, e.detail)}
          />
        ))}
      </div>
      <div className={styles.fieldGrid}>
        {(
          [
            { key: "latitude", label: "Latitude", min: -90, max: 90 },
            { key: "longitude", label: "Longitude", min: -180, max: 180 },
          ] as { key: CoordKey; label: string; min: number; max: number }[]
        ).map((c) => (
          <CoordinateInput
            key={`${asset.uid}:${c.key}`}
            label={c.label}
            value={loc[c.key]}
            min={c.min}
            max={c.max}
            issues={issues}
            field={`location.${c.key}`}
            onCommit={(v) => setLocationField(edit, labelName, c.key, v)}
          />
        ))}
      </div>
    </div>
  );
}
