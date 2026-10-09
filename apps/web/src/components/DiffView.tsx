// Renders a list of structural changes (domain/diff Change[]): used for
// version snapshots, ETag (412) conflicts and the deployment target diff.

import { IxChip, IxTypography } from "@siemens/ix-react";
import type { Change } from "@/domain/diff";
import styles from "./DiffView.module.css";

const KIND_VARIANT: Record<Change["kind"], "success" | "alarm" | "warning"> = {
  added: "success",
  removed: "alarm",
  changed: "warning",
};

function show(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value === "" ? '""' : value;
  const s = JSON.stringify(value);
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

export function DiffView({
  changes,
  beforeLabel = "Before",
  afterLabel = "After",
  empty = "No differences.",
}: {
  changes: Change[];
  beforeLabel?: string;
  afterLabel?: string;
  empty?: string;
}) {
  if (changes.length === 0) {
    return (
      <IxTypography format="body-sm" textColor="soft">
        {empty}
      </IxTypography>
    );
  }
  return (
    <div className={styles.table} role="table" aria-label="Differences">
      <div className={styles.head} role="row">
        <span role="columnheader"><IxTypography format="label-sm" textColor="soft">Field</IxTypography></span>
        <span role="columnheader"><IxTypography format="label-sm" textColor="soft">{beforeLabel}</IxTypography></span>
        <span role="columnheader"><IxTypography format="label-sm" textColor="soft">{afterLabel}</IxTypography></span>
      </div>
      {changes.map((c) => (
        <div key={`${c.path}:${c.kind}`} className={styles.row} role="row">
          <span className={styles.path} role="cell">
            <IxChip variant={KIND_VARIANT[c.kind]} outline>
              {c.kind}
            </IxChip>
            <IxTypography format="code-sm">{c.path || "(value)"}</IxTypography>
          </span>
          <span className={styles.value} role="cell">
            <IxTypography format="code-sm">{show(c.before)}</IxTypography>
          </span>
          <span className={styles.value} role="cell">
            <IxTypography format="code-sm">{show(c.after)}</IxTypography>
          </span>
        </div>
      ))}
    </div>
  );
}
