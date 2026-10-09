// "User libraries" tab: reusable type collections stored locally (Dexie
// userLibraries). Create from a project (dependency closure), rename, delete,
// export / import as checksummed JSON, insert into a project.

import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router";
import {
  IxButton,
  IxCard,
  IxCardContent,
  IxCheckbox,
  IxEmptyState,
  IxIconButton,
  IxInput,
  IxSelect,
  IxSelectItem,
  IxSpinner,
  IxTextarea,
  IxTypography,
} from "@siemens/ix-react";
import { iconAdd, iconDownload, iconImport, iconLibrary, iconPen, iconTrashcan, iconUpload } from "@siemens/ix-icons/icons";
import { confirmDialog } from "@/components/dialogs";
import { notifyError, notifySuccess } from "@/components/notify";
import type { Project } from "@/domain/model";
import { DomainError, touch } from "@/domain/ops";
import {
  adoptImportedLibrary,
  createUserLibrary,
  exportLibrary,
  insertLibrary,
  libraryClosure,
  libraryFileName,
  libraryNameTaken,
  librarySummary,
  parseLibraryFile,
  type InsertReport,
  type LibrarySelection,
} from "@/features/library/userLibrary";
import { formDialog } from "@/features/types/formDialog";
import { dialogStyles, masterDetailStyles as md } from "@/features/types/styles";
import type { ProjectMeta, UserLibrary } from "@/storage/db";
import { deleteUserLibrary, listProjects, listUserLibraries, loadProject, saveProject, saveUserLibrary } from "@/storage/repository";
import { useProjectStore } from "@/state/projectStore";
import styles from "./Library.module.css";

const NAME_MAX = 128;

function libraryNameError(name: string, existing: string[], except?: string): string | undefined {
  const n = name.trim();
  if (!n) return "Enter a library name.";
  if (n.length > NAME_MAX) return `At most ${NAME_MAX} characters.`;
  if (libraryNameTaken(n, existing, except)) return "Another library already has this name.";
  return undefined;
}

