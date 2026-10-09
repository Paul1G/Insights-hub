// Run history of a project (Dexie `deployments`, live).

import { useLiveQuery } from "dexie-react-hooks";
import { IxButton, IxSpinner, IxTypography } from "@siemens/ix-react";
import { iconArrowRight } from "@siemens/ix-icons/icons";
import { listRunRecords, summaryOf } from "@/deploy/store";
import { RunStatusChip } from "./chips";
import styles from "./deploy.module.css";

const MODE_LABELS = { deploy: "Deploy", sync: "Sync", rollback: "Rollback", copy: "Copy" } as const;

export function RunHistory({ projectId, activeRunId, onOpen }: { projectId: string; activeRunId?: string; onOpen: (runId: string) => void }) {
  const runs = useLiveQuery(async () => (await listRunRecords(projectId)).map(summaryOf), [projectId]);
  if (runs === undefined) {
    return (
      <div className={styles.row}>
        <IxSpinner size="small" />
        <IxTypography format="body-sm">Loading run history…</IxTypography>
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <IxTypography format="body-sm" textColor="soft">
        No deployments yet. Analyze a target and execute the plan to start one.
      </IxTypography>
    );
  }
  return (
    <ul className={styles.list} aria-label="Deployment runs">
      {runs.map((r) => (
        <li key={r.id} className={styles.listItem}>
          <RunStatusChip status={r.status} />
          <span className={styles.grow}>
            <IxTypography format="body" bold>
              {MODE_LABELS[r.mode]} → {r.connectionName} ({r.tenant})
            </IxTypography>
            <IxTypography format="body-xs" textColor="soft">
              {new Date(r.startedAt ?? r.createdAt).toLocaleString()}
              {r.summary
                ? ` · ${r.summary.create} new, ${r.summary.update} updates, ${r.summary.move} moves, ${r.summary.delete} deletions, ${r.summary.skip} unchanged, ${r.summary.blocked} blocked`
                : ""}
              {r.rollbackOf ? " · rollback of an earlier run" : ""}
            </IxTypography>
          </span>
          <IxButton
            variant={r.id === activeRunId ? "secondary" : "tertiary"}
            iconRight={iconArrowRight}
            disabled={r.id === activeRunId}
            onClick={() => onOpen(r.id)}
          >
            {r.id === activeRunId ? "Shown above" : "Open report"}
          </IxButton>
        </li>
      ))}
    </ul>
  );
}
