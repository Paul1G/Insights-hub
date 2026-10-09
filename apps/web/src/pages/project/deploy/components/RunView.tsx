// Live progress and report of a deployment run (also used for rollbacks and
// cross-tenant copies): per-phase progress, pause / cancel, retry, rollback,
// downloads and the per-step table with timings.

import { useMemo } from "react";
import { IxButton, IxMessageBar, IxProgressIndicator, IxTypography } from "@siemens/ix-react";
import { iconDownload, iconPause, iconPlay, iconRefresh, iconStop, iconUndo } from "@siemens/ix-icons/icons";
import { buildReport, reportToJson, reportToMarkdown } from "@/deploy/report";
import { PHASES, PHASE_LABELS, type DeploymentRun, type PlanStep } from "@/deploy/types";
import { RunStatusChip, Tiles } from "./chips";
import { downloadText } from "./download";
import { STATUS_LABELS } from "./labels";
import { StepTable } from "./StepTable";
import styles from "./deploy.module.css";


function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 120) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export interface RunActions {
  onPause?: () => void;
  onCancel?: () => void;
  /** Retry failed, conflicting and pending steps (resume). */
  onRetry?: () => void;
  onRollback?: () => void;
  onOpenStep: (step: PlanStep) => void;
}

export function RunView({ run, version, running, actions }: { run: DeploymentRun; version: number; running: boolean; actions: RunActions }) {
  const items = useMemo(() => new Map(run.state.items.map((i) => [i.stepId, i])), [run]);
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const i of run.state.items) out[i.status] = (out[i.status] ?? 0) + 1;
    return out;
    // `version` changes whenever the run is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, version]);
  const phases = useMemo(() => {
    const out = PHASES.map((p) => {
      const steps = run.plan.steps.filter((s) => s.phase === p);
      const done = steps.filter((s) => {
        const st = items.get(s.id)?.status;
        return st !== undefined && st !== "pending" && st !== "running";
      }).length;
      const failed = steps.filter((s) => {
        const st = items.get(s.id)?.status;
        return st === "failed" || st === "conflict" || st === "skipped-dependency";
      }).length;
      return { phase: p, total: steps.length, done, failed };
    }).filter((x) => x.total > 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, items, version]);
  const total = run.state.items.length;
  const finished = total - (counts.pending ?? 0) - (counts.running ?? 0);
  const problems = (counts.failed ?? 0) + (counts.conflict ?? 0) + (counts["skipped-dependency"] ?? 0);
  const canRetry = !running && (problems > 0 || (counts.pending ?? 0) > 0) && run.status !== "rolled-back";
  const canRollback = !running && run.mode !== "rollback" && !run.state.rolledBackBy && run.state.items.some((i) => i.status === "succeeded" || i.completedRequests > 0);
  const report = () => run.report ?? buildReport(run);
  const stamp = (run.startedAt ?? run.createdAt).replace(/[:.]/g, "-");
  const elapsed = run.startedAt ? (run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.startedAt) : 0;

  return (
    <div className={styles.stack}>
      <div className={styles.row}>
        <RunStatusChip status={run.status} />
        <IxTypography format="body-sm" textColor="soft">
          {run.mode === "rollback" ? "Rollback" : run.mode === "sync" ? "Sync" : run.mode === "copy" ? "Copy" : "Deploy"} to {run.connectionName} (tenant {run.tenant})
          {run.startedAt ? ` · started ${new Date(run.startedAt).toLocaleString()}` : ""}
          {elapsed ? ` · ${duration(elapsed)}` : ""}
        </IxTypography>
      </div>

      {run.status === "paused" && !running ? (
        <IxMessageBar type="info" persistent>
          Information — the run is paused or was interrupted. Resume continues with the remaining steps; steps that were interrupted are checked against the target first.
        </IxMessageBar>
      ) : null}
      {run.status === "completed-with-errors" || run.status === "failed" ? (
        <IxMessageBar type="warning" persistent>
          Warning — {problems} step{problems === 1 ? "" : "s"} did not succeed. Open a step to see the error or conflict, then retry or roll back.
        </IxMessageBar>
      ) : null}

      <div className={styles.tightStack}>
        {/* iX 5.0: ix-progress-indicator is not nameable (the inner progressbar
            gets no accessible name), so it is hidden from assistive technology
            and the value is carried as text next to it (conventions A8). */}
        <IxProgressIndicator aria-hidden="true" className={styles.progress} value={finished} max={Math.max(1, total)} label="Overall progress" status={problems ? "warning" : running ? "default" : "success"} />
        <IxTypography format="body-sm" role="status">
          {finished} of {total} steps finished{running ? " — running" : ""}
        </IxTypography>
      </div>

      <ul className={styles.list} aria-label="Progress by phase">
        {phases.map((p) => (
          <li key={p.phase} className={`${styles.listItem} ${styles.phaseRow}`}>
            <IxTypography format="label">{PHASE_LABELS[p.phase]}</IxTypography>
            <IxProgressIndicator aria-hidden="true" className={styles.progress} value={p.done} max={Math.max(1, p.total)} size="sm" status={p.failed ? "warning" : "default"} />
            <IxTypography format="body-sm" className={styles.nowrap}>
              {p.done}/{p.total}
              {p.failed ? ` · ${p.failed} failed` : ""}
            </IxTypography>
          </li>
        ))}
      </ul>

      <Tiles
        label="Steps by status"
        items={(["succeeded", "skipped", "failed", "conflict", "skipped-dependency", "pending", "rolled-back"] as const)
          .filter((s) => counts[s])
          .map((s) => ({ label: STATUS_LABELS[s], value: counts[s] ?? 0 }))}
      />

      <div className={styles.row}>
        {running && actions.onPause ? (
          <IxButton variant="secondary" icon={iconPause} onClick={actions.onPause}>
            Pause
          </IxButton>
        ) : null}
        {running && actions.onCancel ? (
          <IxButton variant="danger-secondary" icon={iconStop} onClick={actions.onCancel}>
            Cancel run
          </IxButton>
        ) : null}
        {canRetry && actions.onRetry ? (
          <IxButton variant="primary" icon={problems ? iconRefresh : iconPlay} onClick={actions.onRetry}>
            {problems ? "Retry failed & pending" : "Resume"}
          </IxButton>
        ) : null}
        {canRollback && actions.onRollback ? (
          <IxButton variant="danger-secondary" icon={iconUndo} onClick={actions.onRollback}>
            Roll back
          </IxButton>
        ) : null}
        <IxButton variant="secondary" icon={iconDownload} disabled={running} onClick={() => downloadText(`deployment-${stamp}.json`, reportToJson(report()), "application/json")}>
          Report (JSON)
        </IxButton>
        <IxButton variant="secondary" icon={iconDownload} disabled={running} onClick={() => downloadText(`deployment-${stamp}.md`, reportToMarkdown(report()), "text/markdown")}>
          Report (Markdown)
        </IxButton>
      </div>

      {run.state.warnings.length ? (
        <ul className={styles.list} aria-label="Run warnings">
          {run.state.warnings.map((w) => (
            <li key={w} className={styles.listItem}>
              <IxTypography format="body-sm" className={styles.text}>
                {w}
              </IxTypography>
            </li>
          ))}
        </ul>
      ) : null}

      {run.plan.notRevertible?.length ? (
        <section className={styles.stack} aria-label="Not rolled back">
          <h3 className={`typography-h5 ${styles.heading}`}>Not rolled back ({run.plan.notRevertible.length})</h3>
          <ul className={styles.list}>
            {run.plan.notRevertible.map((n) => (
              <li key={n.stepId} className={styles.listItem}>
                <span className={styles.grow}>
                  <IxTypography format="body-sm" bold>
                    {n.label}
                  </IxTypography>
                  <IxTypography format="body-sm" className={styles.text}>
                    {n.reason}
                  </IxTypography>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <StepTable plan={run.plan} items={items} version={version} onOpen={actions.onOpenStep} label="Run steps" initialFilter={problems ? "problems" : "changes"} />
    </div>
  );
}
