// Cross-tenant copy wizard: source → selection → target & mapping → dry run
// → deploy. The source tenant is read into an in-memory project, the
// selection (with its dependency closure) is extracted, conflicts with the
// target are resolved per type (rename / map to existing), and the result is
// planned and executed with the regular deployment engine. The copied model
// can be saved as a local project together with its target mapping.

import { useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router";
import {
  IxButton,
  IxCard,
  IxCardContent,
  IxCheckbox,
  IxMessageBar,
  IxNumberInput,
  IxSpinner,
  IxTypography,
  IxWorkflowStep,
  IxWorkflowSteps,
} from "@siemens/ix-react";
import { iconAnalyze, iconArrowLeft, iconArrowRight, iconCloudUpload, iconProject } from "@siemens/ix-icons/icons";
import { api, type ConnectionSummary } from "@/api/client";
import { confirmDialog } from "@/components/dialogs";
import { errorMessage, notifyError, notifyInfo, notifySuccess } from "@/components/notify";
import { Page, Section } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { applyRunBaselines, runChangelogSummary } from "@/deploy/baselines";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, clampConcurrency, createRun } from "@/deploy/executor";
import { emptyMapping, mappingId } from "@/deploy/mapping";
import { executionGate, planDeployment, referencedTypeIds, resolveReferences, type ReferenceLookup } from "@/deploy/planner";
import type { RunServices } from "@/deploy/run";
import { useDeploySession, useLiveRun } from "@/deploy/session";
import { MemoryPersistence, saveMapping, saveRun } from "@/deploy/store";
import { createApiTransport } from "@/deploy/transport";
import type { DeploymentPlan, PlanStep } from "@/deploy/types";
import { touch } from "@/domain/ops";
import type { Project } from "@/domain/model";
import { ModelIndex } from "@/domain/resolve";
import { useSettingsStore } from "@/state/settingsStore";
import { saveProject } from "@/storage/repository";
import {
  applyResolutions,
  compatibilityProblems,
  extractProject,
  fetchFileContents,
  findConflicts,
  renameProblems,
  selectionClosure,
  type Resolution,
} from "@/tenant/copy";
import { MemoryBlobStore, persistBlobs, snapshotToProject, type SnapshotConversion } from "@/tenant/convert";
import { allTypes, readTenant, type TenantSnapshot } from "@/tenant/read";
import { ConnectionPicker } from "../project/deploy/components/ConnectionPicker";
import { useConnections } from "../project/deploy/components/useConnections";
import { Tiles } from "../project/deploy/components/chips";
import { DryRunView } from "../project/deploy/components/DryRunView";
import { RunView } from "../project/deploy/components/RunView";
import { openStepDetails } from "../project/deploy/components/openStepDetails";
import styles from "../project/deploy/components/deploy.module.css";
import { CopyConflicts, type ConflictRowState } from "./CopyConflicts";
import { CopySelection, type SelectionState } from "./CopySelection";
import copyStyles from "./copy.module.css";

// Screen-reader-only text (conventions A10, inline form).
const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const STEPS = ["Source", "Selection", "Target & mapping", "Dry run", "Deploy"] as const;

type Busy = { message: string } | undefined;

interface SourceData {
  connection: ConnectionSummary;
  snapshot: TenantSnapshot;
  conversion: SnapshotConversion;
  index: ModelIndex;
}

interface TargetData {
  connection: ConnectionSummary;
  snapshot: TenantSnapshot;
}

interface Prepared {
  project: Project;
  plan: DeploymentPlan;
  blobs: MemoryBlobStore;
  warnings: string[];
}

