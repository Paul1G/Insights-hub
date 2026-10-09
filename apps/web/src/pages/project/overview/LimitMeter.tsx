// Part-of-whole meter (data-display/result-bar usage-meter): value vs. the
// per-tenant technical limit. The bar is decorative; the text carries the value.

import { IxTypography } from "@siemens/ix-react";
import { meterLevel } from "./navigation";
import styles from "./Overview.module.css";

export function LimitMeter({ label, value, limit }: { label: string; value: number; limit: number }) {
  const share = limit > 0 ? value / limit : 0;
  const pct = share * 100;
  const level = meterLevel(share);
  const shown = pct > 0 && pct < 0.1 ? "< 0.1" : pct.toFixed(pct < 10 ? 1 : 0);
  return (
    <div className={styles.meter}>
      <div className={styles.meterHead}>
        <IxTypography format="label" className={styles.wrap}>
          {label}
        </IxTypography>
        <span className={styles.meterValue}>
          <IxTypography format="label-sm" textColor="soft">
            {shown}% · {value.toLocaleString()} / {limit.toLocaleString()}
          </IxTypography>
        </span>
      </div>
      <div className={styles.track} aria-hidden="true">
        <div
          className={`${styles.fill} ${level === "alarm" ? styles.fillAlarm : level === "warning" ? styles.fillWarning : ""}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}
