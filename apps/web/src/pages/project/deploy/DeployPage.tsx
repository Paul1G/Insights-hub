// Deploy the open project to a tenant: choose a connection and mode, analyze
// the target (read + plan), review the dry run, execute with live progress,
// and work with the run history (reports, resume / retry, rollback).

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  IxButton,
  IxCard,
  IxCardContent,
  IxCheckbox,
  IxMessageBar,
  IxNumberInput,
  IxRadio,
  IxRadioGroup,
  IxSpinner,
  IxTypography,
} from "@siemens/ix-react";
import { iconAnalyze, iconCloudUpload } from "@siemens/ix-icons/icons";
import { confirmDialog } from "@/components/dialogs";
import { errorMessage, notifyError, notifyInfo, notifySuccess } from "@/components/notify";
import { Page, Section } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, clampConcurrency, createRun, markInterrupted } from "@/deploy/executor";
import { emptyMapping } from "@/deploy/mapping";
import { executionGate, planDeployment, resolveReferences } from "@/deploy/planner";
import { browserRunServices } from "@/deploy/services";
import { useDeploySession, useLiveRun } from "@/deploy/session";
import { loadMapping, loadRun, saveRun } from "@/deploy/store";
import { createApiTransport } from "@/deploy/transport";
import type { DeploymentPlan, PlanStep } from "@/deploy/types";
import { useModelIndex, useProject, useValidation } from "@/state/hooks";
import { useSettingsStore } from "@/state/settingsStore";
import type { MappingRecord } from "@/storage/db";
import { readTenant } from "@/tenant/read";
import { ConnectionPicker } from "./components/ConnectionPicker";
import { useConnections } from "./components/useConnections";
import { DryRunView } from "./components/DryRunView";
import { RunHistory } from "./components/RunHistory";
import { RunView } from "./components/RunView";
import { RUN_STATUS_LABELS } from "./components/labels";
import { openStepDetails } from "./components/openStepDetails";
import styles from "./components/deploy.module.css";
import { useCatalogStore } from "@/state/catalogStore";

type Mode = "deploy" | "sync";

type Analysis =
  | { status: "idle" }
  | { status: "running"; message: string }
  | { status: "error"; message: string }
  | { status: "done"; plan: DeploymentPlan; mapping?: MappingRecord; connectionId: string; mode: Mode; revision: string };

