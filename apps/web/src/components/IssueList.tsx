// Shared rendering of validator issues: severity icon (named, A2), message,
// optional hint and limit metadata. Used inline in editors and in panels.

import { IxIcon, IxTypography } from "@siemens/ix-react";
import { iconError, iconInfo, iconWarning } from "@siemens/ix-icons/icons";
import type { Issue, Severity } from "@/domain/validator";
import styles from "./IssueList.module.css";

const ICON: Record<Severity, { name: string; color: string; label: string }> = {
  error: { name: iconError, color: "color-alarm", label: "Error" },
  warning: { name: iconWarning, color: "color-warning", label: "Warning" },
  info: { name: iconInfo, color: "color-info", label: "Information" },
};

export function SeverityIcon({ severity }: { severity: Severity }) {
  const i = ICON[severity];
  return <IxIcon name={i.name} color={i.color} size="16" aria-label={i.label} />;
}

export function IssueList({
  issues,
  showTarget = false,
  onSelect,
  empty,
}: {
  issues: Issue[];
  /** Prefix each message with the entity label. */
  showTarget?: boolean;
  /** Makes rows clickable (e.g. navigate to the entity). */
  onSelect?: (issue: Issue) => void;
  empty?: string;
}) {
  if (issues.length === 0) {
    return empty ? (
      <IxTypography format="body-sm" textColor="soft">
        {empty}
      </IxTypography>
    ) : null;
  }
  return (
    <ul className={styles.list}>
      {issues.map((issue) => {
        const content = (
          <>
            <SeverityIcon severity={issue.severity} />
            <span className={styles.text}>
              <IxTypography format="body-sm">
                {showTarget ? <strong>{issue.target.label}: </strong> : null}
                {issue.message}
              </IxTypography>
              {issue.hint ? (
                <IxTypography format="body-xs" textColor="soft">
                  {issue.hint}
                </IxTypography>
              ) : null}
            </span>
          </>
        );
        return (
          <li key={issue.id} className={styles.item}>
            {onSelect ? (
              <button type="button" className={styles.button} onClick={() => onSelect(issue)}>
                {content}
              </button>
            ) : (
              <div className={styles.row}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Compact counts, e.g. for list rows: "2 errors · 1 warning". */
export function IssueCounts({ issues }: { issues: Issue[] }) {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  if (!errors && !warnings) return null;
  return (
    <span className={styles.counts}>
      {errors ? (
        <span className={styles.count}>
          <SeverityIcon severity="error" />
          <IxTypography format="label-sm">{errors}</IxTypography>
        </span>
      ) : null}
      {warnings ? (
        <span className={styles.count}>
          <SeverityIcon severity="warning" />
          <IxTypography format="label-sm">{warnings}</IxTypography>
        </span>
      ) : null}
    </span>
  );
}
