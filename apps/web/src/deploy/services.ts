// Production wiring of the run services: backend proxy transport, Dexie
// persistence, local file blobs, audit log, project snapshots and baselines.

import { api } from "@/api/client";
import { touch } from "@/domain/ops";
import { useProjectStore } from "@/state/projectStore";
import { createSnapshot, getFileBlob, loadProject, saveProject } from "@/storage/repository";
import { applyRunBaselines, runChangelogSummary } from "./baselines";
import type { RunServices } from "./run";
import { dexiePersistence } from "./store";
import { createApiTransport } from "./transport";

export function browserRunServices(connectionId: string, projectId: string): RunServices {
  return {
    transport: createApiTransport(connectionId),
    persistence: dexiePersistence,
    loadBlob: getFileBlob,
    audit: (entry) => api.audit.append(entry),
    snapshot: async (label) => {
      const store = useProjectStore.getState();
      if (store.project?.id === projectId) {
        await store.snapshot(label, true);
        return;
      }
      const project = await loadProject(projectId);
      if (project) await createSnapshot(project, label, true);
    },
    applyBaselines: async (run) => {
      const store = useProjectStore.getState();
      const summary = runChangelogSummary(run);
      if (store.project?.id === projectId) {
        store.apply(summary, (d) => {
          applyRunBaselines(d, run);
        });
        await useProjectStore.getState().flush();
        return;
      }
      const project = await loadProject(projectId);
      if (!project) return;
      applyRunBaselines(project, run);
      touch(project, summary);
      await saveProject(project);
    },
  };
}
