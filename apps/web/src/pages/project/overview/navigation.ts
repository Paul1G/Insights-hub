// Route of the editor for a validation / health target.

import type { IssueTargetKind } from "@/domain/validator";

export function entityPath(projectId: string, kind: IssueTargetKind, uid: string): string | undefined {
  const base = `/p/${projectId}`;
  switch (kind) {
    case "aspectType":
      return `${base}/aspect-types/${uid}`;
    case "assetType":
      return `${base}/asset-types/${uid}`;
    case "asset":
      return `${base}/hierarchy/${uid}`;
    case "file":
      return `${base}/files?file=${encodeURIComponent(uid)}`;
    case "project":
      return undefined;
  }
}

/** Fill colour of the tenant-limit meter: accent → warning → alarm. */
export function meterLevel(share: number): "ok" | "warning" | "alarm" {
  if (share >= 1) return "alarm";
  if (share >= 0.8) return "warning";
  return "ok";
}

/** Parse a planned instance count from a number input; undefined clears the plan. */
export function plannedCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
