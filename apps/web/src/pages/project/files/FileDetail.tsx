// Detail editor of one project file: name, description, scope, content
// (download / replace), assignments (add / remove) and delete.

import { useRef, useState } from "react";
import {
  IxButton,
  IxCard,
  IxCardContent,
  IxIconButton,
  IxInput,
  IxMessageBar,
  IxSelect,
  IxSelectItem,
  IxTextarea,
  IxTypography,
} from "@siemens/ix-react";
import { iconAdd, iconDownload, iconLink, iconTrashcan, iconUpload } from "@siemens/ix-icons/icons";
import { confirmDialog } from "@/components/dialogs";
import { IssueList } from "@/components/IssueList";
import { notifyError, notifySuccess } from "@/components/notify";
import { Section } from "@/components/Page";
import { checkContentType } from "@/domain/mime";
import type { FileDef, Scope } from "@/domain/model";
import { DomainError } from "@/domain/ops";
import type { ModelIndex } from "@/domain/resolve";
import { LIMITS } from "@/domain/rules";
import { useEntityIssues } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import { getFileBlob, putFileBlob, sha256Hex, deleteFileBlob } from "@/storage/repository";
import { fieldState } from "../hierarchy/fields";
import { openAssignDialog } from "./AssignDialog";
import { downloadBlob, formatBytes } from "./download";
import { deleteBlobIfUnreferenced } from "./fileStore";
import { checkUpload, fileDescriptionError, fileNameError, mimeMessage } from "./fileRules";
import styles from "./FilesPage.module.css";

const SHOWN_ASSIGNMENTS = 100;

function editFile(uid: string, label: string, recipe: (f: FileDef) => void, coalesce?: string) {
  try {
    useProjectStore.getState().apply(
      label,
      (d) => {
        const f = d.files.find((x) => x.uid === uid);
        if (!f) throw new DomainError("File not found.");
        recipe(f);
      },
      coalesce ? { coalesceKey: `file:${uid}:${coalesce}` } : undefined,
    );
  } catch (e) {
    notifyError(e);
  }
}

