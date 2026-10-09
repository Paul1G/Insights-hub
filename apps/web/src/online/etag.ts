// Optimistic locking for online edits (Asset Management v3 ETags).
//
// Every update/delete in the explorer is modelled as an EditSession: it knows
// how to read the current server version and how to *plan* the requests that
// turn that version into the user's edit. Plans are recomputed from the
// server state, so "Overwrite with my changes" after a 412 simply re-plans on
// the fresh resource and re-applies on its fresh ETag.
//
// Multi-step edits (e.g. PATCH /assettypes/{id} followed by
// PATCH /assettypes/{id}/variables) chain the ETag: each response's ETag
// header (or the etag of the returned resource) feeds the next request.

import type { AmRequest, AmResponse } from "@/api/client";
import { diffValues, type Change } from "@/domain/diff";
import { upstreamError } from "./errors";
import type { AmTransport } from "./transport";

export type Etag = string | number;

export interface PlannedRequest {
  /** Human-readable step, e.g. "Update description". */
  label: string;
  /** Build the request for the current ETag in the chain. */
  build(etag: Etag): AmRequest;
}

export interface EditSession<R> {
  /** Read the current server version (GET). */
  fetch(): Promise<{ resource: R; etag: Etag }>;
  /** Requests that turn `current` into the user's edit; [] = nothing to do. */
  plan(current: R): PlannedRequest[];
  /** The user's intended state, projected for the conflict diff. */
  mine: unknown;
  /** Projection of a server resource into the same shape as `mine`. */
  project(resource: R): unknown;
}

export interface Conflict<R> {
  /** Index of the step that failed with 412. */
  failedStep: number;
  /** Steps that were applied before the conflict. */
  completedSteps: string[];
  server: R;
  serverEtag: Etag;
  /** Server state (before) vs. the user's edit (after). */
  changes: Change[];
}

export type ExecuteResult<R> =
  | { kind: "done"; responses: AmResponse[]; etag: Etag; lastBody: unknown; steps: string[] }
  | { kind: "conflict"; conflict: Conflict<R> };

/** Normalise an ETag header (`3`, `"3"`, `W/"3"`). */
export function parseEtag(header: string | undefined | null): string | undefined {
  if (header === undefined || header === null) return undefined;
  const v = header.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  return v === "" ? undefined : v;
}

/** ETag after a successful response: header first, then the returned resource's etag. */
export function etagOf(res: AmResponse): Etag | undefined {
  const fromHeader = parseEtag(res.etag);
  if (fromHeader !== undefined) return fromHeader;
  const body = res.body as { etag?: unknown } | null | undefined;
  if (body && (typeof body.etag === "number" || typeof body.etag === "string")) return body.etag;
  return undefined;
}

/**
 * Run the session's plan against `start`. Returns "conflict" on HTTP 412
 * (after reading the current server version); throws UpstreamError for any
 * other upstream failure and ApiError for proxy failures.
 */
export async function executePlan<R>(
  t: AmTransport,
  connectionId: string,
  session: EditSession<R>,
  start: { resource: R; etag: Etag },
  signal?: AbortSignal,
): Promise<ExecuteResult<R>> {
  const steps = session.plan(start.resource);
  let etag: Etag = start.etag;
  const responses: AmResponse[] = [];
  const done: string[] = [];
  let lastBody: unknown = undefined;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const res = await t.am(connectionId, step.build(etag), signal);
    if (res.status === 412) {
      const fresh = await session.fetch();
      return {
        kind: "conflict",
        conflict: {
          failedStep: i,
          completedSteps: done,
          server: fresh.resource,
          serverEtag: fresh.etag,
          changes: diffValues(session.project(fresh.resource), session.mine),
        },
      };
    }
    if (res.status >= 400) throw upstreamError(res.status, res.body);
    responses.push(res);
    done.push(step.label);
    lastBody = res.body;
    const next = etagOf(res);
    if (next !== undefined) etag = next;
    else if (i < steps.length - 1) etag = (await session.fetch()).etag;
  }
  return { kind: "done", responses, etag, lastBody, steps: done };
}

export type ConflictDecision = "overwrite" | "discard";

export type ResolvedResult<R> =
  | { kind: "done"; responses: AmResponse[]; etag: Etag; lastBody: unknown; steps: string[]; overwrites: number }
  | { kind: "discarded"; conflict: Conflict<R> };

/**
 * executePlan with interactive conflict resolution: on 412 `resolve` decides
 * between re-applying the edit on the fresh server version ("overwrite") and
 * dropping it ("discard"). Gives up after `maxRounds` consecutive conflicts.
 */
export async function updateWithEtag<R>(
  t: AmTransport,
  connectionId: string,
  session: EditSession<R>,
  start: { resource: R; etag: Etag },
  resolve: (conflict: Conflict<R>) => Promise<ConflictDecision>,
  maxRounds = 3,
): Promise<ResolvedResult<R>> {
  let current = start;
  for (let round = 0; ; round++) {
    const result = await executePlan(t, connectionId, session, current);
    if (result.kind === "done") return { ...result, overwrites: round };
    const decision = await resolve(result.conflict);
    if (decision === "discard" || round + 1 >= maxRounds) return { kind: "discarded", conflict: result.conflict };
    current = { resource: result.conflict.server, etag: result.conflict.serverEtag };
  }
}

/** A session for a single request against a resource that is re-read with GET `path`. */
export function singleRequestSession<R extends { etag: Etag }>(opts: {
  connectionId: string;
  t: AmTransport;
  getPath: string;
  getQuery?: AmRequest["query"];
  label: string;
  build: (etag: Etag, current: R) => AmRequest;
  mine: unknown;
  project: (r: R) => unknown;
}): EditSession<R> {
  return {
    fetch: () => fetchWithEtag<R>(opts.t, opts.connectionId, opts.getPath, opts.getQuery),
    plan: (current) => [{ label: opts.label, build: (etag) => opts.build(etag, current) }],
    mine: opts.mine,
    project: opts.project,
  };
}

/** GET a resource and return it with its ETag (header first, then body.etag). */
export async function fetchWithEtag<R extends { etag: Etag }>(
  t: AmTransport,
  connectionId: string,
  path: string,
  query?: AmRequest["query"],
): Promise<{ resource: R; etag: Etag }> {
  const res = await t.am<R>(connectionId, { method: "GET", path, query });
  if (res.status >= 400) throw upstreamError(res.status, res.body);
  return { resource: res.body, etag: parseEtag(res.etag) ?? res.body.etag };
}
