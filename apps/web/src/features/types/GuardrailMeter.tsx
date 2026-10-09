// Guardrail meter: one modelling limit (recommended threshold or technical
// limit) with the current value, a bar and a textual status. Under the
// "recommended" profile technical limits are informational (validator: info),
// under "technical" they block deployment (validator: error).

import { IxTypography } from "@siemens/ix-react";
import type { GuardrailProfile } from "@/domain/rules";
import styles from "./GuardrailMeter.module.css";

export interface GuardrailLimit {
  label: string;
  actual: number;
  max: number;
  kind: "recommended" | "technical";
  /** Optional explanation (e.g. how depth is counted). */
  note?: string;
}

type MeterState = "ok" | "near" | "warning" | "alarm" | "info";

function meterState(limit: GuardrailLimit, profile: GuardrailProfile): MeterState {
  if (limit.actual > limit.max) {
    if (limit.kind === "recommended") return "warning";
    return profile === "technical" ? "alarm" : "info";
  }
  return limit.max > 0 && limit.actual / limit.max >= 0.8 ? "near" : "ok";
}

const STATUS: Record<MeterState, (l: GuardrailLimit) => string> = {
  ok: () => "Within limit",
  near: () => "Close to the limit",
  warning: () => "Exceeds the recommended maximum",
  alarm: () => "Exceeds the technical limit — blocks deployment",
  info: () => "Exceeds the technical limit (informational under the “Recommended only” profile)",
};

export function GuardrailMeter({ limit, profile }: { limit: GuardrailLimit; profile: GuardrailProfile }) {
  const state = meterState(limit, profile);
  const pct = limit.max > 0 ? Math.min(100, (limit.actual / limit.max) * 100) : 100;
  const kindLabel = limit.kind === "recommended" ? "recommended" : "technical limit";
  const status = STATUS[state](limit);
  return (
    <div className={styles.meter}>
      <div className={styles.head}>
        <IxTypography format="label" className={styles.label}>
          {limit.label}
        </IxTypography>
        <IxTypography format="label-sm" textColor="soft" className={styles.value}>
          {limit.actual.toLocaleString()} / {limit.max.toLocaleString()} {kindLabel}
        </IxTypography>
      </div>
      <div
        className={styles.track}
        role="meter"
        aria-label={`${limit.label} (${kindLabel})`}
        aria-valuemin={0}
        aria-valuemax={limit.max}
        aria-valuenow={Math.min(limit.actual, limit.max)}
        aria-valuetext={`${limit.actual} of ${limit.max}: ${status}`}
      >
        <div className={`${styles.fill} ${styles[state]}`} style={{ width: `${pct}%` }} />
      </div>
      <IxTypography format="body-xs" textColor={state === "alarm" ? "alarm" : "soft"} className={styles.status}>
        {status}
        {limit.note ? ` · ${limit.note}` : ""}
      </IxTypography>
    </div>
  );
}

export function GuardrailMeters({ limits, profile }: { limits: GuardrailLimit[]; profile: GuardrailProfile }) {
  return (
    <div className={styles.grid}>
      {limits.map((l) => (
        <GuardrailMeter key={`${l.label}:${l.kind}`} limit={l} profile={profile} />
      ))}
    </div>
  );
}
