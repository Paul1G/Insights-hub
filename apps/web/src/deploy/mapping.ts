// Deployment mappings: where project entities live in one tenant.
//
// Keys inside MappingRecord.entries:
//   entities  `${kind}:${uid}`                    kind ∈ aspectType | assetType | asset | file
//   members   `variable:${ownerUid}:${varUid}`    name = variable name as deployed
//             `aspect:${ownerUid}:${aspectUid}`   name + platform aspectId
// Member entries let the planner detect renames (uid stays, deployed name
// differs) and deletions of members this project deployed earlier.

import type { MappingEntry, MappingRecord } from "@/storage/db";
import type { PlanEntityKind } from "./types";

export const mappingId = (projectId: string, connectionId: string): string => `${projectId}:${connectionId}`;
export const entityKey = (kind: PlanEntityKind, uid: string): string => `${kind}:${uid}`;
export const memberKey = (kind: "variable" | "aspect", ownerUid: string, uid: string): string =>
  `${kind}:${ownerUid}:${uid}`;

export function emptyMapping(projectId: string, connectionId: string, tenant: string, at = new Date().toISOString()): MappingRecord {
  return { id: mappingId(projectId, connectionId), projectId, connectionId, tenant, entries: {}, updatedAt: at };
}

export interface MemberEntry extends MappingEntry {
  uid: string;
}

/** Read-only lookups over a mapping record (absent record = empty mapping). */
export class MappingView {
  readonly record: MappingRecord | undefined;
  private readonly members = new Map<string, MemberEntry[]>();

  constructor(record?: MappingRecord) {
    this.record = record;
    for (const [key, entry] of Object.entries(record?.entries ?? {})) {
      if (entry.kind !== "variable" && entry.kind !== "aspect") continue;
      const parts = key.split(":");
      const uid = parts.slice(2).join(":");
      const owner = entry.ownerUid ?? parts[1] ?? "";
      const listKey = `${entry.kind}:${owner}`;
      const list = this.members.get(listKey) ?? [];
      list.push({ ...entry, uid });
      this.members.set(listKey, list);
    }
  }

  entity(kind: PlanEntityKind, uid: string): MappingEntry | undefined {
    return this.record?.entries[entityKey(kind, uid)];
  }

  variable(ownerUid: string, uid: string): MappingEntry | undefined {
    return this.record?.entries[memberKey("variable", ownerUid, uid)];
  }

  aspect(ownerUid: string, uid: string): MappingEntry | undefined {
    return this.record?.entries[memberKey("aspect", ownerUid, uid)];
  }

  /** Member entries (variables or aspects) recorded for an owner. */
  membersOf(kind: "variable" | "aspect", ownerUid: string): MemberEntry[] {
    return this.members.get(`${kind}:${ownerUid}`) ?? [];
  }

  /** Entity entries of a kind: [uid, entry]. */
  entities(kind: PlanEntityKind): [string, MappingEntry][] {
    const prefix = `${kind}:`;
    const out: [string, MappingEntry][] = [];
    for (const [key, entry] of Object.entries(this.record?.entries ?? {})) {
      if (entry.kind === kind && key.startsWith(prefix)) out.push([key.slice(prefix.length), entry]);
    }
    return out;
  }
}

/** Remove an entity entry and every member entry it owns. */
export function removeEntityEntries(record: MappingRecord, kind: PlanEntityKind, uid: string): void {
  delete record.entries[entityKey(kind, uid)];
  for (const [key, entry] of Object.entries(record.entries)) {
    if ((entry.kind === "variable" || entry.kind === "aspect") && entry.ownerUid === uid) delete record.entries[key];
  }
}