/** Latest saved state of a project (flushes the open project's pending edits first). */
async function loadLatest(projectId: string): Promise<Project> {
  const store = useProjectStore.getState();
  if (store.project?.id === projectId) await store.flush();
  const project = await loadProject(projectId);
  if (!project) throw new DomainError("Project not found.");
  return project;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function projectLabel(p: ProjectMeta, openId?: string): string {
  return `${p.name}${p.id === openId ? " (open)" : ""} — ${p.counts.assetTypes} asset types, ${p.counts.aspectTypes} aspect types`;
}

interface CreateForm extends LibrarySelection {
  name: string;
  description: string;
}

function CreateLibraryBody({
  project,
  value,
  patch,
  existing,
}: {
  project: Project;
  value: CreateForm;
  patch: (p: Partial<CreateForm>) => void;
  existing: string[];
}) {
  const closure = libraryClosure(project, value);
  const nameErr = value.name ? libraryNameError(value.name, existing) : undefined;
  const toggle = (list: "assetTypeUids" | "aspectTypeUids", uid: string, on: boolean) => {
    const current = value[list];
    patch({ [list]: on ? [...current, uid] : current.filter((u) => u !== uid) } as Partial<CreateForm>);
  };
  const assetTypes = [...project.assetTypes].sort((a, b) => a.name.localeCompare(b.name));
  const aspectTypes = [...project.aspectTypes].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <IxInput
        label="Library name"
        value={value.name}
        required
        maxLength={NAME_MAX}
        invalidText={nameErr}
        className={nameErr ? "ix-invalid" : undefined}
        onValueChange={(e) => patch({ name: e.detail })}
      />
      <IxTextarea textareaWidth="100%"
        label="Description (optional)"
        value={value.description}
        textareaRows={2}
        resizeBehavior="vertical"
        onValueChange={(e) => patch({ description: e.detail })}
      />
      <div className={dialogStyles.stack}>
        <h3 className={`typography-h6 ${dialogStyles.subheading}`}>Asset types ({value.assetTypeUids.length} selected)</h3>
        {assetTypes.length ? (
          <div className={dialogStyles.checkList}>
            {assetTypes.map((t) => (
              <IxCheckbox
                key={t.uid}
                label={`${t.name} ({tenant}.${t.idSuffix})`}
                checked={value.assetTypeUids.includes(t.uid)}
                onCheckedChange={(e) => toggle("assetTypeUids", t.uid, e.detail)}
              />
            ))}
          </div>
        ) : (
          <IxTypography format="body-sm" textColor="soft">The project has no asset types.</IxTypography>
        )}
      </div>
      <div className={dialogStyles.stack}>
        <h3 className={`typography-h6 ${dialogStyles.subheading}`}>Aspect types ({value.aspectTypeUids.length} selected)</h3>
        {aspectTypes.length ? (
          <div className={dialogStyles.checkList}>
            {aspectTypes.map((t) => (
              <IxCheckbox
                key={t.uid}
                label={`${t.name} · ${t.category}`}
                checked={value.aspectTypeUids.includes(t.uid)}
                onCheckedChange={(e) => toggle("aspectTypeUids", t.uid, e.detail)}
              />
            ))}
          </div>
        ) : (
          <IxTypography format="body-sm" textColor="soft">The project has no aspect types.</IxTypography>
        )}
      </div>
      <div className={dialogStyles.stack}>
        <IxTypography format="label">
          The library will contain {closure.assetTypes.length} asset type{closure.assetTypes.length === 1 ? "" : "s"} and{" "}
          {closure.aspectTypes.length} aspect type{closure.aspectTypes.length === 1 ? "" : "s"}.
        </IxTypography>
        <ul className={dialogStyles.list}>
          {closure.addedAssetTypes.length ? (
            <li>
              <IxTypography format="body-sm">Parent types added automatically: {closure.addedAssetTypes.join(", ")}</IxTypography>
            </li>
          ) : null}
          {closure.addedAspectTypes.length ? (
            <li>
              <IxTypography format="body-sm">Referenced aspect types added automatically: {closure.addedAspectTypes.join(", ")}</IxTypography>
            </li>
          ) : null}
          {closure.droppedFileAssignments ? (
            <li>
              <IxTypography format="body-sm">
                {closure.droppedFileAssignments} file assignment{closure.droppedFileAssignments === 1 ? " is" : "s are"} not included
                (files belong to projects).
              </IxTypography>
            </li>
          ) : null}
          <li>
            <IxTypography format="body-sm">Deployment state (baselines) and origins are not stored in libraries.</IxTypography>
          </li>
        </ul>
      </div>
    </>
  );
}

