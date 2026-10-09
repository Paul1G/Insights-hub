// Projects: the local, offline project list (IndexedDB) with create, open,
// clone, rename, delete, import/export and tenant backup. The route's <h1> is rendered by PageHeader.

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router";
import {
  IxButton,
  IxCard,
  IxCardContent,
  IxEmptyState,
  IxIcon,
  IxIconButton,
  IxInput,
  IxSelect,
  IxSelectItem,
  IxSpinner,
  IxTextarea,
  IxTypography,
} from "@siemens/ix-react";
import { iconCogwheel, iconCopy, iconInfo, iconPen, iconProject, iconSearch, iconTrashcan } from "@siemens/ix-icons/icons";
import { confirmDialog, promptDialog } from "@/components/dialogs";
import { notifyError, notifySuccess } from "@/components/notify";
import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { uniqueName } from "@/domain/ops";
import { formDialog } from "@/features/types/formDialog";
import { dialogStyles } from "@/features/types/styles";
import { textMatch } from "@/features/types/typeTree";
import type { ProjectMeta } from "@/storage/db";
import { cloneProject, createProject, deleteProject, listProjects, renameProject } from "@/storage/repository";
import { useProjectStore } from "@/state/projectStore";
import { ExportProjectButton, ProjectImportActions } from "./ProjectImportExport";
import { ProjectsHeaderActions } from "./ProjectsHeaderActions";
import styles from "./ProjectsPage.module.css";

type SortKey = "updated" | "name" | "created";

const NAME_MAX = 128;
const DESCRIPTION_MAX = 1000;

function relativeTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  if (Number.isNaN(diff)) return iso;
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 864e5],
    ["month", 30 * 864e5],
    ["week", 7 * 864e5],
    ["day", 864e5],
    ["hour", 36e5],
    ["minute", 6e4],
  ];
  for (const [unit, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  return "just now";
}

function nameError(name: string, existing: string[], except?: string): string | undefined {
  const n = name.trim();
  if (!n) return "Enter a project name.";
  if (n.length > NAME_MAX) return `At most ${NAME_MAX} characters.`;
  if (existing.some((x) => x.toLowerCase() === n.toLowerCase() && x !== except)) return "Another local project already has this name.";
  return undefined;
}

function projectForm(existing: string[], except?: string) {
  return (v: { name: string; description: string }, patch: (p: Partial<{ name: string; description: string }>) => void) => {
    const error = v.name ? nameError(v.name, existing, except) : undefined;
    return (
      <>
        <IxInput
          label="Project name"
          value={v.name}
          required
          maxLength={NAME_MAX}
          invalidText={error}
          className={error ? "ix-invalid" : undefined}
          onValueChange={(e) => patch({ name: e.detail })}
        />
        <IxTextarea textareaWidth="100%"
          label="Description (optional)"
          value={v.description}
          maxLength={DESCRIPTION_MAX}
          textareaRows={3}
          resizeBehavior="vertical"
          helperText="What the model covers, e.g. plant, line or product family."
          onValueChange={(e) => patch({ description: e.detail })}
        />
      </>
    );
  };
}

function CountLine({ meta }: { meta: ProjectMeta }) {
  const c = meta.counts;
  const parts = [
    `${c.aspectTypes} aspect type${c.aspectTypes === 1 ? "" : "s"}`,
    `${c.assetTypes} asset type${c.assetTypes === 1 ? "" : "s"}`,
    `${c.assets.toLocaleString()} asset${c.assets === 1 ? "" : "s"}`,
    `${c.files} file${c.files === 1 ? "" : "s"}`,
  ];
  return (
    <IxTypography format="body-sm" className={styles.text}>
      {parts.join(" · ")}
    </IxTypography>
  );
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const projects = useLiveQuery(() => listProjects(), []);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");

  const names = useMemo(() => (projects ?? []).map((p) => p.name), [projects]);
  const visible = useMemo(() => {
    const list = (projects ?? []).filter((p) => textMatch(query, p.name, p.description));
    const cmp: Record<SortKey, (a: ProjectMeta, b: ProjectMeta) => number> = {
      updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      created: (a, b) => b.createdAt.localeCompare(a.createdAt),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return [...list].sort(cmp[sort]);
  }, [projects, query, sort]);

  async function create() {
    const result = await formDialog({
      title: "Create project",
      initial: { name: "", description: "" },
      confirmLabel: "Create project",
      render: projectForm(names),
      validate: (v) => nameError(v.name, names),
    });
    if (!result) return;
    try {
      const project = await createProject(result.name.trim(), result.description.trim() || undefined);
      navigate(`/p/${project.id}`);
    } catch (e) {
      notifyError(e, "Project could not be created");
    }
  }

  async function rename(meta: ProjectMeta) {
    const result = await formDialog({
      title: `Rename “${meta.name}”`,
      initial: { name: meta.name, description: meta.description ?? "" },
      confirmLabel: "Save changes",
      render: projectForm(names, meta.name),
      validate: (v) => nameError(v.name, names, meta.name),
    });
    if (!result) return;
    const name = result.name.trim();
    const description = result.description.trim();
    try {
      const store = useProjectStore.getState();
      if (store.project?.id === meta.id) {
        // The open project lives in the store; edit it there so autosave does not overwrite the rename.
        store.apply(`Renamed project to “${name}”`, (d) => {
          d.name = name;
          if (description) d.description = description;
          else delete d.description;
        });
        await store.flush();
      } else {
        await renameProject(meta.id, name, description);
      }
      notifySuccess("Project updated.");
    } catch (e) {
      notifyError(e, "Rename failed");
    }
  }

  async function clone(meta: ProjectMeta) {
    const name = await promptDialog({
      title: `Clone “${meta.name}”`,
      label: "Name of the copy",
      initial: uniqueName(`${meta.name} (copy)`, names, " "),
      confirmLabel: "Clone project",
      helper: "Copies the model, files and change history. Deployment mappings are not copied: the clone deploys as new objects.",
      validate: (v) => nameError(v, names),
    });
    if (!name) return;
    try {
      const store = useProjectStore.getState();
      if (store.project?.id === meta.id) await store.flush();
      const copy = await cloneProject(meta.id, name.trim());
      notifySuccess(`Project cloned as “${copy.name}”.`);
    } catch (e) {
      notifyError(e, "Clone failed");
    }
  }

  async function remove(meta: ProjectMeta) {
    const c = meta.counts;
    const ok = await confirmDialog({
      title: `Delete project “${meta.name}”?`,
      message: "The project is deleted from this browser. This cannot be undone. Objects already deployed to tenants are not affected.",
      details: (
        <ul className={dialogStyles.list}>
          <li>
            <IxTypography format="body-sm">
              {c.aspectTypes} aspect types, {c.assetTypes} asset types, {c.assets.toLocaleString()} assets and {c.files} files
            </IxTypography>
          </li>
          <li>
            <IxTypography format="body-sm">All version snapshots, stored file contents, deployment mappings and run history</IxTypography>
          </li>
        </ul>
      ),
      confirmLabel: "Delete project",
      danger: true,
      typedConfirmation: meta.name,
    });
    if (!ok) return;
    try {
      const store = useProjectStore.getState();
      if (store.project?.id === meta.id) await store.close();
      await deleteProject(meta.id);
      notifySuccess(`Project “${meta.name}” deleted.`);
    } catch (e) {
      notifyError(e, "Delete failed");
    }
  }

  let body;
  if (projects === undefined) {
    body = (
      <div className={styles.center}>
        <IxSpinner size="large" />
      </div>
    );
  } else if (projects.length === 0) {
    body = (
      <IxEmptyState
        header="No projects yet"
        subHeader="Create a project to design aspect types, asset types and the asset hierarchy — offline, then validate and deploy."
        icon={iconProject}
        action="Create project"
        onActionClick={() => void create()}
      />
    );
  } else {
    body = (
      <>
        <div className={styles.toolbar}>
          <search aria-label="Project search and sorting" className={styles.search}>
            <IxInput label="Search projects" value={query} className={styles.searchInput} onValueChange={(e) => setQuery(e.detail)}>
              <IxIcon slot="start" name={iconSearch} size="16" aria-hidden="true" />
            </IxInput>
            <IxSelect label="Sort by" value={sort} onValueChange={(e) => setSort(String(e.detail) as SortKey)}>
              <IxSelectItem value="updated" label="Last changed" />
              <IxSelectItem value="created" label="Newest" />
              <IxSelectItem value="name" label="Name" />
            </IxSelect>
          </search>
          <IxTypography format="body-sm" textColor="soft" role="status">
            {visible.length === projects.length ? `${projects.length} project${projects.length === 1 ? "" : "s"}` : `${visible.length} of ${projects.length} projects`}
          </IxTypography>
        </div>
        {visible.length === 0 ? (
          <IxEmptyState
            layout="compact"
            header="No matching projects"
            subHeader={`Nothing matches “${query}”.`}
            icon={iconSearch}
            action="Clear search"
            onActionClick={() => setQuery("")}
          />
        ) : (
          <ul className={styles.grid}>
            {visible.map((p) => (
              <li key={p.id} className={styles.cell}>
                <IxCard variant="outline" passive className={styles.card}>
                  <IxCardContent>
                    <div className={styles.cardBody}>
                      <h2 className={`typography-h5 ${styles.cardTitle}`}>{p.name}</h2>
                      {p.description ? (
                        <IxTypography format="body-sm" textColor="soft" className={styles.description}>
                          {p.description}
                        </IxTypography>
                      ) : null}
                      <CountLine meta={p} />
                      <IxTypography format="body-xs" textColor="soft" className={styles.text}>
                        <time dateTime={p.updatedAt} title={new Date(p.updatedAt).toLocaleString()}>
                          Changed {relativeTime(p.updatedAt)}
                        </time>
                        {" · "}
                        <time dateTime={p.createdAt}>created {new Date(p.createdAt).toLocaleDateString()}</time>
                      </IxTypography>
                      <div className={styles.cardActions}>
                        <IxButton variant="primary" onClick={() => navigate(`/p/${p.id}`)}>
                          Open
                        </IxButton>
                        <span className={styles.iconActions}>
                          <IxIconButton icon={iconPen} variant="subtle-tertiary" aria-label={`Rename ${p.name}`} onClick={() => void rename(p)} />
                          <IxIconButton icon={iconCopy} variant="subtle-tertiary" aria-label={`Clone ${p.name}`} onClick={() => void clone(p)} />
                          <ExportProjectButton meta={p} />
                          <IxIconButton
                            icon={iconTrashcan}
                            variant="danger-tertiary"
                            aria-label={`Delete ${p.name}`}
                            onClick={() => void remove(p)}
                          />
                        </span>
                      </div>
                    </div>
                  </IxCardContent>
                </IxCard>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Projects"
        subtitle="Design, validate, document and deploy Insights Hub asset models."
        meta={
          <ProjectsHeaderActions onCreate={() => void create()}>
            <ProjectImportActions />
          </ProjectsHeaderActions>
        }
      />
      <div className={styles.note}>
        <IxIcon name={iconInfo} size="16" color="color-info" aria-hidden="true" />
        <IxTypography format="body-sm" textColor="soft" className={styles.text}>
          Projects are stored locally in this browser (IndexedDB) and work offline — no tenant connection is needed to design
          and validate. Clearing the browser’s site data removes them; request persistent storage under Guardrails &amp;
          settings.
        </IxTypography>
        <IxButton variant="tertiary" icon={iconCogwheel} onClick={() => navigate("/settings")}>
          Storage settings
        </IxButton>
      </div>
      {body}
    </Page>
  );
}
