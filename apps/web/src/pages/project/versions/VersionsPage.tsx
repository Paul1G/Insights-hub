// Versions (/p/:projectId/versions): snapshots (create, compare, restore,
// delete) and the project change log. The route's <h1> is rendered by the
// shared PageHeader.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useLiveQuery } from "dexie-react-hooks";
import {
  IxButton,
  IxChip,
  IxIcon,
  IxInput,
  IxMessageBar,
  IxSelect,
  IxSelectItem,
  IxSpinner,
  IxTypography,
} from "@siemens/ix-react";
import { iconCompare, iconHistory, iconRestore, iconSearch, iconTrashcan } from "@siemens/ix-icons/icons";
import { DashboardGrid } from "@/components/DashboardGrid";
import { DashboardPanel } from "@/components/DashboardPanel";
import { confirmDialog, promptDialog } from "@/components/dialogs";
import { DiffView } from "@/components/DiffView";
import { notifyError, notifySuccess } from "@/components/notify";
import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { diffProjects, type EntityChange, type ProjectDiff } from "@/domain/diff";
import type { Project } from "@/domain/model";
import { useProject } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import type { SnapshotRecord } from "@/storage/db";
import { deleteSnapshot, getSnapshot, listSnapshots } from "@/storage/repository";
import { KIND_LABEL, countByKind, filterEntities, searchChangelog, type ChangeFilter, type KindFilter } from "./compare";
import styles from "./VersionsPage.module.css";

const CURRENT = "current";
const ENTITY_PAGE = 200;
const LOG_PAGE = 100;

