// Project file import / export and the tenant backup entry point on the
// Projects page (formats: src/portability/projectJson.ts).

import { useRef } from "react";
import { useNavigate } from "react-router";
import { IxButton, IxIconButton } from "@siemens/ix-react";
import { iconBackup, iconBulb, iconExport, iconImport } from "@siemens/ix-icons/icons";
import { confirmDialog } from "@/components/dialogs";
import { notifyError, notifySuccess } from "@/components/notify";
import { downloadBlob } from "@/portability/download";
import { ProjectFileError, exportProjectFile, importProjectFile, projectFileName } from "@/portability/projectJson";
import type { ProjectMeta } from "@/storage/db";
import { createSampleProject } from "@/domain/sample";
import { loadProject, saveProject } from "@/storage/repository";
import { useProjectStore } from "@/state/projectStore";

const ACCEPT = ".json,application/json";

async function importWithChecks(file: File): Promise<{ id: string; name: string; warnings: string[] } | null> {
  try {
    const { project, warnings } = await importProjectFile(file);
    return { id: project.id, name: project.name, warnings };
  } catch (e) {
    if (e instanceof ProjectFileError && (e.code === "checksum-mismatch" || e.code === "file-content-mismatch")) {
      const anyway = await confirmDialog({
        title: "Integrity check failed",
        message: `${e.message} The file may have been edited or corrupted after export.`,
        confirmLabel: "Import anyway",
        danger: true,
      });
      if (!anyway) return null;
      const { project, warnings } = await importProjectFile(file, { allowChecksumMismatch: true });
      return { id: project.id, name: project.name, warnings };
    }
    throw e;
  }
}

/** Header buttons: import a project file, start from the official sample, back up a tenant. */
export function ProjectImportActions() {
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  async function onFile(file: File | undefined) {
    if (!file) return;
    try {
      const result = await importWithChecks(file);
      if (!result) return;
      const open = await confirmDialog({
        title: `Imported “${result.name}”`,
        message:
          result.warnings.length > 0
            ? `The project was imported with ${result.warnings.length} warning(s): ${result.warnings.join(" ")}`
            : "The project was imported as a new local project.",
        confirmLabel: "Open project",
        cancelLabel: "Stay here",
      });
      if (open) navigate(`/p/${result.id}`);
    } catch (e) {
      const detail = e instanceof ProjectFileError && e.issues.length ? ` (${e.issues.slice(0, 3).join("; ")})` : "";
      notifyError(`${e instanceof Error ? e.message : String(e)}${detail}`, "Import failed");
    } finally {
      if (input.current) input.current.value = "";
    }
  }

  async function createSample() {
    try {
      const project = createSampleProject();
      await saveProject(project);
      notifySuccess(`Created “${project.name}” from the official modelling example.`);
      navigate(`/p/${project.id}`);
    } catch (e) {
      notifyError(e, "Could not create the sample project");
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <IxButton variant="secondary" icon={iconImport} onClick={() => input.current?.click()}>
        Import project
      </IxButton>
      <IxButton variant="secondary" icon={iconBulb} onClick={() => void createSample()}>
        Sample project
      </IxButton>
      <IxButton variant="secondary" icon={iconBackup} onClick={() => navigate("/backup")}>
        Backup from tenant
      </IxButton>
    </>
  );
}

/** Per-project export (self-describing JSON with checksum and embedded file contents). */
export function ExportProjectButton({ meta }: { meta: ProjectMeta }) {
  async function exportProject() {
    try {
      const store = useProjectStore.getState();
      if (store.project?.id === meta.id) await store.flush();
      const project = await loadProject(meta.id);
      if (!project) throw new Error("Project not found.");
      const blob = await exportProjectFile(project, { embedFiles: true });
      downloadBlob(blob, projectFileName(project));
      notifySuccess(`Exported “${project.name}”.`);
    } catch (e) {
      notifyError(e, "Export failed");
    }
  }
  return (
    <IxIconButton
      icon={iconExport}
      variant="subtle-tertiary"
      aria-label={`Export ${meta.name}`}
      onClick={() => void exportProject()}
    />
  );
}
