// Import, export & docs (/p/:projectId/portability): project file export /
// import, spreadsheet (XLSX / CSV) round trips with a change preview, and the
// documentation generator. The route's <h1> is rendered by the shared PageHeader.

import { DashboardGrid } from "@/components/DashboardGrid";
import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { useProject } from "@/state/hooks";
import { useSettingsStore } from "@/state/settingsStore";
import { DocumentationPanel } from "./DocumentationPanel";
import { ProjectFilePanel } from "./ProjectFilePanel";
import { SpreadsheetPanels } from "./SpreadsheetPanels";

export function PortabilityPage() {
  const project = useProject();
  const core = useSettingsStore((s) => s.coreIndex);
  const guardrails = useSettingsStore((s) => s.guardrails);
  return (
    <Page>
      <PageHeader
        title="Import, export & docs"
        subtitle="Move the model between projects and spreadsheets, and generate its documentation."
      />
      <DashboardGrid>
        <ProjectFilePanel project={project} />
        <SpreadsheetPanels project={project} core={core} />
        <DocumentationPanel project={project} core={core} guardrails={guardrails} />
      </DashboardGrid>
    </Page>
  );
}