function LibraryCard({
  lib,
  onInsert,
  onExport,
  onRename,
  onDelete,
}: {
  lib: UserLibrary;
  onInsert: () => void;
  onExport: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentsId = `library-contents-${lib.id}`;
  return (
    <li className={styles.cell}>
      <IxCard variant="outline" passive className={styles.card}>
        <IxCardContent>
          <div className={styles.cardBody}>
            <h3 className={`typography-h5 ${styles.cardTitle}`}>{lib.name}</h3>
            {lib.description ? (
              <IxTypography format="body-sm" textColor="soft" className={md.text}>
                {lib.description}
              </IxTypography>
            ) : null}
            <IxTypography format="body-sm">{librarySummary(lib)}</IxTypography>
            <IxTypography format="body-xs" textColor="soft">
              Updated <time dateTime={lib.updatedAt}>{new Date(lib.updatedAt).toLocaleString()}</time>
            </IxTypography>
            <div>
              <IxButton
                variant="tertiary"
                aria-expanded={expanded ? "true" : "false"}
                aria-controls={contentsId}
                onClick={() => setExpanded((x) => !x)}
              >
                {expanded ? "Hide contents" : "Show contents"}
              </IxButton>
            </div>
            <div id={contentsId} hidden={!expanded} className={styles.contents}>
              <IxTypography format="label-sm" textColor="soft">Asset types</IxTypography>
              <IxTypography format="body-sm" className={md.text}>
                {lib.assetTypes.map((t) => t.name).join(", ") || "—"}
              </IxTypography>
              <IxTypography format="label-sm" textColor="soft">Aspect types</IxTypography>
              <IxTypography format="body-sm" className={md.text}>
                {lib.aspectTypes.map((t) => t.name).join(", ") || "—"}
              </IxTypography>
            </div>
            <div className={styles.cardActions}>
              <IxButton variant="primary" icon={iconAdd} onClick={onInsert}>
                Insert into project
              </IxButton>
              <span className={styles.iconActions}>
                <IxIconButton icon={iconDownload} variant="subtle-tertiary" aria-label={`Export ${lib.name}`} onClick={onExport} />
                <IxIconButton icon={iconPen} variant="subtle-tertiary" aria-label={`Rename ${lib.name}`} onClick={onRename} />
                <IxIconButton icon={iconTrashcan} variant="danger-tertiary" aria-label={`Delete ${lib.name}`} onClick={onDelete} />
              </span>
            </div>
          </div>
        </IxCardContent>
      </IxCard>
    </li>
  );
}

function RenameList({ report }: { report: InsertReport }) {
  if (!report.renames.length) {
    return <IxTypography format="body-sm">No naming conflicts — all names and ids were kept.</IxTypography>;
  }
  return (
    <div className={dialogStyles.stack}>
      <IxTypography format="label">Renamed to avoid conflicts (case-insensitive):</IxTypography>
      <ul className={dialogStyles.list}>
        {report.renames.map((r) => (
          <li key={`${r.kind}:${r.field}:${r.from}:${r.to}`}>
            <IxTypography format="body-sm">
              {r.kind === "assetType" ? "Asset type" : "Aspect type"} {r.field === "name" ? "name" : "id"} “{r.from}” → “{r.to}”
            </IxTypography>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function UserLibrariesTab() {
  const navigate = useNavigate();
  const libraries = useLiveQuery(() => listUserLibraries(), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const names = (libraries ?? []).map((l) => l.name);

  async function chooseProject(title: string, confirmLabel: string, intro: string): Promise<ProjectMeta | null> {
    const projects = await listProjects();
    if (projects.length === 0) {
      const go = await confirmDialog({ title: "No project yet", message: "Create a project first.", confirmLabel: "Go to projects" });
      if (go) navigate("/");
      return null;
    }
    const openId = useProjectStore.getState().project?.id;
    const choice = await formDialog({
      title,
      initial: { projectId: projects.some((p) => p.id === openId) ? openId! : projects[0]!.id },
      confirmLabel,
      size: "600",
      render: (v, patch) => (
        <>
          <IxTypography className={dialogStyles.text}>{intro}</IxTypography>
          <IxSelect label="Project" value={v.projectId} onValueChange={(e) => patch({ projectId: String(e.detail) })}>
            {projects.map((p) => (
              <IxSelectItem key={p.id} value={p.id} label={projectLabel(p, openId)} />
            ))}
          </IxSelect>
        </>
      ),
    });
    return choice ? (projects.find((p) => p.id === choice.projectId) ?? null) : null;
  }

  async function createFromProject() {
    try {
      const meta = await chooseProject("Create library — source project", "Next", "Choose the project whose types the library is built from.");
      if (!meta) return;
      const project = await loadLatest(meta.id);
      if (project.assetTypes.length + project.aspectTypes.length === 0) {
        notifyError(new DomainError(`“${project.name}” has no asset or aspect types yet.`));
        return;
      }
      const existing = names;
      const result = await formDialog<CreateForm>({
        title: `Create library from ${project.name}`,
        initial: { name: "", description: "", assetTypeUids: [], aspectTypeUids: [] },
        confirmLabel: "Create library",
        size: "720",
        render: (v, patch) => <CreateLibraryBody project={project} value={v} patch={patch} existing={existing} />,
        validate: (v) =>
          libraryNameError(v.name, existing) ??
          (v.assetTypeUids.length + v.aspectTypeUids.length === 0 ? "Select at least one asset type or aspect type." : undefined),
      });
      if (!result) return;
      const lib = createUserLibrary(result.name.trim(), result.description.trim() || undefined, libraryClosure(project, result));
      await saveUserLibrary(lib);
      notifySuccess(`Library “${lib.name}” created: ${librarySummary(lib)}.`);
    } catch (e) {
      notifyError(e, "Library could not be created");
    }
  }

  async function insert(lib: UserLibrary) {
    try {
      const meta = await chooseProject(
        `Insert “${lib.name}” into a project`,
        "Insert library",
        `Copies ${librarySummary(lib)} into the project with new identities. Names or ids that already exist get a _2, _3, … suffix; the types are marked as coming from this library.`,
      );
      if (!meta) return;
      const store = useProjectStore.getState();
      let report: InsertReport;
      if (store.project?.id === meta.id) {
        let r: InsertReport | undefined;
        store.apply(`Insert library ${lib.name}`, (d) => {
          r = insertLibrary(d, lib);
        });
        report = r!;
      } else {
        const project = await loadLatest(meta.id);
        report = insertLibrary(project, lib);
        touch(project, `Insert library ${lib.name}`);
        await saveProject(project);
      }
      const open = await confirmDialog({
        title: "Library inserted",
        message: `${report.assetTypes.length} asset type${report.assetTypes.length === 1 ? "" : "s"} and ${report.aspectTypes.length} aspect type${report.aspectTypes.length === 1 ? "" : "s"} were added to ${meta.name}.`,
        details: <RenameList report={report} />,
        confirmLabel: "Open asset types",
        cancelLabel: "Stay here",
      });
      if (open) {
        const first = report.assetTypes[0];
        navigate(first ? `/p/${meta.id}/asset-types/${first.uid}` : `/p/${meta.id}/aspect-types`);
      }
    } catch (e) {
      notifyError(e, "Insert failed");
    }
  }

  async function exportLib(lib: UserLibrary) {
    try {
      const file = await exportLibrary(lib);
      download(libraryFileName(lib), JSON.stringify(file, null, 2));
      notifySuccess(`Exported “${lib.name}” (SHA-256 ${file.checksum.value.slice(0, 12)}…).`);
    } catch (e) {
      notifyError(e, "Export failed");
    }
  }

  async function rename(lib: UserLibrary) {
    const result = await formDialog({
      title: `Rename “${lib.name}”`,
      initial: { name: lib.name, description: lib.description ?? "" },
      confirmLabel: "Save changes",
      render: (v, patch) => {
        const err = v.name ? libraryNameError(v.name, names, lib.name) : undefined;
        return (
          <>
            <IxInput
              label="Library name"
              value={v.name}
              required
              maxLength={NAME_MAX}
              invalidText={err}
              className={err ? "ix-invalid" : undefined}
              onValueChange={(e) => patch({ name: e.detail })}
            />
            <IxTextarea textareaWidth="100%"
              label="Description (optional)"
              value={v.description}
              textareaRows={2}
              resizeBehavior="vertical"
              onValueChange={(e) => patch({ description: e.detail })}
            />
          </>
        );
      },
      validate: (v) => libraryNameError(v.name, names, lib.name),
    });
    if (!result) return;
    try {
      const description = result.description.trim();
      const next: UserLibrary = { ...lib, name: result.name.trim() };
      if (description) next.description = description;
      else delete next.description;
      await saveUserLibrary(next);
      notifySuccess("Library updated.");
    } catch (e) {
      notifyError(e, "Rename failed");
    }
  }

  async function remove(lib: UserLibrary) {
    const ok = await confirmDialog({
      title: `Delete library “${lib.name}”?`,
      message: `The library (${librarySummary(lib)}) is deleted from this browser. Types already inserted into projects are not affected. Export it first if you may need it again.`,
      confirmLabel: "Delete library",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteUserLibrary(lib.id);
      notifySuccess(`Library “${lib.name}” deleted.`);
    } catch (e) {
      notifyError(e, "Delete failed");
    }
  }

  async function importFile(file: File) {
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      notifyError(e, "The file could not be read");
      return;
    }
    const parsed = await parseLibraryFile(text);
    if (!parsed.ok) {
      const again = await confirmDialog({
        title: "Library file rejected",
        message: `“${file.name}” is not a valid Asset Model Studio library:`,
        details: (
          <ul className={dialogStyles.list}>
            {parsed.errors.slice(0, 20).map((err) => (
              <li key={err}>
                <IxTypography format="body-sm">{err}</IxTypography>
              </li>
            ))}
          </ul>
        ),
        confirmLabel: "Choose another file",
      });
      if (again) fileInput.current?.click();
      return;
    }
    const lib = parsed.library;
    const ok = parsed.checksumValid
      ? await confirmDialog({
          title: `Import “${lib.name}”?`,
          message: `${librarySummary(lib)}, exported ${new Date(parsed.exportedAt).toLocaleString()}. Checksum verified (SHA-256).`,
          confirmLabel: "Import library",
        })
      : await confirmDialog({
          title: "Checksum mismatch",
          message: "The library content does not match its SHA-256 checksum: the file was modified after export or is corrupted. Import it only if you trust the change.",
          details: (
            <ul className={dialogStyles.list}>
              <li>
                <IxTypography format="code-sm">expected {parsed.expectedChecksum}</IxTypography>
              </li>
              <li>
                <IxTypography format="code-sm">actual {parsed.actualChecksum}</IxTypography>
              </li>
            </ul>
          ),
          confirmLabel: "Import anyway",
          danger: true,
        });
    if (!ok) return;
    try {
      const adopted = adoptImportedLibrary(lib, names);
      await saveUserLibrary(adopted);
      notifySuccess(`Library “${adopted.name}” imported${adopted.name !== lib.name ? ` (renamed from “${lib.name}”)` : ""}.`);
    } catch (e) {
      notifyError(e, "Import failed");
    }
  }

  const actions = (
    <div className={md.inlineRow}>
      <IxButton variant="secondary" icon={iconImport} onClick={() => fileInput.current?.click()}>
        Import library
      </IxButton>
      <IxButton variant="primary" icon={iconUpload} onClick={() => void createFromProject()}>
        Create from project
      </IxButton>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importFile(file);
        }}
      />
    </div>
  );

  return (
    <div className={styles.tab}>
      <div className={styles.sourceBar}>
        <div className={styles.sourceText}>
          <h2 className={`typography-h4 ${styles.heading}`}>User libraries ({libraries?.length ?? 0})</h2>
          <IxTypography format="body-sm" textColor="soft" className={md.text}>
            Reusable sets of aspect and asset types, stored in this browser. Export them as checksummed JSON to share between
            browsers or colleagues.
          </IxTypography>
        </div>
        {actions}
      </div>
      {libraries === undefined ? (
        <IxSpinner size="large" />
      ) : libraries.length === 0 ? (
        <IxEmptyState
          header="No user libraries yet"
          subHeader="Create a library from types of a project — parents and referenced aspect types are included automatically."
          icon={iconLibrary}
          action="Create from project"
          onActionClick={() => void createFromProject()}
        />
      ) : (
        <ul className={styles.grid}>
          {libraries.map((lib) => (
            <LibraryCard
              key={lib.id}
              lib={lib}
              onInsert={() => void insert(lib)}
              onExport={() => void exportLib(lib)}
              onRename={() => void rename(lib)}
              onDelete={() => void remove(lib)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
