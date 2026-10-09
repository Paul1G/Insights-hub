// Splitting variable updates into sequential merge-patch requests.
//
// PATCH /assettypes/{id}/variables and PATCH /aspecttypes/{id}/variables take
// a map "current name → changes". The modelling guidelines state that
// "multiple variables can be updated using update variables API, provided the
// variable names are not interchanged in same request". This module turns a
// set of renames / updates / additions / deletions (identified by variable
// uid) into an ordered list of batches so that within one batch
//   - every key is a name that exists right before the batch,
//   - no new name is currently held by another variable (case-insensitive),
//     which rules out swaps, chains and cycles inside one request;
// cycles are broken with a temporary name.

import { LIMITS, isReservedWord } from "@/domain/rules";

const lc = (s: string) => s.toLowerCase();

export interface VariableChange {
  uid: string;
  /** Current name in the tenant; undefined for additions. */
  from?: string;
  /** Desired name; undefined for deletions. */
  to?: string;
  /** Additional fields to send with the (final) entry, e.g. unit, length. */
  fields?: Record<string, unknown>;
}

export interface BatchEntry {
  /** Map key: the name right before the batch (or the new name for additions). */
  key: string;
  /** null deletes the variable (RFC 7396). */
  value: Record<string, unknown> | null;
  uid: string;
  /** Name after the batch; null when deleted. */
  resultName: string | null;
  temporary?: boolean;
}

export type Batch = BatchEntry[];

export interface SplitOptions {
  /** Names held by variables that are not part of `changes` (kept as they are). */
  otherNames?: string[];
  /** Produce a temporary name; must be unique and a valid variable name. */
  tempName?: (attempt: number, base: string) => string;
}

export class RenamePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenamePlanError";
  }
}

export function defaultTempName(attempt: number, base: string): string {
  return `ams_tmp${attempt}_${base}`.slice(0, LIMITS.variableNameMax);
}

/** Map of a batch as sent in the request body. */
export function batchBody(batch: Batch): Record<string, Record<string, unknown> | null> {
  const out: Record<string, Record<string, unknown> | null> = {};
  for (const e of batch) out[e.key] = e.value;
  return out;
}

/**
 * Order the changes into batches. Deletions and plain updates go into the
 * first batch; renames and additions follow as soon as their target name is
 * free; pure cycles get one member parked under a temporary name.
 */
export function splitVariableChanges(changes: VariableChange[], opts: SplitOptions = {}): Batch[] {
  const tempName = opts.tempName ?? defaultTempName;
  // lower-case name → holder uid ("" for variables outside `changes`)
  const held = new Map<string, string>();
  for (const n of opts.otherNames ?? []) held.set(lc(n), "");
  for (const c of changes) if (c.from !== undefined) held.set(lc(c.from), c.uid);

  const deletes = changes.filter((c) => c.from !== undefined && c.to === undefined);
  const updates = changes.filter((c) => c.from !== undefined && c.to !== undefined && c.from === c.to);
  const renames = changes
    .filter((c) => c.from !== undefined && c.to !== undefined && c.from !== c.to)
    .map((c) => ({ uid: c.uid, from: c.from!, to: c.to!, fields: c.fields ?? {} }));
  const adds = changes
    .filter((c) => c.from === undefined && c.to !== undefined)
    .map((c) => ({ uid: c.uid, to: c.to!, fields: c.fields ?? {} }));

  // Final names must be unique and must not collide with names that stay.
  const finals = new Map<string, string>();
  for (const c of changes) {
    const finalName = c.to;
    if (finalName === undefined) continue;
    const key = lc(finalName);
    if (finals.has(key)) throw new RenamePlanError(`Two variables would be named "${finalName}".`);
    finals.set(key, c.uid);
    const holder = held.get(key);
    if (holder === "") throw new RenamePlanError(`"${finalName}" is already used by another variable in the target.`);
  }

  const batches: Batch[] = [];
  const first: Batch = [];
  for (const d of deletes) {
    first.push({ key: d.from!, value: null, uid: d.uid, resultName: null });
  }
  for (const u of updates) {
    if (Object.keys(u.fields ?? {}).length === 0) continue;
    first.push({ key: u.from!, value: { ...u.fields }, uid: u.uid, resultName: u.from! });
  }

  const isFree = (name: string, uid: string): boolean => {
    const holder = held.get(lc(name));
    return holder === undefined || holder === uid;
  };

  let pendingRenames = renames;
  let pendingAdds = adds;
  let batch = first;
  let tempCounter = 0;
  const guardMax = 4 * (renames.length + adds.length) + 8;
  let iterations = 0;

  for (;;) {
    iterations++;
    if (iterations > guardMax) throw new RenamePlanError("Could not order the variable renames.");
    // Readiness is evaluated against the names held right before this batch.
    const readyRenames = pendingRenames.filter((r) => isFree(r.to, r.uid));
    const readyAdds = pendingAdds.filter((a) => isFree(a.to, a.uid));
    for (const r of readyRenames) {
      batch.push({ key: r.from, value: { ...r.fields, name: r.to }, uid: r.uid, resultName: r.to });
    }
    for (const a of readyAdds) {
      batch.push({ key: a.to, value: { ...a.fields, name: a.to }, uid: a.uid, resultName: a.to });
    }
    pendingRenames = pendingRenames.filter((r) => !readyRenames.includes(r));
    pendingAdds = pendingAdds.filter((a) => !readyAdds.includes(a));

    if (batch.length === 0 && pendingRenames.length > 0) {
      // Every remaining rename waits for a name held by another pending
      // rename: a cycle. Park one member under a temporary name.
      const r = pendingRenames[0]!;
      let tmp = "";
      do {
        tempCounter++;
        tmp = tempName(tempCounter, r.to);
      } while (held.has(lc(tmp)) || finals.has(lc(tmp)) || isReservedWord(tmp));
      batch.push({ key: r.from, value: { name: tmp }, uid: r.uid, resultName: tmp, temporary: true });
      r.from = tmp;
    } else if (batch.length === 0 && pendingAdds.length > 0) {
      throw new RenamePlanError(`"${pendingAdds[0]!.to}" cannot be added because the name stays in use.`);
    }

    // Apply the batch to the held names.
    for (const e of batch) {
      if (held.get(lc(e.key)) === e.uid) held.delete(lc(e.key));
    }
    for (const e of batch) {
      if (e.resultName !== null) held.set(lc(e.resultName), e.uid);
    }
    if (batch.length > 0) batches.push(batch);
    if (pendingRenames.length === 0 && pendingAdds.length === 0) break;
    batch = [];
  }
  return batches;
}
