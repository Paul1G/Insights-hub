// Read-only details of an existing tenant object (asset type, aspect type, asset).

import { useMemo } from "react";
import { IxChip, IxTypography } from "@siemens/ix-react";
import type { AmAssetResource } from "@/api/amTypes";
import type { CoreLibraryIndex } from "@/domain/coreLibrary";
import type { ExternalTypes } from "@/domain/external";
import { createEmptyProject, type TypeRef } from "@/domain/model";
import { ModelIndex } from "@/domain/resolve";
import { DetailHeader, DetailSection } from "@/features/types/MasterDetail";
import { ReadonlyVariables } from "@/features/types/ReadonlyVariables";
import { ORIGIN_LABEL, STATUS_LABEL, type AspectTypeRow, type AssetRow, type AssetTypeRow, type RowStatus } from "./rows";
import styles from "./catalog.module.css";

const STATUS_VARIANT: Record<RowStatus, "success" | "neutral" | "info"> = {
  "in-project": "success",
  "not-in-project": "neutral",
  core: "info",
};

export function StatusChip({ status }: { status: RowStatus }) {
  return (
    <IxChip variant={STATUS_VARIANT[status]} outline inactive>
      {STATUS_LABEL[status]}
    </IxChip>
  );
}

function KeyValues({ items }: { items: [string, string][] }) {
  return (
    <dl className={styles.kv}>
      {items.map(([k, v]) => (
        <div key={k} className={styles.kvPair}>
          <dt>
            <IxTypography format="label-sm" textColor="soft">
              {k}
            </IxTypography>
          </dt>
          <dd className={styles.kvValue}>
            <IxTypography format="body-sm">{v || "—"}</IxTypography>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Index over an empty project: resolves core and existing tenant types with inheritance. */
function useCatalogIndex(core: CoreLibraryIndex, external: ExternalTypes | undefined): ModelIndex {
  return useMemo(() => new ModelIndex(createEmptyProject("catalog"), core, external), [core, external]);
}

const refOf = (id: string): TypeRef => (id.toLowerCase().startsWith("core.") ? { kind: "core", id } : { kind: "external", id });

export function AssetTypeDetails({ row, core, external, showStatus }: { row: AssetTypeRow; core: CoreLibraryIndex; external?: ExternalTypes; showStatus: boolean }) {
  const index = useCatalogIndex(core, external);
  const resolved = index.resolveAssetType(refOf(row.id));
  const chain = resolved?.chain.map((r) => index.assetTypeName(r)).join(" → ") ?? row.id;
  return (
    <div className={styles.detail}>
      <DetailHeader
        title={row.name}
        subtitle={`${row.id} · ${ORIGIN_LABEL[row.origin]}`}
        badges={
          <>
            {showStatus ? <StatusChip status={row.status} /> : null}
            <IxChip variant={row.instantiable ? "success" : "neutral"} outline inactive>
              {row.instantiable ? "Instantiable" : "Abstract"}
            </IxChip>
          </>
        }
      />
      <DetailSection title="Definition" readOnly>
        <KeyValues
          items={[
            ["Inheritance", chain],
            ["Description", row.resource.description ?? ""],
            ["Instances in tenant", String(row.instances)],
            ["Attributes per asset", resolved ? `${Math.max(1, resolved.billableAttributes)} (billable ${resolved.billableAttributes})` : "unknown"],
            ["Variables incl. inherited and aspects", resolved ? String(resolved.totalVariableCount) : "unknown"],
          ]}
        />
      </DetailSection>
      <DetailSection title={`Static variables (${resolved?.variables.length ?? row.variables})`} readOnly>
        <ReadonlyVariables
          caption={`Variables of ${row.name}`}
          showOrigin
          variables={(resolved?.variables ?? []).map((v) => ({ ...v, origin: v.inherited ? `inherited from ${v.definedOnName}` : "own" }))}
        />
      </DetailSection>
      <DetailSection title={`Aspects (${resolved?.aspects.length ?? row.aspects})`} readOnly>
        {(resolved?.aspects ?? []).length === 0 ? (
          <IxTypography format="body-sm" textColor="soft">
            No aspects.
          </IxTypography>
        ) : (
          <ul className={styles.list}>
            {resolved!.aspects.map((a) => (
              <li key={`${a.definedOnName}:${a.name}`}>
                <IxTypography format="body-sm" className={styles.text}>
                  <strong>{a.name}</strong> — {a.aspectType.name} ({a.aspectType.displayId}) · {a.aspectType.category} ·{" "}
                  {a.aspectType.variables.length} variable(s){a.inherited ? ` · inherited from ${a.definedOnName}` : ""}
                </IxTypography>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </div>
  );
}

export function AspectTypeDetails({ row, usedBy, showStatus }: { row: AspectTypeRow; usedBy: string[]; showStatus: boolean }) {
  return (
    <div className={styles.detail}>
      <DetailHeader
        title={row.name}
        subtitle={`${row.id} · ${ORIGIN_LABEL[row.origin]}`}
        badges={
          <>
            {showStatus ? <StatusChip status={row.status} /> : null}
            <IxChip variant={row.category === "dynamic" ? "info" : "neutral"} outline inactive>
              {row.category}
            </IxChip>
          </>
        }
      />
      <DetailSection title="Definition" readOnly>
        <KeyValues items={[["Description", row.resource.description ?? ""], ["Used by asset types", usedBy.join(", ")]]} />
      </DetailSection>
      <DetailSection title={`Variables (${row.variables})`} readOnly>
        <ReadonlyVariables caption={`Variables of ${row.name}`} showQualityCode variables={(row.resource.variables ?? []).map((v) => ({ ...v, searchable: !!v.searchable }))} />
      </DetailSection>
    </div>
  );
}

function formatLocation(a: AmAssetResource): string {
  const l = a.location;
  if (!l) return "";
  const parts = [l.streetAddress, l.postalCode, l.locality, l.region, l.country].filter(Boolean);
  const coords = l.latitude !== undefined && l.longitude !== undefined ? `${l.latitude}, ${l.longitude}` : "";
  return [...parts, coords].filter(Boolean).join(" · ");
}

export function AssetDetails({ row, showStatus }: { row: AssetRow; showStatus: boolean }) {
  const a = row.resource;
  const values = [
    ...(a.variables ?? []).map((v) => `${v.name} = ${v.value}`),
    ...(a.aspects ?? []).flatMap((x) => (x.variables ?? []).map((v) => `${x.name}.${v.name} = ${v.value}`)),
  ];
  return (
    <div className={styles.detail}>
      <DetailHeader title={row.name} subtitle={row.path} badges={showStatus ? <StatusChip status={row.status} /> : undefined} />
      <DetailSection title="Asset" readOnly>
        <KeyValues
          items={[
            ["Asset id", a.assetId],
            ["Type", `${row.typeName} (${row.typeId})`],
            ["External id", row.externalId],
            ["Description", a.description ?? ""],
            ["Timezone", a.timezone ?? ""],
            ["Twin type", a.twinType ?? ""],
            ["Location", formatLocation(a)],
            ["Children", String(row.children)],
          ]}
        />
      </DetailSection>
      <DetailSection title={`Values (${values.length})`} readOnly>
        {values.length === 0 ? (
          <IxTypography format="body-sm" textColor="soft">
            No static values (type defaults apply).
          </IxTypography>
        ) : (
          <ul className={styles.list}>
            {values.map((v) => (
              <li key={v}>
                <IxTypography format="code-sm" className={styles.text}>
                  {v}
                </IxTypography>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </div>
  );
}
