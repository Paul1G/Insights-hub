// Deployment executor: runs a plan against a tenant.
//
// - Phases and dependency levels run strictly in order; inside one level up
//   to `concurrency` steps run in parallel, each only after its dependencies
//   succeeded (dependents of failed steps become `skipped-dependency`).
// - Before every modifying step on an existing resource the current resource
//   is read (GET) for a fresh ETag and compared with the plan-time view; a
//   drift or a 412 marks the step `conflict` with a Change[] diff.
// - Creates of types use If-None-Match: *; retried creates first look for an
//   object created by an earlier attempt and adopt it (no duplicates).
// - The run and the mapping are persisted after every step (coalesced
//   writes), so a reload can resume; multi-request steps resume after the
//   last applied request.

import { UpstreamError, blobToBase64, type AmRequest, type AmResponse, type FileUploadInput } from "@/api/client";
import type { AmAssetResource, AmFileMetadata } from "@/api/amTypes";
import { diffValues } from "@/domain/diff";
import type { MappingRecord } from "@/storage/db";
import { comparable, lc } from "./comparable";
import { entityKey, memberKey, removeEntityEntries } from "./mapping";
import { buildReport } from "./report";
import { etagOf, seg, type Transport } from "./transport";
import {
  PHASES,
  SATISFIED_STEP_STATUSES,
  TERMINAL_STEP_STATUSES,
  type DeploymentPlan,
  type DeploymentRun,
  type MemberUpdate,
  type PlanStep,
  type PlannedRequest,
  type RunMode,
  type StepRun,
} from "./types";

export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 8;

export interface RunPersistence {
  saveRun(run: DeploymentRun): Promise<void>;
  saveMapping(mapping: MappingRecord): Promise<void>;
}

export interface ExecutorDeps {
  transport: Transport;
  persistence: RunPersistence;
  loadBlob(blobId: string): Promise<Blob | undefined>;
  /** Milliseconds clock (durations). */
  now?: () => number;
  /** ISO clock (timestamps). */
  iso?: () => string;
}

export class RunController {
  private pauseRequested = false;
  private cancelRequested = false;
  pause(): void {
    this.pauseRequested = true;
  }
  cancel(): void {
    this.cancelRequested = true;
  }
  get paused(): boolean {
    return this.pauseRequested;
  }
  get cancelled(): boolean {
    return this.cancelRequested;
  }
  get stopRequested(): boolean {
    return this.pauseRequested || this.cancelRequested;
  }
}

export interface ExecuteOptions {
  concurrency?: number;
  control?: RunController;
  /** Called after every state change of a step (callers throttle rendering). */
  onUpdate?: (run: DeploymentRun) => void;
}

export interface CreateRunInput {
  plan: DeploymentPlan;
  projectId: string;
  connectionId: string;
  connectionName: string;
  mode: RunMode;
  concurrency?: number;
  skipBlocked?: boolean;
  rollbackOf?: string;
  id?: string;
  at?: string;
}

export function createRun(input: CreateRunInput): DeploymentRun {
  const at = input.at ?? new Date().toISOString();
  return {
    id: input.id ?? crypto.randomUUID(),
    projectId: input.projectId,
    connectionId: input.connectionId,
    connectionName: input.connectionName,
    tenant: input.plan.tenant,
    mode: input.mode,
    status: "planned",
    createdAt: at,
    plan: input.plan,
    state: {
      version: 1,
      items: input.plan.steps.map((s) => ({
        stepId: s.id,
        status: "pending",
        attempts: 0,
        errors: [],
        createdIds: [],
        completedRequests: 0,
      })),
      ids: {},
      concurrency: clampConcurrency(input.concurrency ?? DEFAULT_CONCURRENCY),
      skipBlocked: input.skipBlocked ?? false,
      ...(input.rollbackOf ? { rollbackOf: input.rollbackOf } : {}),
      warnings: [],
    },
  };
}

export function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(n)));
}

/** Reset failed, conflicting, dependency-skipped and interrupted steps so the run can continue. */
export function prepareRetry(run: DeploymentRun, opts: { acceptDriftFor?: string[] } = {}): void {
  const accept = new Set(opts.acceptDriftFor ?? []);
  for (const item of run.state.items) {
    if (item.status === "failed" || item.status === "conflict" || item.status === "skipped-dependency" || item.status === "running") {
      item.status = "pending";
      item.errors = [];
      delete item.note;
      if (accept.has(item.stepId)) item.acceptDrift = true;
      else delete item.conflict;
    }
  }
  run.status = "paused";
  delete run.finishedAt;
}

