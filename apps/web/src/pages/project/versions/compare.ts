// Pure helpers for the version comparison view.

import type { EntityChange, ProjectDiff } from "@/domain/diff";
import type { ChangeLogEntry, EntityKind } from "@/domain/model";

export const KIND_LABEL: Record<EntityKind, string> = {
  aspectType: "Aspect type",
  assetType: "Asset type",
  asset: "Asset",
  file: "File",
};

export type ChangeFilter = "all" | EntityChange["change"];
export type KindFilter = "all" | EntityKind;

export function filterEntities(diff: ProjectDiff, kind: KindFilter, change: ChangeFilter, query: string): EntityChange[] {
  const q = query.trim().toLowerCase();
  const order: Record<EntityKind, number> = { aspectType: 0, assetType: 1, asset: 2, file: 3 };
  return diff.entities
    .filter((e) => (kind === "all" || e.kind === kind) && (change === "all" || e.change === change) && (!q || e.label.toLowerCase().includes(q)))
    .sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
}

export function countByKind(diff: ProjectDiff): Record<EntityKind, number> {
  const out: Record<EntityKind, number> = { aspectType: 0, assetType: 0, asset: 0, file: 0 };
  for (const e of diff.entities) out[e.kind] += 1;
  return out;
}

/** Changelog newest first, filtered by summary/author (case-insensitive). */
export function searchChangelog(entries: ChangeLogEntry[], query: string): ChangeLogEntry[] {
  const q = query.trim().toLowerCase();
  const list = [...entries].reverse();
  return q ? list.filter((e) => e.summary.toLowerCase().includes(q) || (e.author ?? "").toLowerCase().includes(q)) : list;
}
