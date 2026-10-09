// Live deployment runs of this browser tab. Runs keep going when the user
// navigates away from the deploy page; components subscribe to `versions`.

import { create } from "zustand";
import type { MappingRecord } from "@/storage/db";
import { RunController, prepareRetry, skipStep } from "./executor";
import { rollbackRun, startRun, type RunServices } from "./run";
import type { DeploymentRun } from "./types";

interface ActiveRun {
  run: DeploymentRun;
  mapping: MappingRecord;
  services: RunServices;
  controller: RunController;
  running: boolean;
  error?: string;
}

interface SessionState {
  runs: Record<string, ActiveRun>;
  /** Bumped (throttled) whenever a run changes. */
  versions: Record<string, number>;
  start(run: DeploymentRun, mapping: MappingRecord, services: RunServices): Promise<DeploymentRun>;
  /** Register a run loaded from storage (history) without executing it. */
  adopt(run: DeploymentRun, mapping: MappingRecord, services: RunServices): DeploymentRun;
  pause(runId: string): void;
  cancel(runId: string): void;
  /** Reset failed / pending steps and continue (optionally accepting drift for some steps). */
  retry(runId: string, acceptDriftFor?: string[]): Promise<DeploymentRun | undefined>;
  skip(runId: string, stepId: string): void;
  rollback(runId: string): Promise<DeploymentRun | undefined>;
  isRunning(runId: string): boolean;
}

const THROTTLE_MS = 150;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const useDeploySession = create<SessionState>((set, get) => {
  const bump = (id: string, immediate = false) => {
    const fire = () => {
      timers.delete(id);
      set((s) => ({ versions: { ...s.versions, [id]: (s.versions[id] ?? 0) + 1 } }));
    };
    if (immediate) {
      const t = timers.get(id);
      if (t) clearTimeout(t);
      fire();
      return;
    }
    if (!timers.has(id)) timers.set(id, setTimeout(fire, THROTTLE_MS));
  };

  const register = (entry: ActiveRun) => {
    set((s) => ({ runs: { ...s.runs, [entry.run.id]: entry } }));
    bump(entry.run.id, true);
  };

  const execute = async (entry: ActiveRun): Promise<DeploymentRun> => {
    entry.running = true;
    entry.error = undefined;
    entry.controller = new RunController();
    bump(entry.run.id, true);
    try {
      await startRun(entry.run, entry.mapping, entry.services, { control: entry.controller, onUpdate: () => bump(entry.run.id) });
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      entry.running = false;
      bump(entry.run.id, true);
    }
    return entry.run;
  };

  return {
    runs: {},
    versions: {},

    async start(run, mapping, services) {
      const existing = get().runs[run.id];
      if (existing?.running) return existing.run;
      const entry: ActiveRun = { run, mapping, services, controller: new RunController(), running: false };
      register(entry);
      return execute(entry);
    },

    adopt(run, mapping, services) {
      const existing = get().runs[run.id];
      if (existing) return existing.run;
      register({ run, mapping, services, controller: new RunController(), running: false });
      return run;
    },

    pause(runId) {
      get().runs[runId]?.controller.pause();
      bump(runId, true);
    },

    cancel(runId) {
      get().runs[runId]?.controller.cancel();
      bump(runId, true);
    },

    async retry(runId, acceptDriftFor) {
      const entry = get().runs[runId];
      if (!entry || entry.running) return entry?.run;
      prepareRetry(entry.run, { acceptDriftFor });
      return execute(entry);
    },

    skip(runId, stepId) {
      const entry = get().runs[runId];
      if (!entry || entry.running) return;
      skipStep(entry.run, stepId);
      void entry.services.persistence.saveRun(entry.run);
      bump(runId, true);
    },

    async rollback(runId) {
      const entry = get().runs[runId];
      if (!entry || entry.running) return undefined;
      entry.running = true;
      bump(runId, true);
      const controller = new RunController();
      try {
        const rb = await rollbackRun(entry.run, entry.mapping, entry.services, {
          control: controller,
          onUpdate: (r) => {
            if (!get().runs[r.id]) register({ run: r, mapping: entry.mapping, services: entry.services, controller, running: true });
            bump(r.id);
          },
        });
        const rbEntry = get().runs[rb.id];
        if (rbEntry) rbEntry.running = false;
        else register({ run: rb, mapping: entry.mapping, services: entry.services, controller, running: false });
        bump(rb.id, true);
        return rb;
      } finally {
        entry.running = false;
        bump(runId, true);
      }
    },

    isRunning(runId) {
      return !!get().runs[runId]?.running;
    },
  };
});

/** Live view of one run: re-renders on every (throttled) change. */
export function useLiveRun(runId: string | undefined): { run?: DeploymentRun; version: number; running: boolean; error?: string } {
  const entry = useDeploySession((s) => (runId ? s.runs[runId] : undefined));
  const version = useDeploySession((s) => (runId ? (s.versions[runId] ?? 0) : 0));
  return { run: entry?.run, version, running: !!entry?.running, error: entry?.error };
}
