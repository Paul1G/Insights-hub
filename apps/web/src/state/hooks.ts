// Derived, memoised views of the open project.

import { useMemo } from "react";
import { estimateProject, type ProjectEstimate } from "@/domain/estimator";
import { analyzeHealth, type HealthReport } from "@/domain/health";
import { ModelIndex } from "@/domain/resolve";
import { validateProject, type Issue, type ValidationResult } from "@/domain/validator";
import { useLinkedCatalog } from "./catalogStore";
import { useProjectStore } from "./projectStore";
import { useSettingsStore } from "./settingsStore";

/** The open project (throws if none — use inside project routes only). */
export function useProject() {
  const project = useProjectStore((s) => s.project);
  if (!project) throw new Error("useProject() used outside an open project.");
  return project;
}

/**
 * Index of the open project. When the project is linked to a tenant catalog,
 * existing tenant types resolve as `external` references.
 */
export function useModelIndex(): ModelIndex {
  const project = useProject();
  const coreIndex = useSettingsStore((s) => s.coreIndex);
  const external = useLinkedCatalog(project.id).catalog?.external;
  return useMemo(() => new ModelIndex(project, coreIndex, external), [project, coreIndex, external]);
}

export function useValidation(): ValidationResult {
  const index = useModelIndex();
  const guardrails = useSettingsStore((s) => s.guardrails);
  return useMemo(() => validateProject(index, guardrails), [index, guardrails]);
}

/** Issues for one entity (and optionally one member/field). */
export function useEntityIssues(uid: string, memberUid?: string, field?: string): Issue[] {
  const { byEntity } = useValidation();
  return useMemo(
    () =>
      (byEntity.get(uid) ?? []).filter(
        (i) =>
          (memberUid === undefined || i.target.memberUid === memberUid) &&
          (field === undefined || i.target.field === field),
      ),
    [byEntity, uid, memberUid, field],
  );
}

export function useEstimate(planned?: Record<string, number>): ProjectEstimate {
  const index = useModelIndex();
  return useMemo(() => estimateProject(index, planned), [index, planned]);
}

export function useHealth(): HealthReport {
  const index = useModelIndex();
  const guardrails = useSettingsStore((s) => s.guardrails);
  return useMemo(() => analyzeHealth(index, guardrails), [index, guardrails]);
}