const CHANGE_VARIANT: Record<EntityChange["change"], "success" | "alarm" | "warning"> = {
  added: "success",
  removed: "alarm",
  modified: "warning",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function countsText(c: SnapshotRecord["counts"]): string {
  return `${c.aspectTypes} aspect types · ${c.assetTypes} asset types · ${c.assets.toLocaleString()} assets · ${c.files} files`;
}

function EntityRow({ entity, onOpen }: { entity: EntityChange; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const panelId = `diff-${entity.kind}-${entity.uid}`;
  return (
    <li className={styles.entity}>
      <div className={styles.entityHead}>
        <IxChip variant={CHANGE_VARIANT[entity.change]} outline>
          {entity.change}
        </IxChip>
        <IxTypography format="label-sm" textColor="soft">
          {KIND_LABEL[entity.kind]}
        </IxTypography>
        <IxTypography format="body" className={styles.wrap}>
          {entity.label || "(unnamed)"}
        </IxTypography>
        <span className={styles.spacer} />
        {entity.change === "modified" ? (
          <IxButton variant="tertiary" aria-expanded={open ? "true" : "false"} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Show"} {entity.fields.length} change{entity.fields.length === 1 ? "" : "s"}
          </IxButton>
        ) : null}
        {onOpen ? (
          <IxButton variant="tertiary" onClick={onOpen}>
            Open
          </IxButton>
        ) : null}
      </div>
      {entity.change === "modified" ? (
        <div id={panelId} hidden={!open}>
          {open ? <DiffView changes={entity.fields} /> : null}
        </div>
      ) : null}
    </li>
  );
}

function ComparePanel({ snapshots, project, from, to, setFrom, setTo }: {
  snapshots: SnapshotRecord[];
  project: Project;
  from: string;
  to: string;
  setFrom(v: string): void;
  setTo(v: string): void;
}) {
  const navigate = useNavigate();
  const cache = useRef(new Map<string, Project>());
  const [diff, setDiff] = useState<ProjectDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [change, setChange] = useState<ChangeFilter>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(ENTITY_PAGE);

  useEffect(() => {
    let cancelled = false;
    const load = async (id: string): Promise<Project | undefined> => {
      if (id === CURRENT) return project;
      const hit = cache.current.get(id);
      if (hit) return hit;
      const s = await getSnapshot(id);
      if (s) cache.current.set(id, s.project);
      return s?.project;
    };
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [before, after] = await Promise.all([load(from), load(to)]);
        if (cancelled) return;
        if (!before || !after) {
          setDiff(null);
          setError("The selected snapshot no longer exists.");
        } else setDiff(diffProjects(before, after));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [from, to, project]);

  useEffect(() => setLimit(ENTITY_PAGE), [from, to, kind, change, query]);

  const entities = useMemo(() => (diff ? filterEntities(diff, kind, change, query) : []), [diff, kind, change, query]);
  const counts = diff ? countByKind(diff) : undefined;
  const label = (id: string) => (id === CURRENT ? "Current state" : (snapshots.find((s) => s.id === id)?.label ?? "Snapshot"));

  const open = (e: EntityChange): (() => void) | undefined => {
    if (e.change === "removed" && to === CURRENT) return undefined;
    if (to !== CURRENT) return undefined;
    const base = `/p/${project.id}`;
    if (e.kind === "aspectType") return () => navigate(`${base}/aspect-types/${e.uid}`);
    if (e.kind === "assetType") return () => navigate(`${base}/asset-types/${e.uid}`);
    if (e.kind === "asset") return () => navigate(`${base}/hierarchy/${e.uid}`);
    return () => navigate(`${base}/files?file=${encodeURIComponent(e.uid)}`);
  };

  const options = [
    { id: CURRENT, label: "Current state" },
    ...snapshots.map((s) => ({ id: s.id, label: `${s.label} · ${formatTime(s.createdAt)}` })),
  ];

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <IxSelect label="Compare from (before)" value={from} onValueChange={(e) => typeof e.detail === "string" && setFrom(e.detail)}>
          {options.map((o) => (
            <IxSelectItem key={o.id} value={o.id} label={o.label} />
          ))}
        </IxSelect>
        <IxSelect label="Compare to (after)" value={to} onValueChange={(e) => typeof e.detail === "string" && setTo(e.detail)}>
          {options.map((o) => (
            <IxSelectItem key={o.id} value={o.id} label={o.label} />
          ))}
        </IxSelect>
        <IxButton
          variant="secondary"
          icon={iconCompare}
          onClick={() => {
            setFrom(to);
            setTo(from);
          }}
        >
          Swap
        </IxButton>
      </div>
      {loading ? <IxSpinner size="small" /> : null}
      {error ? (
        <IxMessageBar persistent type="alarm">
          {error}
        </IxMessageBar>
      ) : null}
      {diff && !loading ? (
        <>
          <div className={styles.summary} role="status">
            <IxTypography format="body" className={styles.wrap}>
              {label(from)} → {label(to)}:
            </IxTypography>
            <IxChip variant="success" outline>
              {diff.summary.added} added
            </IxChip>
            <IxChip variant="alarm" outline>
              {diff.summary.removed} removed
            </IxChip>
            <IxChip variant="warning" outline>
              {diff.summary.modified} modified
            </IxChip>
          </div>
          {diff.projectFields.length ? (
            <div className={styles.stack}>
              <h3 className={`typography-h5 ${styles.heading}`}>Project properties</h3>
              <DiffView changes={diff.projectFields} />
            </div>
          ) : null}
          {diff.entities.length === 0 && diff.projectFields.length === 0 ? (
            <IxTypography format="body-sm" textColor="soft">
              No differences.
            </IxTypography>
          ) : null}
          {diff.entities.length ? (
            <>
              <search aria-label="Filter changes" className={styles.toolbar}>
                <IxSelect label="Entity kind" value={kind} onValueChange={(e) => typeof e.detail === "string" && setKind(e.detail as KindFilter)}>
                  <IxSelectItem value="all" label={`All kinds (${diff.entities.length})`} />
                  {(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => (
                    <IxSelectItem key={k} value={k} label={`${KIND_LABEL[k]} (${counts?.[k] ?? 0})`} />
                  ))}
                </IxSelect>
                <IxSelect label="Change" value={change} onValueChange={(e) => typeof e.detail === "string" && setChange(e.detail as ChangeFilter)}>
                  <IxSelectItem value="all" label="All changes" />
                  <IxSelectItem value="added" label="Added" />
                  <IxSelectItem value="removed" label="Removed" />
                  <IxSelectItem value="modified" label="Modified" />
                </IxSelect>
                <IxInput label="Search by name" value={query} onValueChange={(e) => setQuery(e.detail)}>
                  <IxIcon slot="start" name={iconSearch} size="16" aria-hidden="true" />
                </IxInput>
              </search>
              <ul className={styles.entityList}>
                {entities.slice(0, limit).map((e) => (
                  <EntityRow key={`${e.kind}:${e.uid}`} entity={e} onOpen={open(e)} />
                ))}
              </ul>
              {entities.length > limit ? (
                <div className={styles.toolbar}>
                  <IxTypography format="body-sm" textColor="soft">
                    Showing {limit.toLocaleString()} of {entities.length.toLocaleString()} changes.
                  </IxTypography>
                  <IxButton variant="tertiary" onClick={() => setLimit((l) => l + ENTITY_PAGE)}>
                    Show more
                  </IxButton>
                </div>
              ) : null}
              {entities.length === 0 ? (
                <IxTypography format="body-sm" textColor="soft">
                  No changes match the filters.
                </IxTypography>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ChangeLog({ project }: { project: Project }) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(LOG_PAGE);
  const entries = useMemo(() => searchChangelog(project.changelog, query), [project.changelog, query]);
  useEffect(() => setLimit(LOG_PAGE), [query]);
  return (
    <div className={styles.stack}>
      <search aria-label="Search the change log" className={styles.toolbar}>
        <IxInput label="Search changes" value={query} placeholder="e.g. Pump" onValueChange={(e) => setQuery(e.detail)}>
          <IxIcon slot="start" name={iconSearch} size="16" aria-hidden="true" />
        </IxInput>
      </search>
      <IxTypography format="body-xs" textColor="soft" role="status">
        {entries.length.toLocaleString()} entr{entries.length === 1 ? "y" : "ies"}
      </IxTypography>
      <ol className={styles.log}>
        {entries.slice(0, limit).map((e, i) => (
          <li key={`${e.at}:${i}`} className={styles.logItem}>
            <IxTypography format="body-sm" textColor="soft" className={styles.time}>
              {formatTime(e.at)}
            </IxTypography>
            <IxTypography format="body-sm" className={styles.wrap}>
              {e.summary}
              {e.author ? ` · ${e.author}` : ""}
            </IxTypography>
          </li>
        ))}
      </ol>
      {entries.length > limit ? (
        <div>
          <IxButton variant="tertiary" onClick={() => setLimit((l) => l + LOG_PAGE)}>
            Show more
          </IxButton>
        </div>
      ) : null}
    </div>
  );
}

export function VersionsPage() {
  const project = useProject();
  const snapshots = useLiveQuery(() => listSnapshots(project.id), [project.id]);
  const [from, setFrom] = useState<string | undefined>();
  const [to, setTo] = useState(CURRENT);
  const [busy, setBusy] = useState<string | null>(null);

  const list = snapshots ?? [];
  const effectiveFrom = from && (from === CURRENT || list.some((s) => s.id === from)) ? from : (list[0]?.id ?? CURRENT);
  const effectiveTo = to === CURRENT || list.some((s) => s.id === to) ? to : CURRENT;

  async function create() {
    const label = await promptDialog({
      title: "Create snapshot",
      label: "Snapshot label",
      initial: `Version ${new Date().toLocaleString()}`,
      confirmLabel: "Create snapshot",
      validate: (v) => (v.trim() ? undefined : "Enter a label."),
    });
    if (!label) return;
    try {
      await useProjectStore.getState().snapshot(label.trim());
      notifySuccess(`Snapshot “${label.trim()}” created.`);
    } catch (e) {
      notifyError(e, "Snapshot failed");
    }
  }

  async function restore(s: SnapshotRecord) {
    let summary: ProjectDiff["summary"] | undefined;
    try {
      const snap = await getSnapshot(s.id);
      if (!snap) throw new Error("The snapshot no longer exists.");
      summary = diffProjects(useProjectStore.getState().project!, snap.project).summary;
      const ok = await confirmDialog({
        title: `Restore “${s.label}”`,
        message: `The project is replaced by the snapshot from ${formatTime(s.createdAt)}. The current state is saved first as an automatic snapshot, and the restore can be undone (Ctrl+Z).`,
        confirmLabel: "Restore snapshot",
        danger: true,
        details: (
          <IxTypography format="body-sm" className={styles.wrap}>
            Compared with the current state the restore adds {summary.added}, removes {summary.removed} and changes {summary.modified} entities.
            Snapshot contents: {countsText(s.counts)}.
          </IxTypography>
        ),
      });
      if (!ok) return;
      setBusy(s.id);
      const store = useProjectStore.getState();
      await store.snapshot(`Before restoring “${s.label}”`, true);
      store.replace(`Restore snapshot “${s.label}”`, snap.project);
      notifySuccess(`Restored “${s.label}”.`);
    } catch (e) {
      notifyError(e, "Restore failed");
    } finally {
      setBusy(null);
    }
  }

  async function remove(s: SnapshotRecord) {
    const ok = await confirmDialog({
      title: `Delete snapshot “${s.label}”`,
      message: "The snapshot is deleted permanently. This cannot be undone. The current project is not affected.",
      confirmLabel: "Delete snapshot",
      danger: true,
      details: (
        <IxTypography format="body-sm" className={styles.wrap}>
          {formatTime(s.createdAt)} · {countsText(s.counts)}
        </IxTypography>
      ),
    });
    if (!ok) return;
    try {
      await deleteSnapshot(s.id);
      notifySuccess(`Snapshot “${s.label}” deleted.`);
    } catch (e) {
      notifyError(e);
    }
  }

  return (
    <Page>
      <PageHeader
        title="Versions"
        subtitle="Snapshots of the whole project, comparison and restore, and the change log."
        primaryAction={{ label: "Create snapshot", icon: iconHistory, onClick: () => void create() }}
      />
      <DashboardGrid>
        <DashboardPanel title={`Snapshots${snapshots ? ` (${list.length})` : ""}`} span="full">
          {!snapshots ? (
            <IxSpinner size="small" />
          ) : list.length === 0 ? (
            <IxTypography format="body-sm" textColor="soft">
              No snapshots yet. Create one before larger changes; automatic snapshots are taken before restores, imports and deployments.
            </IxTypography>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>Snapshots</caption>
                <thead>
                  <tr>
                    <th scope="col">Label</th>
                    <th scope="col">Created</th>
                    <th scope="col">Contents</th>
                    <th scope="col" className={styles.actionsCol}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.id}>
                      <th scope="row" className={styles.cellWrap}>
                        <span className={styles.labelCell}>
                          {s.label}
                          {s.auto ? (
                            <IxChip variant="neutral" outline>
                              Automatic
                            </IxChip>
                          ) : null}
                        </span>
                      </th>
                      <td className={styles.nowrap}>{formatTime(s.createdAt)}</td>
                      <td className={styles.cellWrap}>{countsText(s.counts)}</td>
                      <td className={styles.actionsCol}>
                        <span className={styles.rowActions}>
                          <IxButton
                            variant="tertiary"
                            icon={iconCompare}
                            onClick={() => {
                              setFrom(s.id);
                              setTo(CURRENT);
                            }}
                          >
                            Compare with current
                          </IxButton>
                          <IxButton variant="tertiary" icon={iconRestore} loading={busy === s.id} onClick={() => void restore(s)}>
                            Restore
                          </IxButton>
                          <IxButton variant="danger-tertiary" icon={iconTrashcan} onClick={() => void remove(s)}>
                            Delete snapshot
                          </IxButton>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DashboardPanel>
        <DashboardPanel title="Compare" span="full">
          {list.length === 0 ? (
            <IxTypography format="body-sm" textColor="soft">
              Create a snapshot to compare it with the current state or with other snapshots.
            </IxTypography>
          ) : (
            <ComparePanel snapshots={list} project={project} from={effectiveFrom} to={effectiveTo} setFrom={setFrom} setTo={setTo} />
          )}
        </DashboardPanel>
        <DashboardPanel title="Change log" span="full">
          <ChangeLog project={project} />
        </DashboardPanel>
      </DashboardGrid>
    </Page>
  );
}
