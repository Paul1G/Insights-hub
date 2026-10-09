// Copy wizard, step "Target & mapping": conflict table with per-type
// resolution — rename (new id / name) or map onto an existing target type.

import { IxInput, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import type { Resolution, TypeConflict } from "@/tenant/copy";
import styles from "../project/deploy/components/deploy.module.css";
import copyStyles from "./copy.module.css";

export interface ConflictRowState {
  conflict: TypeConflict;
  resolution: Resolution;
  /** Problems that block this resolution (empty = valid). */
  problems: string[];
}

const KIND_LABEL = { aspectType: "Aspect type", assetType: "Asset type" } as const;

export function CopyConflicts({
  tenant,
  rows,
  targetTypes,
  onChange,
}: {
  tenant: string;
  rows: ConflictRowState[];
  targetTypes: { aspectType: { id: string; name: string }[]; assetType: { id: string; name: string }[] };
  onChange: (uid: string, resolution: Resolution) => void;
}) {
  if (rows.length === 0) {
    return (
      <IxTypography format="body-sm" textColor="soft">
        No conflicts — none of the selected types collides with a type of the target (ids and names are compared case-insensitively).
      </IxTypography>
    );
  }
  return (
    <ul className={styles.list} aria-label="Conflicts with the target">
      {rows.map(({ conflict: c, resolution: r, problems }) => (
        <li key={c.uid} className={copyStyles.conflictRow}>
          <span className={styles.tightStack}>
            <IxTypography format="label-xs" textColor="soft">
              {KIND_LABEL[c.kind]}
            </IxTypography>
            <IxTypography format="body" bold className={styles.text}>
              {c.name}
            </IxTypography>
            <IxTypography format="code-sm" className={styles.code}>
              {c.id}
            </IxTypography>
          </span>
          <span className={styles.tightStack}>
            <IxTypography format="label-xs" textColor="soft">
              Collides with ({c.collision === "id+name" ? "id and name" : c.collision})
            </IxTypography>
            <IxTypography format="body" className={styles.text}>
              {c.existingName}
            </IxTypography>
            <IxTypography format="code-sm" className={styles.code}>
              {c.existingId}
            </IxTypography>
          </span>
          <span className={styles.tightStack}>
            <div className={copyStyles.resolution}>
              <IxSelect
                label="Resolution"
                value={r.action}
                onValueChange={(e) => {
                  const v = Array.isArray(e.detail) ? e.detail[0] : e.detail;
                  if (v === "map") onChange(c.uid, { action: "map", targetId: c.existingId });
                  else if (v === "rename") onChange(c.uid, { action: "rename", idSuffix: `${c.idSuffix}_copy`, name: `${c.name}_copy` });
                }}
              >
                <IxSelectItem value="rename" label="Rename (create a new type)" />
                <IxSelectItem value="map" label="Map to an existing target type" />
              </IxSelect>
              {r.action === "rename" ? (
                <>
                  <IxInput
                    label={`New id (${tenant}.…)`}
                    value={r.idSuffix}
                    className={problems.some((p) => p.startsWith("Id")) ? "ix-invalid" : undefined}
                    invalidText={problems.find((p) => p.startsWith("Id"))}
                    onValueChange={(e) => onChange(c.uid, { ...r, idSuffix: e.detail })}
                  />
                  <IxInput
                    label="New name"
                    value={r.name}
                    className={problems.some((p) => p.startsWith("Name")) ? "ix-invalid" : undefined}
                    invalidText={problems.find((p) => p.startsWith("Name"))}
                    onValueChange={(e) => onChange(c.uid, { ...r, name: e.detail })}
                  />
                </>
              ) : (
                <IxSelect
                  label="Existing target type"
                  value={r.targetId}
                  onValueChange={(e) => {
                    const v = Array.isArray(e.detail) ? e.detail[0] : e.detail;
                    if (v) onChange(c.uid, { action: "map", targetId: v });
                  }}
                >
                  {targetTypes[c.kind].map((t) => (
                    <IxSelectItem key={t.id} value={t.id} label={`${t.name} (${t.id})`} />
                  ))}
                </IxSelect>
              )}
            </div>
            {r.action === "map" ? (
              problems.length ? (
                <ul className={styles.list} aria-label={`Why ${c.name} cannot be mapped`}>
                  {problems.map((p) => (
                    <li key={p} className={styles.listItem}>
                      <IxTypography format="body-sm" textColor="alarm" className={styles.text}>
                        {p}
                      </IxTypography>
                    </li>
                  ))}
                </ul>
              ) : (
                <IxTypography format="body-sm" textColor="soft">
                  Compatible — references to this type will point to the existing target type; it is not created.
                </IxTypography>
              )
            ) : problems.filter((p) => !p.startsWith("Id") && !p.startsWith("Name")).map((p) => (
              <IxTypography key={p} format="body-sm" textColor="alarm" className={styles.text}>
                {p}
              </IxTypography>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}