/** Mark one conflicting step as skipped by the user. */
export function skipStep(run: DeploymentRun, stepId: string): void {
  const item = run.state.items.find((i) => i.stepId === stepId);
  if (!item) return;
  item.status = "skipped";
  item.note = "Skipped by the user.";
}

/** Steps left running by a page reload: the outcome is unknown. */
export function markInterrupted(run: DeploymentRun): void {
  if (run.status !== "running") return;
  for (const item of run.state.items) {
    if (item.status === "running") {
      item.status = "failed";
      item.errors = ["Interrupted (the page was closed or reloaded) — the outcome is unknown; a retry checks the target first."];
    }
  }
  run.status = "paused";
}

function messagesOf(e: unknown): string[] {
  if (e instanceof UpstreamError) {
    const msgs = e.messages.length ? e.messages : [e.message];
    return msgs.map((m) => `HTTP ${e.status}: ${m}`);
  }
  if (e instanceof Error) return [e.message];
  return [String(e)];
}

class MissingIdError extends Error {
  constructor(token: string) {
    super(`The tenant id for ${token} is not known yet (its creating step did not succeed).`);
    this.name = "MissingIdError";
  }
}

const TOKEN = /\{\{(asset|file):([^}]+)\}\}/g;

export function resolveTokens<T>(value: T, ids: Record<string, string>, encode = false): T {
  if (typeof value === "string") {
    return value.replace(TOKEN, (_m, kind: string, uid: string) => {
      const id = ids[`${kind}:${uid}`];
      if (id === undefined) throw new MissingIdError(`${kind} ${uid}`);
      return encode ? seg(id) : id;
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveTokens(v, ids, encode)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveTokens(v, ids, encode);
    return out as T;
  }
  return value;
}

/** Serialises writes and always writes the latest state. */
class Coalescer {
  private running: Promise<void> | null = null;
  private again = false;
  constructor(private readonly write: () => Promise<void>, private readonly onError: (e: unknown) => void) {}
  schedule(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.write();
        } catch (e) {
          this.onError(e);
        }
      } while (this.again);
      this.running = null;
    })();
  }
  async flush(): Promise<void> {
    while (this.running) await this.running;
  }
}

export function finalStatus(run: DeploymentRun): DeploymentRun["status"] {
  const steps = new Map(run.plan.steps.map((s) => [s.id, s]));
  let bad = false;
  let good = false;
  for (const item of run.state.items) {
    const step = steps.get(item.stepId);
    if (item.status === "succeeded" || (item.status === "skipped" && !step?.blocked)) good = true;
    if (item.status === "failed" || item.status === "conflict" || item.status === "skipped-dependency" || item.status === "pending") bad = true;
    if (item.status === "skipped" && step?.blocked) bad = true;
  }
  if (!bad) return "completed";
  return good ? "completed-with-errors" : "failed";
}

