// Asset Attribute Estimator: per-type attributes per asset × instances, with
// editable "what-if" planned instance counts feeding useEstimate(planned).

import { useMemo, useState } from "react";
import { IxButton, IxChip, IxMessageBar, IxNumberInput, IxTypography } from "@siemens/ix-react";
import { iconRefresh } from "@siemens/ix-icons/icons";
import { GUARDRAIL_NOTES, TECHNICAL_LIMITS } from "@/domain/rules";
import { useEstimate } from "@/state/hooks";
import { meterLevel, plannedCount } from "./navigation";
import { LimitMeter } from "./LimitMeter";
import styles from "./Overview.module.css";

export function EstimatorPanel() {
  const [planned, setPlanned] = useState<Record<string, number>>({});
  const hasPlan = Object.keys(planned).length > 0;
  const modelled = useEstimate();
  const plannedArg = useMemo(() => (hasPlan ? planned : undefined), [hasPlan, planned]);
  const estimate = useEstimate(plannedArg);
  const modelledByKey = useMemo(() => new Map(modelled.types.map((t) => [t.key, t])), [modelled]);
  // Keep the row order of the modelled estimate so rows don't jump while typing.
  const rows = useMemo(() => {
    const byKey = new Map(estimate.types.map((t) => [t.key, t]));
    return modelled.types.map((t) => byKey.get(t.key) ?? t);
  }, [estimate, modelled]);

  function setPlan(key: string, value: unknown) {
    const n = plannedCount(value);
    setPlanned((p) => {
      const next = { ...p };
      if (n === undefined || n === modelledByKey.get(key)?.instances) delete next[key];
      else next[key] = n;
      return next;
    });
  }

  return (
    <div className={styles.stack}>
      <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
        {GUARDRAIL_NOTES.attributes} The platform&apos;s own calculator is an estimator too, so slight variations are expected.
      </IxTypography>
      {estimate.incomplete ? (
        <IxMessageBar persistent type="warning">
          Some types use external parent or aspect types whose definitions are unknown offline. Their attribute counts are lower bounds — the
          real totals may be higher.
        </IxMessageBar>
      ) : null}
      <div className={styles.estimateTotals}>
        <LimitMeter
          label={hasPlan ? "Planned asset attributes" : "Estimated asset attributes"}
          value={estimate.totalAttributes}
          limit={TECHNICAL_LIMITS.maxAttributesPerTenant}
        />
        <div className={styles.planActions}>
          <IxTypography format="body-sm" className={styles.wrap}>
            {estimate.assets.toLocaleString()} assets{hasPlan ? ` planned (modelled: ${modelled.assets.toLocaleString()})` : ""} ·{" "}
            {estimate.ootbInstances.toLocaleString()} from core types
          </IxTypography>
          <IxButton variant="tertiary" icon={iconRefresh} disabled={!hasPlan} onClick={() => setPlanned({})}>
            Reset planned counts
          </IxButton>
        </div>
      </div>
      {rows.length === 0 ? (
        <IxTypography format="body-sm" textColor="soft">
          No asset types or assets yet.
        </IxTypography>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>Asset attributes per asset type</caption>
            <thead>
              <tr>
                <th scope="col">Asset type</th>
                <th scope="col" className={styles.num}>
                  Attributes per asset
                </th>
                <th scope="col" className={styles.num}>
                  Modelled instances
                </th>
                <th scope="col" className={styles.planCol}>
                  Planned instances (what-if)
                </th>
                <th scope="col" className={styles.num}>
                  Total attributes
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const base = modelledByKey.get(t.key);
                const isPlanned = t.key in planned;
                return (
                  <tr key={t.key}>
                    <th scope="row" className={styles.cellWrap}>
                      <span className={styles.typeCell}>
                        <span className={styles.wrap}>{t.name}</span>
                        <IxTypography format="body-xs" textColor="soft" className={styles.wrap}>
                          {t.displayId}
                        </IxTypography>
                        <span className={styles.chips}>
                          {t.isCore ? (
                            <IxChip variant="neutral" outline>
                              Core type · 1 per asset
                            </IxChip>
                          ) : null}
                          {!t.instantiable ? (
                            <IxChip variant="neutral" outline>
                              Abstract
                            </IxChip>
                          ) : null}
                          {t.incomplete && !t.isCore ? (
                            <IxChip variant="warning" outline>
                              Lower bound
                            </IxChip>
                          ) : null}
                        </span>
                      </span>
                    </th>
                    <td className={styles.num}>
                      {t.perAsset.toLocaleString()}
                      {!t.isCore && t.billableAttributes === 0 ? (
                        <IxTypography format="body-xs" textColor="soft">
                          minimum 1
                        </IxTypography>
                      ) : null}
                    </td>
                    <td className={styles.num}>{(base?.instances ?? 0).toLocaleString()}</td>
                    <td className={styles.planCol}>
                      <IxNumberInput
                        label={`Planned ${t.name}`}
                        min={0}
                        value={t.instances}
                        disabled={!t.instantiable}
                        className={isPlanned ? "ix-info" : undefined}
                        infoText={isPlanned ? "What-if value" : undefined}
                        onValueChange={(e) => setPlan(t.key, e.detail)}
                      />
                    </td>
                    <td className={styles.num}>{t.totalAttributes.toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td />
                <td className={styles.num}>{modelled.assets.toLocaleString()}</td>
                <td className={styles.planCol}>{hasPlan ? estimate.assets.toLocaleString() : "—"}</td>
                <td className={`${styles.num} ${meterLevel(estimate.tenantLimitShare) === "alarm" ? styles.alarmText : ""}`}>
                  {estimate.totalAttributes.toLocaleString()}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
