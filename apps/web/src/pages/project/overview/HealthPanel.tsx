// Model Health: score, findings by severity with category, detail, concrete
// suggestion and a link to the target entity.

import { useState } from "react";
import { IxButton, IxChip, IxTypography } from "@siemens/ix-react";
import { iconArrowRight } from "@siemens/ix-icons/icons";
import type { HealthCategory, HealthSeverity } from "@/domain/health";
import { useHealth } from "@/state/hooks";
import { entityPath } from "./navigation";
import styles from "./Overview.module.css";

const SEVERITY: Record<HealthSeverity, { label: string; variant: "alarm" | "warning" | "info" }> = {
  high: { label: "High", variant: "alarm" },
  medium: { label: "Medium", variant: "warning" },
  low: { label: "Low", variant: "info" },
};

const CATEGORY: Record<HealthCategory, string> = {
  split: "Split",
  flatten: "Flatten",
  merge: "Merge",
  cleanup: "Clean up",
  billing: "Billing",
  reuse: "Reuse",
};

const PAGE = 15;

export function HealthPanel({ projectId, onNavigate }: { projectId: string; onNavigate(path: string): void }) {
  const health = useHealth();
  const [limit, setLimit] = useState(PAGE);
  const [severity, setSeverity] = useState<HealthSeverity | "all">("all");
  const findings = health.findings.filter((f) => severity === "all" || f.severity === severity);
  const scoreState = health.score >= 80 ? styles.good : health.score >= 50 ? styles.fair : styles.poor;

  return (
    <div className={styles.stack}>
      <div className={styles.scoreRow}>
        <div className={styles.score}>
          <IxTypography format="display-sm" className={scoreState}>
            {health.score}
          </IxTypography>
          <IxTypography format="body-sm" textColor="soft">
            of 100
          </IxTypography>
        </div>
        <div className={styles.filterChips} role="group" aria-label="Filter findings by severity">
          <IxButton variant={severity === "all" ? "secondary" : "tertiary"} aria-pressed={severity === "all" ? "true" : "false"} onClick={() => setSeverity("all")}>
            All ({health.findings.length})
          </IxButton>
          {(Object.keys(SEVERITY) as HealthSeverity[]).map((s) => (
            <IxButton
              key={s}
              variant={severity === s ? "secondary" : "tertiary"}
              aria-pressed={severity === s ? "true" : "false"}
              onClick={() => setSeverity(s)}
            >
              {SEVERITY[s].label} ({health.counts[s]})
            </IxButton>
          ))}
        </div>
      </div>
      {health.findings.length === 0 ? (
        <IxTypography format="body-sm" textColor="soft">
          No design smells found. The model follows the modelling recommendations.
        </IxTypography>
      ) : (
        <ul className={styles.findings}>
          {findings.slice(0, limit).map((f) => {
            const path = entityPath(projectId, f.target.kind, f.target.uid);
            return (
              <li key={f.id} className={styles.finding}>
                <div className={styles.findingHead}>
                  <IxChip variant={SEVERITY[f.severity].variant} outline>
                    {SEVERITY[f.severity].label}
                  </IxChip>
                  <IxChip variant="neutral" outline>
                    {CATEGORY[f.category]}
                  </IxChip>
                  <IxTypography format="label" className={styles.wrap}>
                    {f.title}
                  </IxTypography>
                </div>
                <IxTypography format="body-sm" className={styles.wrap}>
                  {f.detail}
                </IxTypography>
                <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
                  Suggestion: {f.suggestion}
                </IxTypography>
                {path ? (
                  <div>
                    <IxButton variant="tertiary" iconRight={iconArrowRight} onClick={() => onNavigate(path)}>
                      Open {f.target.label}
                    </IxButton>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {findings.length > limit ? (
        <div>
          <IxButton variant="tertiary" onClick={() => setLimit((l) => l + PAGE)}>
            Show more ({findings.length - limit} remaining)
          </IxButton>
        </div>
      ) : null}
    </div>
  );
}
