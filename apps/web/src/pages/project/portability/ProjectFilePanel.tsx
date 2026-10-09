// "Project file" panel: export the open project as a self-describing JSON
// file (optionally with embedded file contents) and import a project file as
// a new project.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { IxButton, IxCheckbox, IxMessageBar, IxTypography } from "@siemens/ix-react";
import { iconDownload, iconOpenExternal } from "@siemens/ix-icons/icons";
import { DashboardPanel } from "@/components/DashboardPanel";
import { confirmDialog } from "@/components/dialogs";
import { errorMessage, notifySuccess } from "@/components/notify";
import type { Project } from "@/domain/model";
import { downloadBlob, formatBytes } from "@/portability/download";
import {
  ProjectFileError,
  buildProjectEnvelope,
  estimateProjectFileSize,
  importProjectFile,
  projectFileName,
  serializeEnvelope,
} from "@/portability/projectJson";
import { FileDrop, MessageList } from "./FileDrop";
import styles from "./Portability.module.css";

interface ImportOutcome {
  project?: Project;
  warnings: string[];
  error?: string;
  issues?: string[];
}

export function ProjectFilePanel({ project }: { project: Project }) {
  const navigate = useNavigate();
  const [embed, setEmbed] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);

  const sizes = useMemo(
    () => ({ plain: estimateProjectFileSize(project, false), embedded: estimateProjectFileSize(project, true) }),
    [project],
  );
  const fileCount = project.files.length;

  async function exportFile() {
    setExporting(true);
    setExportNote(null);
    try {
      const { envelope, missingContents } = await buildProjectEnvelope(project, { embedFiles: embed && fileCount > 0 });
      const blob = new Blob([serializeEnvelope(envelope)], { type: "application/json" });
      downloadBlob(blob, projectFileName(project));
      if (missingContents.length) {
        setExportNote(missingContents.map((n) => `No local content for “${n}”: it was exported without content.`));
      }
      notifySuccess(`Exported “${project.name}” (${formatBytes(blob.size)}).`);
    } catch (e) {
      setExportNote([`Export failed: ${errorMessage(e)}`]);
    } finally {
      setExporting(false);
    }
  }

  async function importFile(file: File) {
    setImporting(true);
    setOutcome(null);
    try {
      let result: { project: Project; warnings: string[] };
      try {
        result = await importProjectFile(file);
      } catch (e) {
        if (!(e instanceof ProjectFileError) || (e.code !== "checksum-mismatch" && e.code !== "file-content-mismatch")) throw e;
        const proceed = await confirmDialog({
          title: "Integrity check failed",
          message: `${e.message} Import it anyway? Damaged file contents are skipped.`,
          confirmLabel: "Import anyway",
          danger: true,
        });
        if (!proceed) {
          setOutcome({ warnings: [], error: e.message });
          return;
        }
        result = await importProjectFile(file, { allowChecksumMismatch: true });
      }
      setOutcome({ project: result.project, warnings: result.warnings });
      notifySuccess(`Imported “${result.project.name}” as a new project.`);
    } catch (e) {
      setOutcome({
        warnings: [],
        error: errorMessage(e),
        issues: e instanceof ProjectFileError ? e.issues : undefined,
      });
    } finally {
      setImporting(false);
    }
  }

  return (
    <DashboardPanel title="Project file" span="span-2">
      <div className={styles.stack}>
        <div className={styles.group}>
          <h3 className={`typography-h5 ${styles.subTitle}`}>Export</h3>
          <IxTypography format="body-sm" textColor="soft" className={styles.text}>
            A self-describing JSON file with a SHA-256 checksum. Deployment mappings, connections, tokens and user ids are never
            included.
          </IxTypography>
          <IxCheckbox
            label="Embed file contents"
            checked={embed}
            disabled={fileCount === 0}
            onCheckedChange={(e) => setEmbed(e.detail)}
          />
          <IxTypography format="body-sm" textColor="soft" className={styles.text}>
            {fileCount === 0
              ? `Estimated size: ${formatBytes(sizes.plain)} (the project has no files).`
              : `Estimated size: ${formatBytes(embed ? sizes.embedded : sizes.plain)} — ${fileCount} file(s) ${
                  embed ? "embedded" : "without contents"
                }.`}
          </IxTypography>
          <div className={styles.row}>
            <IxButton variant="primary" icon={iconDownload} loading={exporting} disabled={exporting} onClick={() => void exportFile()}>
              Export project file
            </IxButton>
          </div>
          {exportNote ? (
            <IxMessageBar type="warning" onClosedChange={() => setExportNote(null)}>
              <MessageList items={exportNote} />
            </IxMessageBar>
          ) : null}
        </div>

        <hr className={styles.divider} />

        <div className={styles.group}>
          <h3 className={`typography-h5 ${styles.subTitle}`}>Import as a new project</h3>
          <IxTypography format="body-sm" textColor="soft" className={styles.text}>
            The file is validated, its checksum verified and older versions migrated. It is saved as a new project; the open
            project is not changed.
          </IxTypography>
          <FileDrop
            buttonLabel="Choose project file"
            hint="Drop a project file (.json) here, or"
            accept=".json,application/json"
            busy={importing}
            onFiles={(files) => void importFile(files[0]!)}
          />
          {outcome?.error ? (
            <IxMessageBar type="alarm" onClosedChange={() => setOutcome(null)}>
              <div className={styles.group}>
                <IxTypography format="body-sm">{`Import failed: ${outcome.error}`}</IxTypography>
                <MessageList items={outcome.issues ?? []} />
              </div>
            </IxMessageBar>
          ) : null}
          {outcome?.project ? (
            <div className={styles.group}>
              <IxMessageBar type="success" onClosedChange={() => setOutcome(null)}>
                {`“${outcome.project.name}” was imported as a new project.`}
              </IxMessageBar>
              {outcome.warnings.length ? (
                <IxMessageBar type="warning">
                  <MessageList items={outcome.warnings} />
                </IxMessageBar>
              ) : null}
              <div className={styles.row}>
                <IxButton variant="secondary" icon={iconOpenExternal} onClick={() => navigate(`/p/${outcome.project!.id}`)}>
                  Open imported project
                </IxButton>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </DashboardPanel>
  );
}