export function CrossTenantCopyPage() {
  const navigate = useNavigate();
  const conns = useConnections();
  const coreIndex = useSettingsStore((s) => s.coreIndex);
  const guardrails = useSettingsStore((s) => s.guardrails);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<Busy>();
  const [error, setError] = useState<string>();

  const [sourceId, setSourceId] = useState<string>();
  const [includeAssets, setIncludeAssets] = useState(true);
  const [source, setSource] = useState<SourceData>();
  const [selection, setSelection] = useState<SelectionState>({ aspectTypes: new Set(), assetTypes: new Set(), assetRoots: new Set() });
  const [copyContents, setCopyContents] = useState(true);
  const [targetId, setTargetId] = useState<string>();
  const [target, setTarget] = useState<TargetData>();
  const [resolutions, setResolutions] = useState<Map<string, Resolution>>(new Map());
  const [prepared, setPrepared] = useState<Prepared>();
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const [skipBlocked, setSkipBlocked] = useState(false);
  const [runId, setRunId] = useState<string>();
  const [runContext, setRunContext] = useState<{ persistence: MemoryPersistence; project: Project; blobs: MemoryBlobStore; connection: ConnectionSummary }>();
  const [saved, setSaved] = useState<string>();
  const live = useLiveRun(runId);

  const sourceConnection = conns.connections.find((c) => c.id === sourceId);
  const targetConnection = conns.connections.find((c) => c.id === targetId);

  const closure = useMemo(() => (source ? selectionClosure(source.index, selection) : undefined), [source, selection]);
  const extracted = useMemo(
    () => (source && closure ? extractProject(source.conversion.project, closure, `Copy of ${source.connection.tenant} → ${targetConnection?.tenant ?? "target"}`) : undefined),
    [source, closure, targetConnection?.tenant],
  );
  const extractedIndex = useMemo(() => (extracted ? new ModelIndex(extracted, coreIndex) : undefined), [extracted, coreIndex]);

  const conflictRows = useMemo<ConflictRowState[]>(() => {
    if (!extracted || !extractedIndex || !target) return [];
    return findConflicts(extracted, target.connection.tenant, target.snapshot).map((c) => {
      const resolution: Resolution = resolutions.get(c.uid) ?? { action: "rename", idSuffix: `${c.idSuffix}_copy`, name: `${c.name}_copy` };
      const all = new Map(resolutions);
      all.set(c.uid, resolution);
      const problems =
        resolution.action === "map"
          ? compatibilityProblems(c.kind, c.uid, resolution.targetId, extracted, extractedIndex, target.snapshot, all)
          : renameProblems(c.kind, c.uid, resolution, extracted, target.connection.tenant, target.snapshot, all);
      return { conflict: c, resolution, problems };
    });
  }, [extracted, extractedIndex, target, resolutions]);

  const effectiveResolutions = useMemo(() => new Map(conflictRows.map((r) => [r.conflict.uid, r.resolution])), [conflictRows]);
  const resolved = useMemo(() => (extracted ? applyResolutions(extracted, effectiveResolutions) : undefined), [extracted, effectiveResolutions]);
  const missingRefs = useMemo(() => {
    if (!resolved || !target) return [];
    const refs = referencedTypeIds(resolved);
    const assetIds = new Set(allTypes(target.snapshot.assetTypes).map((t) => t.id.toLowerCase()));
    const aspectIds = new Set(allTypes(target.snapshot.aspectTypes).map((t) => t.id.toLowerCase()));
    return [
      ...refs.assetTypes.filter((id) => !assetIds.has(id.toLowerCase())).map((id) => `Asset type ${id}`),
      ...refs.aspectTypes.filter((id) => !aspectIds.has(id.toLowerCase())).map((id) => `Aspect type ${id}`),
    ];
  }, [resolved, target]);

  const resolutionsValid = conflictRows.every((r) => r.problems.length === 0);
  const selectedCount = (closure?.aspectTypes.size ?? 0) + (closure?.assetTypes.size ?? 0) + (closure?.assets.size ?? 0);

  async function withBusy(message: string, fn: () => Promise<void>) {
    setBusy({ message });
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  const readSource = () =>
    withBusy("Reading the source tenant…", async () => {
      if (!sourceConnection) return;
      const transport = createApiTransport(sourceConnection.id);
      const snapshot = await readTenant(transport, {
        tenant: sourceConnection.tenant,
        includeAssets,
        includeFiles: true,
        onProgress: (p) => setBusy({ message: p.message }),
      });
      const conversion = await snapshotToProject(snapshot, { name: `Source ${sourceConnection.tenant}`, connectionId: sourceConnection.id });
      setSource({ connection: sourceConnection, snapshot, conversion, index: new ModelIndex(conversion.project, coreIndex) });
      setSelection({ aspectTypes: new Set(), assetTypes: new Set(), assetRoots: new Set() });
      setTarget(undefined);
      setPrepared(undefined);
      setResolutions(new Map());
    });

  const readTarget = () =>
    withBusy("Reading the target tenant…", async () => {
      if (!targetConnection) return;
      const snapshot = await readTenant(createApiTransport(targetConnection.id), {
        tenant: targetConnection.tenant,
        onProgress: (p) => setBusy({ message: p.message }),
      });
      setTarget({ connection: targetConnection, snapshot });
      setPrepared(undefined);
      setResolutions(new Map());
    });

  const prepare = () =>
    withBusy("Preparing the dry run…", async () => {
      if (!source || !target || !resolved) return;
      const project = structuredClone(resolved);
      const blobs = new MemoryBlobStore();
      const warnings: string[] = [];
      if (copyContents && project.files.length) {
        const sourceIds = new Map([...source.conversion.uids.files].map(([tenantId, uid]) => [uid, tenantId]));
        warnings.push(
          ...(await fetchFileContents(project.files, (uid) => sourceIds.get(uid), createApiTransport(source.connection.id), blobs, (done, total, name) =>
            setBusy({ message: name ? `Downloading ${name} (${done + 1} of ${total})…` : "Files downloaded." }),
          )),
        );
      }
      setBusy({ message: "Checking referenced core and external types…" });
      const transport = createApiTransport(target.connection.id);
      const references: ReferenceLookup = await resolveReferences(project, target.snapshot, transport);
      setBusy({ message: "Planning…" });
      const index = new ModelIndex(project, coreIndex);
      const plan = planDeployment(project, index, { tenant: target.connection.tenant, snapshot: target.snapshot, references }, { mode: "deploy", guardrails });
      setPrepared({ project, plan, blobs, warnings });
      setStep(3);
    });

  async function execute() {
    if (!prepared || !target) return;
    const { plan, project, blobs } = prepared;
    if (!executionGate(plan, skipBlocked).ok) return;
    const runnable = plan.steps.filter((s) => !s.blocked && s.op !== "skip");
    const ok = await confirmDialog({
      title: `Copy into ${target.connection.name}?`,
      message: `${runnable.length} step(s) will change tenant ${target.connection.tenant}: ${plan.summary.create} new, ${plan.summary.update} updates, ${plan.summary.move} moves.`,
      confirmLabel: "Copy now",
      danger: runnable.some((s) => s.destructive),
    });
    if (!ok) return;
    const persistence = new MemoryPersistence();
    const mapping = emptyMapping(project.id, target.connection.id, target.connection.tenant);
    const services: RunServices = {
      transport: createApiTransport(target.connection.id),
      persistence,
      loadBlob: async (id) => blobs.get(id),
      audit: (entry) => api.audit.append(entry),
      applyBaselines: async (run) => {
        applyRunBaselines(project, run);
        touch(project, runChangelogSummary(run));
      },
    };
    const run = createRun({
      plan,
      projectId: project.id,
      connectionId: target.connection.id,
      connectionName: target.connection.name,
      mode: "copy",
      concurrency,
      skipBlocked,
    });
    setRunContext({ persistence, project, blobs, connection: target.connection });
    setRunId(run.id);
    setStep(4);
    try {
      const done = await useDeploySession.getState().start(run, mapping, services);
      if (done.status === "completed") notifySuccess(`Copy into ${target.connection.name} completed.`);
      else notifyInfo(`Copy finished: ${done.status}.`);
    } catch (e) {
      notifyError(e, "The copy could not run");
    }
  }

  async function saveAsProject() {
    if (!runContext || !live.run) return;
    try {
      const project = runContext.project;
      await persistBlobs(project, runContext.blobs);
      await saveProject(project);
      const mapping = runContext.persistence.mapping ?? emptyMapping(project.id, runContext.connection.id, runContext.connection.tenant);
      await saveMapping({ ...mapping, id: mappingId(project.id, runContext.connection.id), projectId: project.id });
      await saveRun(live.run);
      setSaved(project.id);
      notifySuccess(`Saved as project “${project.name}”.`);
      navigate(`/p/${project.id}`);
    } catch (e) {
      notifyError(e, "The project could not be saved");
    }
  }

  const openRunStep = (s: PlanStep) => {
    const run = live.run;
    if (!run) return;
    openStepDetails({
      step: s,
      plan: run.plan,
      item: run.state.items.find((i) => i.stepId === s.id),
      onRetry: live.running ? undefined : () => void useDeploySession.getState().retry(run.id, [s.id]),
      onSkip: live.running ? undefined : () => useDeploySession.getState().skip(run.id, s.id),
    });
  };

  const canNext = [
    !!source,
    selectedCount > 0,
    !!target && resolutionsValid,
    false,
    false,
  ][step];

  const stepStatus = (i: number) => (i < step ? "done" : "open") as "done" | "open";
  const isBusy = !!busy || live.running;

  return (
    <Page>
      {/* PageHeader renders the route's single <h1>. */}
      <PageHeader title="Cross-tenant copy" subtitle="Copy aspect types, asset types and asset subtrees from one tenant into another — with conflict resolution and a dry run." />

      <div className={copyStyles.steps} role="group" aria-label="Copy progress">
        <IxWorkflowSteps selectedIndex={step}>
          {STEPS.map((label, i) => (
            <IxWorkflowStep key={label} status={stepStatus(i)}>
              {label}
              <span style={VISUALLY_HIDDEN}>
                {` — step ${i + 1} of ${STEPS.length}, ${i < step ? "completed" : i === step ? "current step" : "not started"}`}
              </span>
            </IxWorkflowStep>
          ))}
        </IxWorkflowSteps>
      </div>

      {busy ? (
        <div className={styles.row}>
          <IxSpinner size="small" />
          <IxTypography format="body-sm">{busy.message}</IxTypography>
        </div>
      ) : null}
      {error ? (
        <IxMessageBar type="alarm" persistent>
          Error — {error}
        </IxMessageBar>
      ) : null}

      {step === 0 ? (
        <Section title="Source tenant">
          <IxCard variant="outline" className={styles.card} passive>
            <IxCardContent>
              <div className={styles.cardBody}>
                <div className={styles.formGrid}>
                  <ConnectionPicker
                    label="Source connection"
                    state={conns}
                    value={sourceId}
                    disabled={isBusy}
                    onChange={(c) => {
                      setSourceId(c?.id);
                      setSource(undefined);
                    }}
                  />
                  <IxCheckbox label="Read assets (needed to copy asset subtrees)" checked={includeAssets} disabled={isBusy} onCheckedChange={(e) => setIncludeAssets(e.detail)} />
                </div>
                <div className={styles.row}>
                  <IxButton icon={iconAnalyze} disabled={!sourceConnection || isBusy} onClick={() => void readSource()}>
                    Read source tenant
                  </IxButton>
                </div>
                {source ? (
                  <>
                    {source.snapshot.partialFailures.length ? (
                      <IxMessageBar type="warning" persistent>
                        Warning — {source.snapshot.partialFailures.length} page(s) of the source could not be read; the selection may be incomplete.
                      </IxMessageBar>
                    ) : null}
                    <Tiles
                      label="Source contents"
                      items={[
                        { label: "Aspect types", value: source.conversion.project.aspectTypes.length },
                        { label: "Asset types", value: source.conversion.project.assetTypes.length },
                        { label: "Assets", value: Math.max(0, source.conversion.project.assets.length - 1) },
                        { label: "Files", value: source.conversion.project.files.length },
                      ]}
                    />
                  </>
                ) : null}
              </div>
            </IxCardContent>
          </IxCard>
        </Section>
      ) : null}

      {step === 1 && source && closure ? (
        <Section title="Selection">
          <CopySelection project={source.conversion.project} index={source.index} selection={selection} closure={closure} includeAssets={source.snapshot.includes.assets} onChange={setSelection} />
          <IxTypography format="body-sm" role="status">
            {closure.aspectTypes.size} aspect types, {closure.assetTypes.size} asset types, {closure.assets.size} assets and {closure.files.size} files will be copied
            {closure.added.aspectTypes || closure.added.assetTypes ? ` (${closure.added.aspectTypes + closure.added.assetTypes} types added automatically as dependencies)` : ""}.
          </IxTypography>
          {closure.files.size ? (
            <IxCheckbox label={`Copy the contents of ${closure.files.size} file(s) (downloaded from the source, up to 5 MB each)`} checked={copyContents} onCheckedChange={(e) => setCopyContents(e.detail)} />
          ) : null}
        </Section>
      ) : null}

      {step === 2 && source ? (
        <Section title="Target & mapping">
          <IxCard variant="outline" className={styles.card} passive>
            <IxCardContent>
              <div className={styles.cardBody}>
                <ConnectionPicker
                  label="Target connection"
                  state={conns}
                  value={targetId}
                  excludeId={source.connection.id}
                  disabled={isBusy}
                  onChange={(c) => {
                    setTargetId(c?.id);
                    setTarget(undefined);
                  }}
                />
                <div className={styles.row}>
                  <IxButton icon={iconAnalyze} disabled={!targetConnection || isBusy} onClick={() => void readTarget()}>
                    Read target tenant
                  </IxButton>
                </div>
              </div>
            </IxCardContent>
          </IxCard>
          {target ? (
            <>
              <section className={styles.stack} aria-label="Conflicts">
                <h3 className={`typography-h5 ${styles.heading}`}>Conflicts ({conflictRows.length})</h3>
                <CopyConflicts
                  tenant={target.connection.tenant}
                  rows={conflictRows}
                  targetTypes={{
                    aspectType: target.snapshot.aspectTypes.tenant.map((t) => ({ id: t.id, name: t.name })),
                    assetType: target.snapshot.assetTypes.tenant.map((t) => ({ id: t.id, name: t.name })),
                  }}
                  onChange={(uid, r) => setResolutions((prev) => new Map(prev).set(uid, r))}
                />
              </section>
              <section className={styles.stack} aria-label="Referenced types">
                <h3 className={`typography-h5 ${styles.heading}`}>Referenced core and shared types</h3>
                {missingRefs.length ? (
                  <IxMessageBar type="warning" persistent>
                    Warning — not found in the target's lists: {missingRefs.join(", ")}. They are looked up individually in the dry run; types that do not exist block the steps using them.
                  </IxMessageBar>
                ) : (
                  <IxTypography format="body-sm" textColor="soft">
                    All referenced core and shared types exist in the target.
                  </IxTypography>
                )}
              </section>
            </>
          ) : null}
        </Section>
      ) : null}

      {step === 3 && prepared ? (
        <Section
          title="Dry run"
          actions={
            <IxButton icon={iconCloudUpload} disabled={!executionGate(prepared.plan, skipBlocked).ok || isBusy} onClick={() => void execute()}>
              Copy into target
            </IxButton>
          }
        >
          {prepared.warnings.length ? (
            <IxMessageBar type="warning" persistent>
              Warning — {prepared.warnings.join(" ")}
            </IxMessageBar>
          ) : null}
          <div className={styles.formGrid}>
            <IxNumberInput
              label="Parallel steps per level"
              helperText={`1–${MAX_CONCURRENCY}`}
              min={1}
              max={MAX_CONCURRENCY}
              value={concurrency}
              showStepperButtons
              onValueChange={(e) => setConcurrency(clampConcurrency(Number(e.detail)))}
            />
            <IxCheckbox label="Skip blocked steps and everything that depends on them" checked={skipBlocked} onCheckedChange={(e) => setSkipBlocked(e.detail)} />
          </div>
          {executionGate(prepared.plan, skipBlocked).reasons.map((r) => (
            <IxTypography key={r} format="body-sm">
              {r}
            </IxTypography>
          ))}
          <DryRunView plan={prepared.plan} onOpenStep={(s) => openStepDetails({ step: s, plan: prepared.plan })} />
        </Section>
      ) : null}

      {step === 4 && live.run ? (
        <Section
          title="Deploy"
          actions={
            runContext && !live.running ? (
              <IxButton icon={iconProject} disabled={!!saved} onClick={() => void saveAsProject()}>
                Save as local project
              </IxButton>
            ) : undefined
          }
        >
          <RunView
            run={live.run}
            version={live.version}
            running={live.running}
            actions={{
              onPause: () => runId && useDeploySession.getState().pause(runId),
              onCancel: () => runId && useDeploySession.getState().cancel(runId),
              onRetry: () => runId && void useDeploySession.getState().retry(runId),
              onOpenStep: openRunStep,
            }}
          />
          {!live.running ? (
            <IxTypography format="body-sm" textColor="soft">
              Saving keeps the copied model as a local project together with the mapping for {runContext?.connection.name}, so later changes can be redeployed to the target as updates.
            </IxTypography>
          ) : null}
        </Section>
      ) : null}

      <div className={copyStyles.footer}>
        <IxButton variant="secondary" icon={iconArrowLeft} disabled={step === 0 || step === 4 || isBusy} onClick={() => setStep((s) => Math.max(0, s - 1))}>
          Back
        </IxButton>
        {step < 2 ? (
          <IxButton iconRight={iconArrowRight} disabled={!canNext || isBusy} onClick={() => setStep((s) => s + 1)}>
            Next
          </IxButton>
        ) : null}
        {step === 2 ? (
          <IxButton iconRight={iconArrowRight} disabled={!canNext || isBusy} onClick={() => void prepare()}>
            Next: dry run
          </IxButton>
        ) : null}
      </div>
    </Page>
  );
}