export function FileDetail({
  uid,
  index,
  contentMissing,
  onDeleted,
  onOpenAsset,
  onOpenAssetType,
}: {
  uid: string;
  index: ModelIndex;
  contentMissing: boolean;
  onDeleted(): void;
  onOpenAsset(uid: string): void;
  onOpenAssetType(uid: string): void;
}) {
  const file = index.files.get(uid);
  const issues = useEntityIssues(uid);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [labelName] = useState(file?.name ?? "");
  const [busy, setBusy] = useState(false);
  if (!file) return null;

  const others = index.project.files.filter((f) => f.uid !== uid).map((f) => f.name);
  const nameErr = fileNameError(file.name, others);
  const descErr = fileDescriptionError(file.description ?? "");
  const mime = checkContentType(file.name, file.mimeType);
  const mimeMsg = mimeMessage(mime, file.mimeType);
  const usage = index.fileUsage(uid);
  const assetRows = usage.assets.flatMap((a) => a.fileAssignments.filter((fa) => fa.fileUid === uid).map((fa) => ({ owner: a, key: fa.key })));
  const typeRows = usage.assetTypes.flatMap((t) => t.fileAssignments.filter((fa) => fa.fileUid === uid).map((fa) => ({ owner: t, key: fa.key })));

  async function download() {
    if (!file) return;
    const blob = await getFileBlob(file.blobId);
    if (!blob) {
      notifyError("The file content is not stored locally any more. Replace the content to repair the file.");
      return;
    }
    downloadBlob(blob, file.name);
  }

  async function replace(list: FileList | null) {
    const picked = list?.[0];
    if (!file || !picked) return;
    const check = checkUpload(picked, file.name);
    if (check.error) {
      notifyError(check.error, "Content not replaced");
      return;
    }
    setBusy(true);
    try {
      const sha256 = await sha256Hex(picked);
      const blobId = await putFileBlob(index.project.id, picked);
      const old = file.blobId;
      try {
        useProjectStore.getState().apply(`Replace content of “${file.name}”`, (d) => {
          const f = d.files.find((x) => x.uid === uid);
          if (!f) throw new DomainError("File not found.");
          f.mimeType = check.mimeType;
          f.size = picked.size;
          f.sha256 = sha256;
          f.blobId = blobId;
        });
      } catch (e) {
        await deleteFileBlob(blobId);
        throw e;
      }
      await deleteBlobIfUnreferenced(index.project.id, old);
      notifySuccess(`Content of “${file.name}” replaced${check.notes.length ? ` — ${check.notes.join(" ")}` : "."}`);
    } catch (e) {
      notifyError(e, "Content not replaced");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!file) return;
    const total = assetRows.length + typeRows.length;
    const ok = await confirmDialog({
      title: `Delete file “${file.name}”`,
      message:
        total > 0
          ? `The file and its ${total} assignment(s) will be removed from the project.`
          : "The file will be removed from the project. It is not assigned anywhere.",
      confirmLabel: "Delete file",
      danger: true,
      details:
        total > 0 ? (
          <ul className={styles.list}>
            {typeRows.map((r) => (
              <li key={`t:${r.owner.uid}:${r.key}`}>
                Asset type {r.owner.name} · key {r.key}
              </li>
            ))}
            {assetRows.slice(0, 50).map((r) => (
              <li key={`a:${r.owner.uid}:${r.key}`}>
                Asset {r.owner.name} · key {r.key}
              </li>
            ))}
            {assetRows.length > 50 ? <li>… and {assetRows.length - 50} more asset assignment(s)</li> : null}
          </ul>
        ) : undefined,
    });
    if (!ok) return;
    try {
      useProjectStore.getState().apply(`Delete file “${file.name}”`, (d) => {
        d.files = d.files.filter((f) => f.uid !== uid);
        for (const a of d.assets) {
          if (a.fileAssignments.some((fa) => fa.fileUid === uid)) a.fileAssignments = a.fileAssignments.filter((fa) => fa.fileUid !== uid);
        }
        for (const t of d.assetTypes) {
          if (t.fileAssignments.some((fa) => fa.fileUid === uid)) t.fileAssignments = t.fileAssignments.filter((fa) => fa.fileUid !== uid);
        }
      });
      await deleteBlobIfUnreferenced(index.project.id, file.blobId);
      notifySuccess(`File “${file.name}” deleted.`);
      onDeleted();
    } catch (e) {
      notifyError(e);
    }
  }

  function unassign(kind: "asset" | "assetType", ownerUid: string, key: string) {
    try {
      useProjectStore.getState().apply(`Remove file assignment ${key}`, (d) => {
        const owner = kind === "asset" ? d.assets.find((a) => a.uid === ownerUid) : d.assetTypes.find((t) => t.uid === ownerUid);
        if (!owner) throw new DomainError("The assignment target no longer exists.");
        owner.fileAssignments = owner.fileAssignments.filter((fa) => !(fa.fileUid === uid && fa.key === key));
      });
    } catch (e) {
      notifyError(e);
    }
  }

  return (
    <IxCard variant="outline" className={styles.card}>
      <IxCardContent>
        <div className={styles.detail}>
          <div className={styles.headText}>
            <h2 className={`typography-h3 ${styles.heading}`}>{file.name || "(unnamed file)"}</h2>
            <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
              {file.mimeType} · {formatBytes(file.size)} · SHA-256 {file.sha256.slice(0, 16)}…
            </IxTypography>
          </div>
          <div className={styles.actions} role="toolbar" aria-label="File actions">
            <IxButton variant="secondary" icon={iconDownload} disabled={contentMissing} onClick={() => void download()}>
              Download
            </IxButton>
            <IxButton variant="secondary" icon={iconUpload} loading={busy} onClick={() => replaceRef.current?.click()}>
              Replace content
            </IxButton>
            <IxButton variant="secondary" icon={iconAdd} onClick={() => openAssignDialog(uid)}>
              Assign
            </IxButton>
            <IxButton variant="danger-secondary" icon={iconTrashcan} onClick={() => void remove()}>
              Delete file
            </IxButton>
            <input
              ref={replaceRef}
              type="file"
              className={styles.hiddenInput}
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                void replace(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          {contentMissing ? (
            <IxMessageBar persistent type="alarm">
              The content of this file is no longer stored locally (for example after undoing a deletion). Replace the content before
              deploying.
            </IxMessageBar>
          ) : null}
          {mimeMsg ? (
            <IxMessageBar persistent type={mime.ok || mime.reason !== "mismatch" ? "warning" : "alarm"}>
              {mimeMsg}
            </IxMessageBar>
          ) : null}

          <div className={styles.fieldGrid}>
            <IxInput
              label="File name"
              required
              value={file.name}
              maxLength={LIMITS.fileNameMax}
              helperText={nameErr ? undefined : "Used as the file name in the Files API; no whitespace or * & % / \\."}
              {...fieldState(issues, "name", nameErr)}
              onValueChange={(e) => editFile(uid, `Rename file “${labelName}”`, (f) => void (f.name = e.detail), "name")}
            />
            <IxSelect
              label="Scope"
              value={file.scope}
              helperText="Scope of the file in the Files API (default private)."
              onValueChange={(e) => {
                const v = e.detail;
                if (v === "private" || v === "public") editFile(uid, `Set scope of “${file.name}”`, (f) => void (f.scope = v as Scope));
              }}
            >
              <IxSelectItem value="private" label="private" />
              <IxSelectItem value="public" label="public" />
            </IxSelect>
          </div>
          <IxTextarea textareaWidth="100%"
            label="Description"
            value={file.description ?? ""}
            maxLength={LIMITS.fileDescriptionMax}
            textareaRows={3}
            resizeBehavior="vertical"
            {...fieldState(issues, "description", descErr)}
            onValueChange={(e) =>
              editFile(uid, `Edit description of “${labelName}”`, (f) => {
                if (e.detail) f.description = e.detail;
                else delete f.description;
              }, "description")
            }
          />

          <Section title="Assignments" level="h3">
            {assetRows.length + typeRows.length === 0 ? (
              <IxTypography format="body-sm" textColor="soft">
                Not assigned to any asset or asset type.
              </IxTypography>
            ) : (
              <ul className={styles.list}>
                {typeRows.map((r) => (
                  <li key={`t:${r.owner.uid}:${r.key}`} className={styles.assignRow}>
                    <IxTypography format="body-sm" className={styles.wrap}>
                      Asset type <strong>{r.owner.name}</strong> · key {r.key}
                    </IxTypography>
                    <IxIconButton icon={iconLink} variant="subtle-tertiary" aria-label={`Open asset type ${r.owner.name}`} onClick={() => onOpenAssetType(r.owner.uid)} />
                    <IxIconButton
                      icon={iconTrashcan}
                      variant="subtle-tertiary"
                      aria-label={`Remove assignment ${r.key} from asset type ${r.owner.name}`}
                      onClick={() => unassign("assetType", r.owner.uid, r.key)}
                    />
                  </li>
                ))}
                {assetRows.slice(0, SHOWN_ASSIGNMENTS).map((r) => (
                  <li key={`a:${r.owner.uid}:${r.key}`} className={styles.assignRow}>
                    <IxTypography format="body-sm" className={styles.wrap}>
                      Asset <strong>{r.owner.name}</strong> · key {r.key}
                    </IxTypography>
                    <IxIconButton icon={iconLink} variant="subtle-tertiary" aria-label={`Open asset ${r.owner.name}`} onClick={() => onOpenAsset(r.owner.uid)} />
                    <IxIconButton
                      icon={iconTrashcan}
                      variant="subtle-tertiary"
                      aria-label={`Remove assignment ${r.key} from asset ${r.owner.name}`}
                      onClick={() => unassign("asset", r.owner.uid, r.key)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {assetRows.length > SHOWN_ASSIGNMENTS ? (
              <IxTypography format="body-sm" textColor="soft">
                Showing {SHOWN_ASSIGNMENTS} of {assetRows.length.toLocaleString()} asset assignments.
              </IxTypography>
            ) : null}
          </Section>
          {issues.length ? (
            <Section title="Issues" level="h3">
              <IssueList issues={issues} />
            </Section>
          ) : null}
        </div>
      </IxCardContent>
    </IxCard>
  );
}
