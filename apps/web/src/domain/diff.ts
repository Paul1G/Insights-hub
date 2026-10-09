// Structural diff for version snapshots and ETag (412) conflict views.

import type { EntityKind, Project } from "./model";

export interface Change {
  /** Dotted path, array members addressed by their key (uid/name/key) or index. */
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function memberKey(item: unknown): string | undefined {
  if (!isObject(item)) return undefined;
  for (const k of ["uid", "aspectId", "assetId", "id", "key", "name"]) {
    const v = item[k];
    if (typeof v === "string" && v) return `${k}=${v}`;
  }
  return undefined;
}

function join(path: string, seg: string): string {
  return path ? `${path}.${seg}` : seg;
}

function equalJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Deep diff of two JSON-like values. Arrays of keyed objects are matched by key. */
export function diffValues(before: unknown, after: unknown, path = ""): Change[] {
  if (equalJson(before, after)) return [];
  if (before === undefined) return [{ path, kind: "added", after }];
  if (after === undefined) return [{ path, kind: "removed", before }];

  if (Array.isArray(before) && Array.isArray(after)) {
    const keyed =
      before.length + after.length > 0 &&
      [...before, ...after].every((x) => memberKey(x) !== undefined);
    if (keyed) {
      const out: Change[] = [];
      const b = new Map(before.map((x) => [memberKey(x)!, x]));
      const a = new Map(after.map((x) => [memberKey(x)!, x]));
      for (const [k, bv] of b) {
        out.push(...diffValues(bv, a.get(k), join(path, `[${k}]`)));
      }
      for (const [k, av] of a) {
        if (!b.has(k)) out.push({ path: join(path, `[${k}]`), kind: "added", after: av });
      }
      return out;
    }
    if ([...before, ...after].every((x) => !isObject(x) && !Array.isArray(x))) {
      return [{ path, kind: "changed", before, after }];
    }
    const out: Change[] = [];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) out.push(...diffValues(before[i], after[i], join(path, `[${i}]`)));
    return out;
  }

  if (isObject(before) && isObject(after)) {
    const out: Change[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) out.push(...diffValues(before[k], after[k], join(path, k)));
    return out;
  }
  return [{ path, kind: "changed", before, after }];
}

export interface EntityChange {
  kind: EntityKind;
  uid: string;
  label: string;
  change: "added" | "removed" | "modified";
  fields: Change[];
}

export interface ProjectDiff {
  entities: EntityChange[];
  projectFields: Change[];
  summary: { added: number; removed: number; modified: number };
}

type Keyed = { uid: string; name: string };

function diffCollection<T extends Keyed>(kind: EntityKind, before: T[], after: T[]): EntityChange[] {
  const out: EntityChange[] = [];
  const b = new Map(before.map((x) => [x.uid, x]));
  const a = new Map(after.map((x) => [x.uid, x]));
  for (const [uid, bv] of b) {
    const av = a.get(uid);
    if (!av) {
      out.push({ kind, uid, label: bv.name, change: "removed", fields: [] });
      continue;
    }
    const fields = diffValues(bv, av);
    if (fields.length) out.push({ kind, uid, label: av.name, change: "modified", fields });
  }
  for (const [uid, av] of a) {
    if (!b.has(uid)) out.push({ kind, uid, label: av.name, change: "added", fields: [] });
  }
  return out;
}

/** Entity-level diff between two revisions of a project (before → after). */
export function diffProjects(before: Project, after: Project): ProjectDiff {
  const entities = [
    ...diffCollection("aspectType", before.aspectTypes, after.aspectTypes),
    ...diffCollection("assetType", before.assetTypes, after.assetTypes),
    ...diffCollection("asset", before.assets, after.assets),
    ...diffCollection("file", before.files, after.files),
  ];
  const projectFields = diffValues(
    { name: before.name, description: before.description },
    { name: after.name, description: after.description },
  );
  const summary = { added: 0, removed: 0, modified: 0 };
  for (const e of entities) summary[e.change] += 1;
  return { entities, projectFields, summary };
}
