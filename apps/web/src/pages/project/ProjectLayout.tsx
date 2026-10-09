// Layout for /p/:projectId/* — opens the project in the store and renders a
// toolbar with save state, undo/redo, snapshots and a validation summary.

import { useEffect } from "react";
import { Outlet, useNavigate, useParams } from "react-router";
import {
  IxButton,
  IxChip,
  IxEmptyState,
  IxIconButton,
  IxSpinner,
  IxTooltip,
  IxTypography,
} from "@siemens/ix-react";
import { iconError, iconHistory, iconRedo, iconUndo, iconWarning } from "@siemens/ix-icons/icons";
import { promptDialog } from "@/components/dialogs";
import { notifyError, notifySuccess } from "@/components/notify";
import { useCatalogStore } from "@/state/catalogStore";
import { useValidation } from "@/state/hooks";
import { useProjectStore, type SaveState } from "@/state/projectStore";
import styles from "./ProjectLayout.module.css";

const SAVE_LABEL: Record<SaveState, string> = {
  idle: "",
  pending: "Unsaved changes…",
  saving: "Saving…",
  saved: "All changes saved locally",
  error: "Saving failed",
};

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag.startsWith("IX-INPUT") || tag === "IX-TEXTAREA" || target.isContentEditable;
}

function ValidationSummary() {
  const result = useValidation();
  const navigate = useNavigate();
  const { projectId } = useParams();
  return (
    <IxButton variant="subtle-tertiary" onClick={() => navigate(`/p/${projectId}`)}>
      <span className={styles.actions}>
        <IxChip variant={result.errors ? "alarm" : "success"} icon={iconError} outline>
          {result.errors} errors
        </IxChip>
        <IxChip variant={result.warnings ? "warning" : "neutral"} icon={iconWarning} outline>
          {result.warnings} warnings
        </IxChip>
      </span>
    </IxButton>
  );
}

function Toolbar() {
  const project = useProjectStore((s) => s.project)!;
  const { saveState, saveError, past, future, undo, redo, snapshot } = useProjectStore();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || isTextTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const lastUndo = past[past.length - 1]?.label;
  const nextRedo = future[0]?.label;

  async function takeSnapshot() {
    const label = await promptDialog({
      title: "Save version snapshot",
      label: "Snapshot label",
      initial: `Version ${new Date().toLocaleString()}`,
      confirmLabel: "Save snapshot",
      validate: (v) => (v.trim() ? undefined : "Enter a label."),
    });
    if (!label) return;
    try {
      await snapshot(label.trim());
      notifySuccess(`Snapshot “${label.trim()}” saved.`);
    } catch (e) {
      notifyError(e, "Snapshot failed");
    }
  }

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Project toolbar">
      <div className={styles.identity}>
        <IxTypography format="label" className={styles.name}>
          {project.name}
        </IxTypography>
        <IxTypography format="body-xs" textColor={saveState === "error" ? "alarm" : "soft"} role="status">
          {saveState === "error" ? `${SAVE_LABEL.error}: ${saveError ?? ""}` : SAVE_LABEL[saveState]}
        </IxTypography>
      </div>
      <div className={styles.actions}>
        <ValidationSummary />
        <IxIconButton
          id="undo-button"
          icon={iconUndo}
          variant="subtle-tertiary"
          disabled={!lastUndo}
          aria-label={lastUndo ? `Undo ${lastUndo}` : "Undo"}
          onClick={undo}
        />
        <IxTooltip for="#undo-button">{lastUndo ? `Undo: ${lastUndo} (Ctrl+Z)` : "Nothing to undo"}</IxTooltip>
        <IxIconButton
          id="redo-button"
          icon={iconRedo}
          variant="subtle-tertiary"
          disabled={!nextRedo}
          aria-label={nextRedo ? `Redo ${nextRedo}` : "Redo"}
          onClick={redo}
        />
        <IxTooltip for="#redo-button">{nextRedo ? `Redo: ${nextRedo} (Ctrl+Shift+Z)` : "Nothing to redo"}</IxTooltip>
        <IxButton variant="subtle-secondary" icon={iconHistory} onClick={() => void takeSnapshot()}>
          Snapshot
        </IxButton>
      </div>
    </div>
  );
}

export function ProjectLayout() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { project, loading, loadError, open } = useProjectStore();

  useEffect(() => {
    if (projectId) void open(projectId);
  }, [projectId, open]);

  // Load the linked tenant catalog (existing types) from local storage.
  const linkedConnection = useCatalogStore((s) => (projectId ? s.links[projectId] : undefined));
  useEffect(() => {
    if (linkedConnection) void useCatalogStore.getState().ensure(linkedConnection);
  }, [linkedConnection]);

  if (loadError) {
    return (
      <div className={styles.center}>
        <IxEmptyState
          header="Project could not be opened"
          subHeader={loadError}
          action="Back to projects"
          onActionClick={() => navigate("/")}
        />
      </div>
    );
  }
  if (loading || !project || project.id !== projectId) {
    return (
      <div className={styles.center}>
        <IxSpinner size="large" />
      </div>
    );
  }
  return (
    <>
      <Toolbar />
      <Outlet />
    </>
  );
}
