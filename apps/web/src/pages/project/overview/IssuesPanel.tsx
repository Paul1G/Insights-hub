// Validation issues with severity filter and search; each issue opens its entity.

import { useMemo, useState } from "react";
import { IxButton, IxIcon, IxInput, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { iconSearch } from "@siemens/ix-icons/icons";
import { IssueList } from "@/components/IssueList";
import type { Severity } from "@/domain/validator";
import { useValidation } from "@/state/hooks";
import { entityPath } from "./navigation";
import styles from "./Overview.module.css";

const PAGE = 100;

export function IssuesPanel({ projectId, onNavigate }: { projectId: string; onNavigate(path: string): void }) {
  const validation = useValidation();
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const issues = useMemo(() => {
    const q = query.trim().toLowerCase();
    return validation.issues.filter(
      (i) =>
        (severity === "all" || i.severity === severity) &&
        (!q || i.message.toLowerCase().includes(q) || i.target.label.toLowerCase().includes(q) || i.code.toLowerCase().includes(q)),
    );
  }, [validation.issues, severity, query]);

  return (
    <div className={styles.stack}>
      <search aria-label="Filter validation issues" className={styles.toolbar}>
        <IxSelect
          label="Severity"
          value={severity}
          onValueChange={(e) => {
            const v = e.detail;
            if (v === "all" || v === "error" || v === "warning" || v === "info") {
              setSeverity(v);
              setLimit(PAGE);
            }
          }}
        >
          <IxSelectItem value="all" label={`All (${validation.issues.length})`} />
          <IxSelectItem value="error" label={`Errors (${validation.errors})`} />
          <IxSelectItem value="warning" label={`Warnings (${validation.warnings})`} />
          <IxSelectItem value="info" label={`Information (${validation.infos})`} />
        </IxSelect>
        <IxInput
          label="Search issues"
          value={query}
          placeholder="Message, entity or code"
          onValueChange={(e) => {
            setQuery(e.detail);
            setLimit(PAGE);
          }}
        >
          <IxIcon slot="start" name={iconSearch} size="16" aria-hidden="true" />
        </IxInput>
      </search>
      <IxTypography format="body-xs" textColor="soft" role="status">
        {issues.length.toLocaleString()} issue{issues.length === 1 ? "" : "s"} · errors block deployment
      </IxTypography>
      <IssueList
        issues={issues.slice(0, limit)}
        showTarget
        onSelect={(issue) => {
          const path = entityPath(projectId, issue.target.kind, issue.target.uid);
          if (path) onNavigate(path);
        }}
        empty={validation.issues.length ? "No issues match the filter." : "No validation issues — the model is ready to deploy."}
      />
      {issues.length > limit ? (
        <div>
          <IxButton variant="tertiary" onClick={() => setLimit((l) => l + PAGE)}>
            Show more ({(issues.length - limit).toLocaleString()} remaining)
          </IxButton>
        </div>
      ) : null}
    </div>
  );
}
