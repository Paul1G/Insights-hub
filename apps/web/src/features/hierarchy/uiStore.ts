// UI state of the hierarchy editor (expanded nodes, search), kept per project
// so it survives navigating away from and back to the hierarchy route.

import { create } from "zustand";
import { ROOT_ASSET_UID } from "@/domain/model";

interface ProjectTreeState {
  expanded: Set<string>;
  /** Nodes the user collapsed while a search is active (search auto-expands ancestors). */
  searchCollapsed: Set<string>;
  query: string;
}

interface HierarchyUiState {
  byProject: Record<string, ProjectTreeState>;
  get(projectId: string): ProjectTreeState;
  setExpanded(projectId: string, expanded: Set<string>): void;
  toggle(projectId: string, uid: string, searching: boolean, open?: boolean): void;
  expandMany(projectId: string, uids: Iterable<string>): void;
  setQuery(projectId: string, query: string): void;
}

const initial = (): ProjectTreeState => ({ expanded: new Set([ROOT_ASSET_UID]), searchCollapsed: new Set(), query: "" });

export const useHierarchyUiStore = create<HierarchyUiState>((set, get) => ({
  byProject: {},
  get(projectId) {
    return get().byProject[projectId] ?? initial();
  },
  setExpanded(projectId, expanded) {
    set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...s.get(projectId), expanded } } }));
  },
  toggle(projectId, uid, searching, open) {
    const cur = get().get(projectId);
    if (searching) {
      const searchCollapsed = new Set(cur.searchCollapsed);
      const isOpen = !searchCollapsed.has(uid);
      if (open ?? !isOpen) searchCollapsed.delete(uid);
      else searchCollapsed.add(uid);
      // Also mirror into the normal expansion so the state is kept after the search ends.
      const expanded = new Set(cur.expanded);
      if (open ?? !isOpen) expanded.add(uid);
      set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...cur, searchCollapsed, expanded } } }));
      return;
    }
    const expanded = new Set(cur.expanded);
    const next = open ?? !expanded.has(uid);
    if (next) expanded.add(uid);
    else expanded.delete(uid);
    set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...cur, expanded } } }));
  },
  expandMany(projectId, uids) {
    const cur = get().get(projectId);
    let changed = false;
    const expanded = new Set(cur.expanded);
    for (const u of uids) {
      if (!expanded.has(u)) {
        expanded.add(u);
        changed = true;
      }
    }
    if (changed) set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...cur, expanded } } }));
  },
  setQuery(projectId, query) {
    const cur = get().get(projectId);
    set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...cur, query, searchCollapsed: new Set() } } }));
  },
}));
