// Run an import of existing tenant objects into a (possibly closed) project.

import { loadMapping, saveMapping } from "@/deploy/store";
import type { Project } from "@/domain/model";
import type { TenantCatalogRecord } from "@/storage/db";
import { loadProject, saveProject } from "@/storage/repository";
import { useProjectStore } from "@/state/projectStore";
import { applyImport, mergedMapping, planImport, type ImportPlan, type ImportSelection } from "./importToProject";

/** The project as it is now: the open (in-memory) revision, else the stored one. */
export async function currentProject(projectId: string): Promise<Project> {
  const open = useProjectStore.getState().project;
  if (open?.id === projectId) return open;
  const stored = await loadProject(projectId);
  if (!stored) throw new Error("Project not found.");
  return stored;
}

export async function previewImport(projectId: string, catalog: TenantCatalogRecord, selection: ImportSelection): Promise<ImportPlan> {
  const project = await currentProject(projectId);
  const mapping = await loadMapping(projectId, catalog.connectionId);
  return planImport(project, catalog.snapshot, mapping, selection, catalog.connectionId);
}

/**
 * Apply a previewed import. The project change is one undoable step when the
 * project is open; mapping entries are written after the project change
 * succeeded (they are flagged `imported`, so they never cause deletions).
 */
export async function runImport(projectId: string, catalog: TenantCatalogRecord, plan: ImportPlan): Promise<void> {
  const label = `Imported ${plan.counts.aspectTypes + plan.counts.assetTypes + plan.counts.assets} object(s) from tenant ${catalog.tenant}`;
  const store = useProjectStore.getState();
  if (store.project?.id === projectId) {
    store.apply(label, (d) => applyImport(d, plan));
    await store.flush();
  } else {
    const project = await loadProject(projectId);
    if (!project) throw new Error("Project not found.");
    applyImport(project, plan);
    const at = new Date().toISOString();
    project.updatedAt = at;
    project.changelog.push({ at, summary: label });
    await saveProject(project);
  }
  const existing = await loadMapping(projectId, catalog.connectionId);
  await saveMapping(mergedMapping(existing, plan, projectId, catalog.connectionId, catalog.tenant));
}
