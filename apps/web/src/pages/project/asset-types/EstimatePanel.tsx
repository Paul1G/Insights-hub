// Asset attribute estimate for one asset type (domain/estimator) and the
// type's guardrail meters (respecting the active guardrail profile).

import { IxChip, IxTypography } from "@siemens/ix-react";
import { estimateType } from "@/domain/estimator";
import type { AssetTypeDef } from "@/domain/model";
import type { ResolvedAssetType } from "@/domain/resolve";
import { GUARDRAIL_NOTES, TECHNICAL_LIMITS } from "@/domain/rules";
import { GuardrailMeters, type GuardrailLimit } from "@/features/types/GuardrailMeter";
import { DetailSection } from "@/features/types/MasterDetail";
import { masterDetailStyles as md } from "@/features/types/styles";
import { useModelIndex } from "@/state/hooks";
import { useSettingsStore } from "@/state/settingsStore";
import styles from "./AssetTypes.module.css";

export function EstimatePanel({ type, resolved }: { type: AssetTypeDef; resolved: ResolvedAssetType }) {
  const index = useModelIndex();
  const guardrails = useSettingsStore((s) => s.guardrails);
  const ref = { kind: "project", uid: type.uid } as const;
  const breakdown = estimateType(index, ref);
  const instances = index.assetsOfType(ref, false).length;
  if (!breakdown) return null;
  const total = breakdown.perAsset * instances;

  const limits: GuardrailLimit[] = [
    { label: "Direct variables", actual: type.variables.length, max: TECHNICAL_LIMITS.maxDirectVariablesPerAssetType, kind: "technical" },
    { label: "Aspects (incl. inherited)", actual: resolved.aspects.length, max: guardrails.recommended.maxAspectsPerAssetType, kind: "recommended" },
    { label: "Aspects (incl. inherited)", actual: resolved.aspects.length, max: TECHNICAL_LIMITS.maxAspectsPerAssetType, kind: "technical" },
    {
      label: "Variables (incl. inherited and aspects)",
      actual: resolved.totalVariableCount,
      max: guardrails.recommended.maxVariablesPerAssetType,
      kind: "recommended",
    },
    {
      label: "Inheritance depth",
      actual: resolved.depth,
      max: TECHNICAL_LIMITS.maxAssetTypeDepth,
      kind: "technical",
      note: GUARDRAIL_NOTES.assetTypeDepth,
    },
    { label: "Attributes per asset", actual: breakdown.perAsset, max: TECHNICAL_LIMITS.maxAttributesPerAsset, kind: "technical" },
  ];

  return (
    <>
      <DetailSection
        title="Guardrails"
        description={
          guardrails.profile === "technical"
            ? "Profile “Recommended + technical limits”: exceeding a technical limit is an error that blocks deployment."
            : "Profile “Recommended only”: technical limits are shown for information."
        }
      >
        <GuardrailMeters limits={limits} profile={guardrails.profile} />
      </DetailSection>

      <DetailSection
        title="Asset attribute estimate"
        description={GUARDRAIL_NOTES.attributes}
        actions={
          breakdown.incomplete ? (
            <IxChip variant="warning" outline inactive>
              Lower bound — part of the definition is unknown offline
            </IxChip>
          ) : undefined
        }
      >
        <div className={styles.kpis}>
          <div className={styles.kpi}>
            <IxTypography format="label-sm" textColor="soft">Direct static variables</IxTypography>
            <IxTypography format="display-xs">{breakdown.direct}</IxTypography>
          </div>
          <div className={styles.kpi}>
            <IxTypography format="label-sm" textColor="soft">Inherited static variables</IxTypography>
            <IxTypography format="display-xs">{breakdown.inheritedStatic}</IxTypography>
          </div>
          <div className={styles.kpi}>
            <IxTypography format="label-sm" textColor="soft">Billable attributes</IxTypography>
            <IxTypography format="display-xs">{breakdown.billable}</IxTypography>
          </div>
          <div className={styles.kpi}>
            <IxTypography format="label-sm" textColor="soft">Per asset (min. 1)</IxTypography>
            <IxTypography format="display-xs">{breakdown.perAsset}</IxTypography>
          </div>
          <div className={styles.kpi}>
            <IxTypography format="label-sm" textColor="soft">Modelled instances</IxTypography>
            <IxTypography format="display-xs">{instances.toLocaleString()}</IxTypography>
          </div>
          <div className={styles.kpi}>
            <IxTypography format="label-sm" textColor="soft">Attributes of these instances</IxTypography>
            <IxTypography format="display-xs">{total.toLocaleString()}</IxTypography>
          </div>
        </div>
        {breakdown.aspects.length ? (
          <div className={md.tableScroll}>
            <table className={md.table}>
              <caption className="visually-hidden">Attributes per aspect</caption>
              <thead>
                <tr>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Aspect</IxTypography></th>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Aspect type</IxTypography></th>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Variables</IxTypography></th>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Billable</IxTypography></th>
                  <th scope="col"><IxTypography format="label-sm" textColor="soft">Source</IxTypography></th>
                </tr>
              </thead>
              <tbody>
                {breakdown.aspects.map((a) => (
                  <tr key={a.name}>
                    <td><IxTypography format="code-sm">{a.name}</IxTypography></td>
                    <td><IxTypography format="body-sm">{a.aspectTypeName}</IxTypography></td>
                    <td><IxTypography format="body-sm">{a.variables}</IxTypography></td>
                    <td>
                      <IxTypography format="body-sm">{a.billable ? "Yes" : "No (core)"}</IxTypography>
                    </td>
                    <td>
                      <IxTypography format="body-sm" textColor="soft">{a.inherited ? "Inherited" : "Own"}</IxTypography>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <IxTypography format="body-sm" textColor="soft">
            No aspects — only static variables count.
          </IxTypography>
        )}
      </DetailSection>
    </>
  );
}
