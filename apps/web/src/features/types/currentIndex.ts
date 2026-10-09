// A ModelIndex of the open project as it is *now* — for edits that run after
// an awaited dialog, where an index captured at render time may be stale.

import { DomainError } from "@/domain/ops";
import { ModelIndex } from "@/domain/resolve";
import { useCatalogStore } from "@/state/catalogStore";
import { useProjectStore } from "@/state/projectStore";
import { useSettingsStore } from "@/state/settingsStore";

export function currentIndex(): ModelIndex {
  const project = useProjectStore.getState().project;
  if (!project) throw new DomainError("No project is open.");
  const catalogs = useCatalogStore.getState();
  const linked = catalogs.links[project.id];
  const external = linked ? catalogs.catalogs[linked]?.external : undefined;
  return new ModelIndex(project, useSettingsStore.getState().coreIndex, external);
}