export function DeployPage() {
  const project = useProject();
  const index = useModelIndex();
  const validation = useValidation();
  const guardrails = useSettingsStore((s) => s.guardrails);
  const navigate = useNavigate();
  const conns = useConnections();
  // The last target is remembered per project (a connection id is not a secret);
  // without one, the tenant the project is linked to is preselected.
  const connectionKey = `ams.deploy.connection.${project.id}`;
  const [connectionId, setConnectionIdState] = useState<string | undefined>(
    () => localStorage.getItem(connectionKey) ?? useCatalogStore.getState().links[project.id] ?? undefined,
  );
  const setConnectionId = (id: string | undefined) => {
    setConnectionIdState(id);
    if (id) localStorage.setItem(connectionKey, id);
    else localStorage.removeItem(connectionKey);
  };
  const [mode, setMode] = useState<Mode>("deploy");
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const [skipBlocked, setSkipBlocked] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis>({ status: "idle" });
  const [runId, setRunId] = useState<string>();
  const live = useLiveRun(runId);
  const connection = conns.connections.find((c) => c.id === connectionId);

  // Show a run of this project that is still going in this tab.
  useEffect(() => {
    const running = Object.values(useDeploySession.getState().runs).find((r) => r.run.projectId === project.id && r.running);
    if (running) setRunId(running.run.id);
  }, [project.id]);

  const plan = analysis.status === "done" ? analysis.plan : undefined;
  const stale = analysis.status === "done" && (analysis.revision !== project.updatedAt || analysis.connectionId !== connectionId || analysis.mode !== mode);
  const gate = useMemo(() => (plan ? executionGate(plan, skipBlocked) : undefined), [plan, skipBlocked]);

  async function analyze() {
    if (!connection) return;
    setAnalysis({ status: "running", message: "Reading the target tenant…" });
    try {
      const transport = createApiTransport(connection.id);
      const snapshot = await readTenant(transport, {
        tenant: connection.tenant,
        onProgress: (p) => setAnalysis({ status: "running", message: p.message }),
      });
      setAnalysis({ status: "running", message: "Checking referenced core and external types…" });
      const references = await resolveReferences(project, snapshot, transport);
      const mapping = await loadMapping(project.id, connection.id);
      setAnalysis({ status: "running", message: "Planning the deployment…" });
      const next = planDeployment(project, index, { tenant: connection.tenant, snapshot, mapping, references }, { mode, guardrails, validation });
      setAnalysis({ status: "done", plan: next, mapping, connectionId: connection.id, mode, revision: project.updatedAt });
    } catch (e) {
      setAnalysis({ status: "error", message: errorMessage(e) });
    }
  }

  async function execute() {
    if (analysis.status !== "done" || !connection || stale) return;
    const p = analysis.plan;
    if (!executionGate(p, skipBlocked).ok) return;
    const concurrent = Object.values(useDeploySession.getState().runs).find(
      (r) => r.running && r.run.projectId === project.id && r.run.connectionId === connection.id,
    );
    if (concurrent) {
      notifyInfo("Another run of this project to the same connection is still in progress; wait for it to finish.");
      return;
    }
    const runnable = p.steps.filter((s) => !s.blocked && s.op !== "skip");
    const destructive = runnable.filter((s) => s.destructive).length;
    const deletions = runnable.filter((s) => s.op === "delete").length;
    const ok = await confirmDialog({
      title: `Deploy to ${connection.name}?`,
      message: `${runnable.length} step(s) will change tenant ${connection.tenant}${connection.authMode === "simulator" ? " (simulator)" : ""}. A snapshot of the project is taken first.`,
      details: (
        <ul className={styles.list}>
          <li className={styles.listItem}>
            <IxTypography format="body-sm">
              {p.summary.create} new · {p.summary.update} updates · {p.summary.move} moves · {p.summary.delete} deletions
            </IxTypography>
          </li>
          {destructive ? (
            <li className={styles.listItem}>
              <IxTypography format="body-sm">{destructive} destructive step(s) remove or replace data in the tenant.</IxTypography>
            </li>
          ) : null}
          {p.summary.blocked ? (
            <li className={styles.listItem}>
              <IxTypography format="body-sm">{p.summary.blocked} blocked step(s) are skipped.</IxTypography>
            </li>
          ) : null}
        </ul>
      ),
      confirmLabel: deletions ? "Continue" : "Deploy now",
      danger: destructive > 0,
    });
    if (!ok) return;
    if (deletions) {
      const sure = await confirmDialog({
        title: "Confirm physical deletions",
        message: `${deletions} object(s) that this project deployed earlier will be deleted physically from tenant ${connection.tenant}. Deleted objects and their data cannot be restored, not even by a rollback.`,
        typedConfirmation: connection.tenant,
        confirmLabel: "Delete physically and deploy",
        danger: true,
      });
      if (!sure) return;
    }
    const run = createRun({
      plan: p,
      projectId: project.id,
      connectionId: connection.id,
      connectionName: connection.name,
      mode: p.mode === "sync" ? "sync" : "deploy",
      concurrency,
      skipBlocked,
    });
    await saveRun(run);
    setRunId(run.id);
    try {
      const done = await useDeploySession
        .getState()
        .start(run, analysis.mapping ?? emptyMapping(project.id, connection.id, connection.tenant), browserRunServices(connection.id, project.id));
      if (done.status === "completed") notifySuccess(`Deployment to ${connection.name} completed.`);
      else if (done.status === "paused" || done.status === "cancelled") notifyInfo(`Deployment ${done.status}.`);
      else notifyError(`${RUN_STATUS_LABELS[done.status]} — open the failed steps for details.`, "Deployment finished");
      setAnalysis({ status: "idle" });
    } catch (e) {
      notifyError(e, "Deployment could not run");
    }
  }

  async function openRun(id: string) {
    try {
      const session = useDeploySession.getState();
      if (!session.runs[id]) {
        const run = await loadRun(id);
        if (!run) return;
        markInterrupted(run);
        const mapping = (await loadMapping(run.projectId, run.connectionId)) ?? emptyMapping(run.projectId, run.connectionId, run.tenant);
        session.adopt(run, mapping, browserRunServices(run.connectionId, run.projectId));
      }
      setRunId(id);
    } catch (e) {
      notifyError(e, "The run could not be opened");
    }
  }

  async function retry(acceptDriftFor?: string[]) {
    if (!runId) return;
    try {
      const r = await useDeploySession.getState().retry(runId, acceptDriftFor);
      if (r) notifyInfo(`Run ${RUN_STATUS_LABELS[r.status].toLowerCase()}.`);
    } catch (e) {
      notifyError(e, "Retry failed");
    }
  }

  async function rollback() {
    if (!live.run) return;
    const ok = await confirmDialog({
      title: "Roll back this run?",
      message:
        "Objects created by the run are deleted, updated asset values, moves, locations and file assignments are restored from the state read before each step. Type definition changes (variable renames, additions, deletions), replaced file contents and deletions cannot be reverted and are listed in the rollback report.",
      confirmLabel: "Roll back",
      danger: true,
    });
    if (!ok) return;
    try {
      const rb = await useDeploySession.getState().rollback(live.run.id);
      if (rb) {
        setRunId(rb.id);
        if (rb.status === "completed") notifySuccess("Rollback completed.");
        else notifyError(`${RUN_STATUS_LABELS[rb.status]} — see the rollback report.`, "Rollback finished");
      }
    } catch (e) {
      notifyError(e, "Rollback failed");
    }
  }

  async function cancelRun() {
    if (!runId) return;
    const ok = await confirmDialog({
      title: "Cancel the run?",
      message: "Steps that are running finish; all remaining steps stay pending. You can resume the run later from the history.",
      confirmLabel: "Cancel run",
      cancelLabel: "Keep running",
    });
    if (ok) useDeploySession.getState().cancel(runId);
  }

  const openDryRunStep = (step: PlanStep) => {
    if (plan) openStepDetails({ step, plan });
  };

  const openRunStep = (step: PlanStep) => {
    const run = live.run;
    if (!run) return;
    const item = run.state.items.find((i) => i.stepId === step.id);
    openStepDetails({
      step,
      plan: run.plan,
      item,
      onRetry: live.running ? undefined : () => void retry([step.id]),
      onSkip: live.running ? undefined : () => useDeploySession.getState().skip(run.id, step.id),
    });
  };

  const busy = analysis.status === "running" || live.running;

  return (
    <Page>
      {/* PageHeader renders the route's single <h1>. */}
      <PageHeader
        title="Deploy"
        subtitle={`Deploy “${project.name}” to a tenant: analyze the target, review the dry run, then execute.`}
      />

      <Section title="Target">
        <IxCard variant="outline" className={styles.card} passive>
          <IxCardContent>
            <div className={styles.cardBody}>
              <div className={styles.formGrid}>
                <ConnectionPicker
                  label="Connection"
                  state={conns}
                  value={connectionId}
                  disabled={busy}
                  onChange={(c) => {
                    setConnectionId(c?.id);
                    setAnalysis({ status: "idle" });
                  }}
                />
                <div className={styles.stack}>
                  <IxRadioGroup
                    label="Mode"
                    value={mode}
                    onValueChange={(e) => {
                      setMode(e.detail === "sync" ? "sync" : "deploy");
                      setAnalysis({ status: "idle" });
                    }}
                  >
                    <IxRadio label="Deploy — create and update; never deletes anything in the tenant" value="deploy" name="deploy-mode" checked={mode === "deploy"} disabled={busy} />
                    <IxRadio label="Sync — additionally deletes physically what this project deployed earlier and no longer contains" value="sync" name="deploy-mode" checked={mode === "sync"} disabled={busy} />
                  </IxRadioGroup>
                  {mode === "sync" ? (
                    <IxMessageBar type="warning" persistent>
                      Warning — sync mode deletes assets, types and files physically (reverse dependency order). Only objects that this project deployed to this connection before are deleted; objects that exist only in the target are never touched. You must type the tenant name to confirm.
                    </IxMessageBar>
                  ) : null}
                  <IxNumberInput
                    label="Parallel steps per level"
                    helperText={`1–${MAX_CONCURRENCY}; the backend additionally limits concurrent calls per connection.`}
                    min={1}
                    max={MAX_CONCURRENCY}
                    value={concurrency}
                    disabled={busy}
                    showStepperButtons
                    onValueChange={(e) => setConcurrency(clampConcurrency(Number(e.detail)))}
                  />
                  <IxCheckbox
                    label="Skip blocked steps and everything that depends on them"
                    checked={skipBlocked}
                    disabled={busy}
                    onCheckedChange={(e) => setSkipBlocked(e.detail)}
                  />
                </div>
              </div>
              <div className={styles.row}>
                <IxButton icon={iconAnalyze} disabled={!connection || busy} loading={analysis.status === "running"} onClick={() => void analyze()}>
                  Analyze target
                </IxButton>
                {analysis.status === "running" ? (
                  <span className={styles.row}>
                    <IxSpinner size="small" />
                    <IxTypography format="body-sm">{analysis.message}</IxTypography>
                  </span>
                ) : null}
              </div>
              {analysis.status === "error" ? (
                <IxMessageBar type="alarm" persistent>
                  Error — the target could not be analyzed: {analysis.message}
                </IxMessageBar>
              ) : null}
            </div>
          </IxCardContent>
        </IxCard>
      </Section>

      {plan ? (
        <Section
          title="Dry run"
          actions={
            <IxButton icon={iconCloudUpload} disabled={!gate?.ok || stale || busy} onClick={() => void execute()}>
              Execute
            </IxButton>
          }
        >
          {stale ? (
            <IxMessageBar type="warning" persistent>
              Warning — the project, the connection or the mode changed after the analysis. Analyze the target again before executing.
            </IxMessageBar>
          ) : null}
          {gate && !gate.ok ? (
            <ul className={styles.list} aria-label="Why the plan cannot be executed">
              {gate.reasons.map((r) => (
                <li key={r} className={styles.listItem}>
                  <IxTypography format="body-sm">{r}</IxTypography>
                </li>
              ))}
            </ul>
          ) : null}
          <DryRunView plan={plan} onOpenStep={openDryRunStep} onOpenValidation={() => navigate(`/p/${project.id}`)} />
        </Section>
      ) : null}

      {live.run ? (
        <Section title={live.run.mode === "rollback" ? "Rollback" : "Run"}>
          {live.error ? (
            <IxMessageBar type="alarm" persistent>
              Error — {live.error}
            </IxMessageBar>
          ) : null}
          <RunView
            run={live.run}
            version={live.version}
            running={live.running}
            actions={{
              onPause: () => runId && useDeploySession.getState().pause(runId),
              onCancel: () => void cancelRun(),
              onRetry: () => void retry(),
              onRollback: () => void rollback(),
              onOpenStep: openRunStep,
            }}
          />
        </Section>
      ) : null}

      <Section title="Run history">
        <RunHistory projectId={project.id} activeRunId={runId} onOpen={(id) => void openRun(id)} />
      </Section>
    </Page>
  );
}
