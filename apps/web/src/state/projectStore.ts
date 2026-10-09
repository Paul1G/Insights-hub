// The open project: editing with undo/redo (Immer patches) and autosave.
//
// Usage:
//   const apply = useProjectStore((s) => s.apply);
//   apply("Rename asset", (d) => { d.assets[0].name = "X"; });
//   apply("Edit name", (d) => { ... }, { coalesceKey: `asset-name:${uid}` });
//
// `apply` throws whatever the recipe throws (e.g. DomainError) and leaves
// the project untouched in that case.

import { applyPatches, enablePatches, produceWithPatches, type Patch } from "immer";
import { create } from "zustand";
import type { Project } from "@/domain/model";
import { createSnapshot, loadProject, saveProject } from "@/storage/repository";

enablePatches();

const HISTORY_LIMIT = 200;
const AUTOSAVE_DELAY_MS = 600;
const COALESCE_WINDOW_MS = 1500;
const CHANGELOG_COALESCE_MS = 60_000;

interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  at: number;
  coalesceKey?: string;
}

export type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

export interface ApplyOptions {
  /** Consecutive edits with the same key within 1.5 s merge into one undo step. */
  coalesceKey?: string;
  /** Do not write a changelog entry (e.g. for pure UI-driven normalisation). */
  silent?: boolean;
}

interface ProjectState {
  project: Project | null;
  loading: boolean;
  loadError?: string;
  past: HistoryEntry[];
  future: HistoryEntry[];
  saveState: SaveState;
  lastSavedAt?: string;
  saveError?: string;

  open(id: string): Promise<void>;
  close(): Promise<void>;
  apply(label: string, recipe: (draft: Project) => void, opts?: ApplyOptions): void;
  /** Replace the whole project (snapshot restore, import), as one undoable step. */
  replace(label: string, next: Project): void;
  undo(): void;
  redo(): void;
  flush(): Promise<void>;
  snapshot(label: string, auto?: boolean): Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function stamp(d: Project, label: string, silent: boolean | undefined): void {
  const at = new Date().toISOString();
  d.updatedAt = at;
  if (silent) return;
  const last = d.changelog[d.changelog.length - 1];
  if (last && last.summary === label && Date.parse(at) - Date.parse(last.at) < CHANGELOG_COALESCE_MS) {
    last.at = at;
  } else {
    d.changelog.push({ at, summary: label });
  }
}

export const useProjectStore = create<ProjectState>((set, get) => {
  const scheduleSave = () => {
    set({ saveState: "pending" });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().flush(), AUTOSAVE_DELAY_MS);
  };

  return {
    project: null,
    loading: false,
    past: [],
    future: [],
    saveState: "idle",

    async open(id) {
      const current = get().project;
      if (current?.id === id) return;
      await get().flush();
      set({ loading: true, loadError: undefined });
      try {
        const project = await loadProject(id);
        if (!project) {
          set({ project: null, loading: false, loadError: "Project not found." });
          return;
        }
        set({ project, loading: false, past: [], future: [], saveState: "saved", lastSavedAt: project.updatedAt });
      } catch (e) {
        set({ project: null, loading: false, loadError: e instanceof Error ? e.message : String(e) });
      }
    },

    async close() {
      await get().flush();
      set({ project: null, past: [], future: [], saveState: "idle" });
    },

    apply(label, recipe, opts) {
      const project = get().project;
      if (!project) throw new Error("No project is open.");
      const [next, patches, inverse] = produceWithPatches(project, (d: Project) => {
        recipe(d);
        stamp(d, label, opts?.silent);
      });
      if (patches.length === 0) return;
      const now = Date.now();
      const past = [...get().past];
      const last = past[past.length - 1];
      if (opts?.coalesceKey && last?.coalesceKey === opts.coalesceKey && now - last.at < COALESCE_WINDOW_MS) {
        past[past.length - 1] = {
          ...last,
          patches: [...last.patches, ...patches],
          inverse: [...inverse, ...last.inverse],
          at: now,
        };
      } else {
        past.push({ label, patches, inverse, at: now, coalesceKey: opts?.coalesceKey });
        if (past.length > HISTORY_LIMIT) past.shift();
      }
      set({ project: next, past, future: [] });
      scheduleSave();
    },

    replace(label, next) {
      const project = get().project;
      if (!project) throw new Error("No project is open.");
      const target = { ...next, id: project.id };
      get().apply(label, (d) => {
        Object.assign(d, structuredClone(target));
      });
    },

    undo() {
      const { project, past, future } = get();
      const entry = past[past.length - 1];
      if (!project || !entry) return;
      set({
        project: applyPatches(project, entry.inverse),
        past: past.slice(0, -1),
        future: [entry, ...future],
      });
      scheduleSave();
    },

    redo() {
      const { project, past, future } = get();
      const entry = future[0];
      if (!project || !entry) return;
      set({
        project: applyPatches(project, entry.patches),
        past: [...past, { ...entry, coalesceKey: undefined }],
        future: future.slice(1),
      });
      scheduleSave();
    },

    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      const { project, saveState } = get();
      if (!project || (saveState !== "pending" && saveState !== "error")) return;
      set({ saveState: "saving" });
      try {
        await saveProject(project);
        // Only mark saved if nothing changed while writing.
        if (get().project === project) set({ saveState: "saved", lastSavedAt: new Date().toISOString(), saveError: undefined });
        else scheduleSave();
      } catch (e) {
        set({ saveState: "error", saveError: e instanceof Error ? e.message : String(e) });
      }
    },

    async snapshot(label, auto = false) {
      const project = get().project;
      if (!project) return;
      await get().flush();
      await createSnapshot(project, label, auto);
    },
  };
});

if (typeof window !== "undefined") {
  const flush = () => void useProjectStore.getState().flush();
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
