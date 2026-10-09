// "Documentation" panel: format choice, section toggles, hierarchy caps,
// generate & download, and an HTML preview in a sandboxed iframe.

import { useState } from "react";
import {
  IxButton,
  IxCheckbox,
  IxMessageBar,
  IxNumberInput,
  IxRadio,
  IxRadioGroup,
  IxTypography,
} from "@siemens/ix-react";
import { iconDownload, iconEye } from "@siemens/ix-icons/icons";
import { DashboardPanel } from "@/components/DashboardPanel";
import { errorMessage, notifySuccess } from "@/components/notify";
import type { CoreLibraryIndex } from "@/domain/coreLibrary";
import type { Project } from "@/domain/model";
import type { GuardrailSettings } from "@/domain/rules";
import { downloadBlob } from "@/portability/download";
import {
  DOC_FORMATS,
  DOC_FORMAT_LABELS,
  DOC_SECTIONS,
  buildDocContext,
  defaultDocOptions,
  generateDocumentation,
  renderHtml,
  type DocFormat,
  type DocOptions,
} from "@/portability/docs";
import styles from "./Portability.module.css";

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function DocumentationPanel({
  project,
  core,
  guardrails,
}: {
  project: Project;
  core: CoreLibraryIndex;
  guardrails: GuardrailSettings;
}) {
  const [format, setFormat] = useState<DocFormat>("html");
  const [opts, setOpts] = useState<DocOptions>(defaultDocOptions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ html: string; at: string } | null>(null);

  const anySection = DOC_SECTIONS.some((s) => opts.sections[s.id]);
  const setSection = (id: (typeof DOC_SECTIONS)[number]["id"], on: boolean) =>
    setOpts((o) => ({ ...o, sections: { ...o.sections, [id]: on } }));

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const ctx = buildDocContext(project, core, guardrails);
      const doc = await generateDocumentation(format, ctx, opts);
      downloadBlob(doc.blob, doc.fileName);
      notifySuccess(`Documentation generated (${doc.fileName}).`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function showPreview() {
    setError(null);
    try {
      const ctx = buildDocContext(project, core, guardrails);
      setPreview({ html: renderHtml(ctx, opts), at: new Date().toLocaleTimeString() });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <DashboardPanel title="Documentation" span="full">
      <div className={styles.stack}>
        <IxTypography format="body-sm" textColor="soft" className={styles.text}>
          Generate a model documentation of this project: types, inheritance, attributes per asset, hierarchy, files and change
          log. The HTML file is self-contained and print-friendly; the PDF contains real text with bookmarks and page numbers.
        </IxTypography>

        <IxRadioGroup label="Format" direction="row" value={format} onValueChange={(e) => setFormat((DOC_FORMATS as readonly string[]).includes(e.detail) ? (e.detail as DocFormat) : "html")}>
          {DOC_FORMATS.map((f) => (
            <IxRadio key={f} label={DOC_FORMAT_LABELS[f]} value={f} />
          ))}
        </IxRadioGroup>

        <div className={styles.group}>
          <h3 className={`typography-h5 ${styles.subTitle}`}>Sections</h3>
          <div className={styles.optionGrid}>
            {DOC_SECTIONS.map((s) => (
              <div key={s.id} className={styles.option}>
                <IxCheckbox label={s.title} checked={opts.sections[s.id]} onCheckedChange={(e) => setSection(s.id, e.detail)} />
                <IxTypography format="body-xs" textColor="soft" className={styles.optionHint}>
                  {s.description}
                </IxTypography>
              </div>
            ))}
          </div>
          <div className={styles.row}>
            <IxButton
              variant="subtle-tertiary"
              onClick={() => setOpts((o) => ({ ...o, sections: defaultDocOptions().sections }))}
            >
              Select all sections
            </IxButton>
          </div>
        </div>

        <div className={styles.fields}>
          <IxNumberInput
            label="Hierarchy: maximum assets"
            helperText="Larger trees are cut off; the document states how many assets were omitted."
            min={1}
            max={100000}
            value={opts.hierarchyMaxNodes}
            disabled={!opts.sections.hierarchy}
            onValueChange={(e) =>
              setOpts((o) => ({ ...o, hierarchyMaxNodes: clampInt(e.detail, 1, 100000, o.hierarchyMaxNodes) }))
            }
          />
          <IxNumberInput
            label="Hierarchy: maximum depth"
            helperText="Levels below the tenant root."
            min={1}
            max={50}
            value={opts.hierarchyMaxDepth}
            disabled={!opts.sections.hierarchy}
            onValueChange={(e) => setOpts((o) => ({ ...o, hierarchyMaxDepth: clampInt(e.detail, 1, 50, o.hierarchyMaxDepth) }))}
          />
        </div>

        {!anySection ? (
          <IxMessageBar type="warning" persistent>
            Select at least one section.
          </IxMessageBar>
        ) : null}
        {error ? (
          <IxMessageBar type="alarm" onClosedChange={() => setError(null)}>
            {`Generation failed: ${error}`}
          </IxMessageBar>
        ) : null}

        <div className={styles.row}>
          <IxButton variant="primary" icon={iconDownload} loading={busy} disabled={busy || !anySection} onClick={() => void generate()}>
            Generate & download
          </IxButton>
          <IxButton variant="secondary" icon={iconEye} disabled={!anySection} onClick={showPreview}>
            {preview ? "Update HTML preview" : "Preview HTML"}
          </IxButton>
          {preview ? (
            <IxButton variant="subtle-tertiary" onClick={() => setPreview(null)}>
              Hide preview
            </IxButton>
          ) : null}
        </div>

        {preview ? (
          <div className={styles.group}>
            <IxTypography format="body-xs" textColor="soft">
              {`Preview generated at ${preview.at}. It does not update automatically.`}
            </IxTypography>
            {/* sandbox="": no scripts, no same-origin access — the document is inert. */}
            <iframe title="Documentation preview" sandbox="" srcDoc={preview.html} className={styles.preview} />
          </div>
        ) : null}
      </div>
    </DashboardPanel>
  );
}