export async function executeRun(
  run: DeploymentRun,
  mapping: MappingRecord,
  deps: ExecutorDeps,
  opts: ExecuteOptions = {},
): Promise<DeploymentRun> {
  const now = deps.now ?? (() => performance.now());
  const iso = deps.iso ?? (() => new Date().toISOString());
  const control = opts.control ?? new RunController();
  const limit = clampConcurrency(opts.concurrency ?? run.state.concurrency);
  const steps = new Map(run.plan.steps.map((s) => [s.id, s]));
  const items = new Map(run.state.items.map((i) => [i.stepId, i]));
  const { transport } = deps;

  if (run.plan.blockers.some((b) => b.kind === "validation")) {
    throw new Error("The project has validation errors; fix them before deploying.");
  }
  if (!run.state.skipBlocked && run.plan.steps.some((s) => s.blocked && items.get(s.id)?.status === "pending")) {
    throw new Error("The plan contains blocked steps; resolve them or choose to skip blocked steps.");
  }

  const runWriter = new Coalescer(
    () => deps.persistence.saveRun(run),
    (e) => run.state.warnings.push(`Saving the run failed: ${e instanceof Error ? e.message : String(e)}`),
  );
  const mappingWriter = new Coalescer(
    () => deps.persistence.saveMapping(mapping),
    (e) => run.state.warnings.push(`Saving the mapping failed: ${e instanceof Error ? e.message : String(e)}`),
  );
  const emit = () => {
    runWriter.schedule();
    opts.onUpdate?.(run);
  };

  run.status = "running";
  run.startedAt ??= iso();
  delete run.finishedAt;
  emit();

  // ---------------------------------------------------------------------
  const resolvePath = (p: string) => resolveTokens(p, run.state.ids, true);

  const toAm = (req: PlannedRequest): AmRequest => {
    const out: AmRequest = { method: req.method, path: resolvePath(req.path) };
    if (req.query) out.query = req.query;
    if (req.ifMatch !== undefined) out.ifMatch = req.ifMatch;
    if (req.ifNoneMatch !== undefined) out.ifNoneMatch = req.ifNoneMatch;
    if (req.body !== undefined) out.body = resolveTokens(req.body, run.state.ids);
    if (req.contentType) out.contentType = req.contentType;
    return out;
  };

  const uploadInput = async (req: PlannedRequest): Promise<FileUploadInput> => {
    const spec = req.upload;
    if (!spec) throw new Error("Upload request without file data.");
    const blob = await deps.loadBlob(spec.blobId);
    if (!blob) throw new Error(`The local content of "${spec.name}" is missing.`);
    return {
      name: spec.name,
      ...(spec.description ? { description: spec.description } : {}),
      scope: spec.scope,
      fileName: spec.name,
      mimeType: spec.mimeType,
      contentBase64: await blobToBase64(blob),
    };
  };

  const send = async (step: PlanStep, req: PlannedRequest): Promise<AmResponse<unknown>> => {
    switch (req.transport ?? "am") {
      case "am":
        return transport.request(toAm(req));
      case "upload":
        return transport.uploadFile(await uploadInput(req));
      case "replace":
        return transport.replaceFile(resolveTokens(step.tenantId, run.state.ids), req.ifMatch ?? 0, await uploadInput(req));
    }
  };

  const get = (path: string) => transport.request({ method: "GET", path: resolvePath(path) });

  const writeMemberUpdates = (step: PlanStep, updates: MemberUpdate[] | undefined) => {
    const m = step.mapping;
    if (!m || !updates?.length) return;
    const tenantId = resolveTokens(m.tenantId, run.state.ids);
    const at = iso();
    for (const u of updates) {
      const key = memberKey(u.kind, m.uid, u.uid);
      if (u.name === null) delete mapping.entries[key];
      else mapping.entries[key] = { ...mapping.entries[key], kind: u.kind, tenantId, name: u.name, ownerUid: m.uid, deployedAt: at };
    }
    mapping.updatedAt = at;
    mappingWriter.schedule();
  };

  const writeMapping = (step: PlanStep, lastBody: unknown) => {
    const m = step.mapping;
    if (!m) return;
    const at = iso();
    if (m.removeEntity) {
      removeEntityEntries(mapping, m.kind, m.uid);
    } else {
      const tenantId = resolveTokens(m.tenantId, run.state.ids);
      const body = lastBody as { etag?: number; aspects?: { name: string; aspectId?: string }[] } | undefined;
      const etag = typeof body?.etag === "number" ? body.etag : undefined;
      mapping.entries[entityKey(m.kind, m.uid)] = {
        kind: m.kind,
        tenantId,
        name: m.name,
        ...(etag !== undefined ? { etag } : {}),
        ...(m.sha256 ? { sha256: m.sha256 } : {}),
        deployedAt: at,
      };
      for (const v of m.variables ?? []) {
        mapping.entries[memberKey("variable", m.uid, v.uid)] = { kind: "variable", tenantId, name: v.name, ownerUid: m.uid, deployedAt: at };
      }
      const bodyAspects = new Map((body?.aspects ?? []).map((a) => [lc(a.name), a.aspectId]));
      for (const a of m.aspects ?? []) {
        const key = memberKey("aspect", m.uid, a.uid);
        const aspectId = bodyAspects.get(lc(a.name)) ?? a.aspectId ?? mapping.entries[key]?.aspectId;
        mapping.entries[key] = { kind: "aspect", tenantId, name: a.name, ownerUid: m.uid, ...(aspectId ? { aspectId } : {}), deployedAt: at };
      }
      for (const key of m.remove ?? []) delete mapping.entries[key];
    }
    mapping.updatedAt = at;
    mappingWriter.schedule();
  };

  const createdIdOf = (step: PlanStep, body: unknown): string => {
    const b = body as Partial<AmAssetResource & AmFileMetadata> | undefined;
    if (step.entity.kind === "asset") return b?.assetId ?? "";
    if (step.entity.kind === "file") return b?.id ?? "";
    return b?.id ?? step.tenantId;
  };

  const register = (step: PlanStep, item: StepRun, id: string) => {
    if (!id) throw new Error("The create response did not contain the new id.");
    if (step.createsToken) run.state.ids[step.createsToken] = id;
    if (!item.createdIds.includes(id)) item.createdIds.push(id);
  };

  /** Look for an object created by an earlier, interrupted attempt. */
  const reconcile = async (step: PlanStep): Promise<{ id: string; body: unknown } | undefined> => {
    const r = step.reconcile;
    if (!r) return undefined;
    if (r.kind === "aspectType" || r.kind === "assetType") {
      const res = await get(`/${r.kind === "aspectType" ? "aspecttypes" : "assettypes"}/${seg(r.id)}`);
      return res.status < 400 ? { id: (res.body as { id?: string }).id ?? r.id, body: res.body } : undefined;
    }
    if (r.kind === "asset") {
      const parentId = resolveTokens(r.parentId, run.state.ids);
      const list = await transport.listAll<AmAssetResource>({ resource: "assets", filter: JSON.stringify({ parentId, name: r.name }) });
      const hit = list.items.find((a) => a.parentId === parentId && lc(a.name) === lc(r.name) && !a.deleted);
      return hit ? { id: hit.assetId, body: hit } : undefined;
    }
    const list = await transport.listAll<AmFileMetadata>({ resource: "files", filter: JSON.stringify({ name: r.name }) });
    const hit = list.items.find((f) => f.name === r.name);
    return hit ? { id: hit.id, body: hit } : undefined;
  };

  const conflictDiff = (step: PlanStep, item: StepRun, fresh: unknown) => {
    if (!step.expectKind) return [];
    const before = step.expect ?? comparable(step.expectKind, item.preImage);
    return diffValues(before, comparable(step.expectKind, fresh));
  };

  const runStep = async (step: PlanStep, item: StepRun): Promise<void> => {
    item.status = "running";
    item.attempts++;
    item.startedAt = iso();
    item.errors = [];
    delete item.httpStatus;
    emit();
    const t0 = now();
    try {
      if (step.blocked) {
        item.status = "skipped";
        item.note = `Blocked: ${step.blocked.reason}`;
        return;
      }
      if (step.op === "skip" || step.requests.length === 0) {
        item.status = "skipped";
        writeMapping(step, undefined);
        return;
      }
      if (step.reconcile && item.attempts > 1 && item.completedRequests === 0) {
        const adopted = await reconcile(step);
        if (adopted) {
          register(step, item, adopted.id);
          item.status = "succeeded";
          item.note = "Already present in the target (created by an earlier attempt) — adopted instead of creating a duplicate.";
          writeMapping(step, adopted.body);
          return;
        }
      }
      let etag: string | undefined;
      if (step.resourcePath) {
        const res = await get(step.resourcePath);
        item.httpStatus = res.status;
        if (res.status === 404 && step.op === "delete") {
          item.status = "succeeded";
          item.note = "Already deleted in the target.";
          writeMapping(step, undefined);
          return;
        }
        if (res.status >= 400) throw new UpstreamError(res.status, res.body);
        etag = etagOf(res);
        if (item.preImage === undefined) item.preImage = res.body;
        if (step.expectKind && step.expect !== undefined && !item.acceptDrift && item.completedRequests === 0) {
          const drift = diffValues(step.expect, comparable(step.expectKind, res.body));
          if (drift.length) {
            item.status = "conflict";
            item.conflict = drift;
            item.errors = ["The target changed after the analysis. Review the differences, then retry with the fresh ETag or skip the step."];
            return;
          }
        }
      }
      let lastBody: unknown;
      for (let i = item.completedRequests; i < step.requests.length; i++) {
        const planned = step.requests[i]!;
        const req: PlannedRequest = { ...planned };
        if (req.ifMatch !== undefined) {
          if (etag === undefined && step.resourcePath) etag = etagOf(await get(step.resourcePath));
          if (etag !== undefined) req.ifMatch = etag;
        }
        const res = await send(step, req);
        item.httpStatus = res.status;
        if (res.status === 412) {
          const fresh = step.resourcePath ? await get(step.resourcePath) : undefined;
          item.status = "conflict";
          item.conflict = fresh ? conflictDiff(step, item, fresh.body) : [];
          item.errors = [
            step.op === "create" || step.op === "upload"
              ? "HTTP 412: the object already exists in the target. Analyze the target again to update it instead."
              : "HTTP 412: the resource was changed in the background. Retry with the fresh ETag or skip the step.",
          ];
          return;
        }
        if (res.status === 404 && step.op === "delete") {
          item.note = "Already deleted in the target.";
        } else if (res.status >= 400) {
          throw new UpstreamError(res.status, res.body);
        }
        etag = etagOf(res);
        lastBody = res.body;
        item.completedRequests = i + 1;
        if (i === 0 && (step.op === "create" || step.op === "upload")) register(step, item, createdIdOf(step, res.body));
        writeMemberUpdates(step, planned.memberUpdates);
        runWriter.schedule();
      }
      item.status = "succeeded";
      delete item.conflict;
      writeMapping(step, lastBody);
    } catch (e) {
      item.status = "failed";
      item.errors = messagesOf(e);
    } finally {
      item.durationMs = Math.round((item.durationMs ?? 0) + (now() - t0));
      item.finishedAt = iso();
      emit();
    }
  };

  // ---------------------------------------------------------------------
  // Scheduling: phase → level barriers, dependency-aware pool inside.

  const depState = (step: PlanStep): "ready" | "blocked" | "wait" => {
    let wait = false;
    for (const d of step.dependsOn) {
      const dep = steps.get(d);
      const di = items.get(d);
      if (!dep || !di) continue;
      if (SATISFIED_STEP_STATUSES.has(di.status) && !(dep.blocked && di.status === "skipped")) continue;
      if (TERMINAL_STEP_STATUSES.has(di.status)) return "blocked";
      wait = true;
    }
    return wait ? "wait" : "ready";
  };

  const phaseIndex = new Map(PHASES.map((p, i) => [p, i]));
  const groups = new Map<string, PlanStep[]>();
  for (const s of run.plan.steps) {
    const key = `${String(phaseIndex.get(s.phase)).padStart(2, "0")}:${String(s.level + 1000).padStart(6, "0")}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => list);

  for (const group of orderedGroups) {
    if (control.stopRequested) break;
    const pending = group.filter((s) => items.get(s.id)!.status === "pending");
    const active = new Map<string, Promise<void>>();
    while (pending.length || active.size) {
      if (!control.stopRequested) {
        for (let i = 0; i < pending.length && active.size < limit; ) {
          const s = pending[i]!;
          const state = depState(s);
          if (state === "blocked") {
            const item = items.get(s.id)!;
            item.status = "skipped-dependency";
            item.errors = ["A step this one depends on did not succeed."];
            pending.splice(i, 1);
            emit();
            continue;
          }
          if (state === "ready") {
            pending.splice(i, 1);
            const p = runStep(s, items.get(s.id)!).finally(() => active.delete(s.id));
            active.set(s.id, p);
            continue;
          }
          i++;
        }
      }
      if (active.size === 0) {
        if (!control.stopRequested && pending.length) {
          for (const s of pending) {
            const item = items.get(s.id)!;
            item.status = "skipped-dependency";
            item.errors = ["Its dependencies could not be ordered (dependency cycle)."];
          }
          pending.length = 0;
          emit();
        }
        break;
      }
      await Promise.race(active.values());
    }
  }

  if (control.cancelled) {
    run.status = "cancelled";
    run.finishedAt = iso();
  } else if (control.paused) {
    run.status = "paused";
  } else {
    run.status = finalStatus(run);
    run.finishedAt = iso();
  }
  run.report = buildReport(run);
  opts.onUpdate?.(run);
  runWriter.schedule();
  await runWriter.flush();
  await mappingWriter.flush();
  return run;
}
