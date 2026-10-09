// Project files (/p/:projectId/files): upload (≤ 5 MB each, content type
// checked against the extension), list with assignments, edit, download,
// replace content, assign to assets / asset types, delete. The route's
// <h1> is rendered by the shared PageHeader.

import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { IxButton, IxChip, IxEmptyState, IxMessageBar, IxTypography } from "@siemens/ix-react";
import { iconUpload } from "@siemens/ix-icons/icons";
import { IssueCounts } from "@/components/IssueList";
import { notifyError, notifySuccess } from "@/components/notify";
import { Page } from "@/components/Page";
import { PageHeader } from "@/components/PageHeader";
import { newUid, type FileDef } from "@/domain/model";
import { useModelIndex, useProject, useValidation } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import { db } from "@/storage/db";
import { deleteFileBlob, putFileBlob, sha256Hex } from "@/storage/repository";
import { formatBytes } from "./download";
import { FileDetail } from "./FileDetail";
import { checkUpload, uniqueFileName } from "./fileRules";
import styles from "./FilesPage.module.css";

interface UploadReport {
  added: string[];
  rejected: string[];
  notes: string[];
}

export function FilesPage() {
  const project = useProject();
  const index = useModelIndex();
  const validation = useValidation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<UploadReport | null>(null);
  const blobIds = useLiveQuery(
    () => db.fileBlobs.where("projectId").equals(project.id).primaryKeys(),
    [project.id],
  );
  const present = blobIds ? new Set(blobIds) : undefined;

  const files = [...project.files].sort((a, b) => a.name.localeCompare(b.name));
  const selectedUid = params.get("file") && index.files.has(params.get("file")!) ? params.get("file")! : files[0]?.uid;
  const select = (uid: string | undefined) => setParams(uid ? { file: uid } : {}, { replace: true });

  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    const added: FileDef[] = [];
    const rejected: string[] = [];
    const notes: string[] = [];
    try {
      for (const file of Array.from(list)) {
        const check = checkUpload(file);
        if (check.error) {
          rejected.push(check.error);
          continue;
        }
        const name = uniqueFileName(check.name, [...project.files.map((f) => f.name), ...added.map((f) => f.name)]);
        if (name !== check.name) notes.push(`“${check.name}” already exists; added as “${name}”.`);
        notes.push(...check.notes.map((n) => `${name}: ${n}`));
        const sha256 = await sha256Hex(file);
        const duplicate = project.files.find((f) => f.sha256 === sha256);
        if (duplicate) notes.push(`${name} has the same content as “${duplicate.name}”.`);
        const blobId = await putFileBlob(project.id, file);
        added.push({ uid: newUid(), name, scope: "private", mimeType: check.mimeType, size: file.size, sha256, blobId });
      }
      if (added.length) {
        try {
          useProjectStore.getState().apply(`Upload ${added.length} file(s)`, (d) => {
            d.files.push(...added);
          });
        } catch (e) {
          await Promise.all(added.map((f) => deleteFileBlob(f.blobId)));
          throw e;
        }
        notifySuccess(`${added.length} file(s) added.`);
        select(added[0]!.uid);
      }
      setReport({ added: added.map((f) => f.name), rejected, notes });
    } catch (e) {
      notifyError(e, "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const usageCount = (uid: string) => {
    const u = index.fileUsage(uid);
    return { assets: u.assets.length, assetTypes: u.assetTypes.length };
  };

  return (
    <Page>
      <PageHeader
        title="Files"
        subtitle={`${files.length} file${files.length === 1 ? "" : "s"} · stored locally, uploaded to the Files API on deployment (max 5 MB each)`}
        primaryAction={{ label: busy ? "Uploading…" : "Upload files", icon: iconUpload, onClick: () => !busy && inputRef.current?.click() }}
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          void upload(e.target.files);
          e.target.value = "";
        }}
      />
      {report ? (
        <div className={styles.report} role="status">
          {report.rejected.map((r) => (
            <IxMessageBar key={r} persistent type="alarm">
              Not added — {r}
            </IxMessageBar>
          ))}
          {report.notes.map((n) => (
            <IxMessageBar key={n} persistent type="warning">
              {n}
            </IxMessageBar>
          ))}
          <div>
            <IxButton variant="tertiary" onClick={() => setReport(null)}>
              Dismiss upload notes
            </IxButton>
          </div>
        </div>
      ) : null}

      {files.length === 0 ? (
        <IxEmptyState
          header="No files yet"
          subHeader="Upload manuals, drawings or certificates and assign them to assets or asset types. Files up to 5 MB are supported."
          icon={iconUpload}
          action="Upload files"
          onActionClick={() => inputRef.current?.click()}
        />
      ) : (
        <div className={styles.layout}>
          <section className={styles.listPane} aria-labelledby="files-list-title">
            <h2 id="files-list-title" className={`typography-h4 ${styles.heading}`}>
              Project files
            </h2>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>Project files</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Content type</th>
                    <th scope="col" className={styles.num}>
                      Size
                    </th>
                    <th scope="col">Scope</th>
                    <th scope="col">Assigned to</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => {
                    const u = usageCount(f.uid);
                    const selected = f.uid === selectedUid;
                    const missing = present !== undefined && !present.has(f.blobId);
                    return (
                      <tr key={f.uid} className={selected ? styles.selected : undefined} aria-current={selected ? "true" : undefined}>
                        <th scope="row" className={styles.cellWrap}>
                          <button type="button" className={styles.linkButton} onClick={() => select(f.uid)}>
                            {f.name || "(unnamed file)"}
                          </button>
                          <span className={styles.cellMeta}>
                            <IssueCounts issues={validation.byEntity.get(f.uid) ?? []} />
                            {missing ? (
                              <IxChip variant="alarm" outline>
                                Content missing
                              </IxChip>
                            ) : null}
                          </span>
                        </th>
                        <td className={styles.cellWrap}>{f.mimeType}</td>
                        <td className={styles.num}>{formatBytes(f.size)}</td>
                        <td>{f.scope}</td>
                        <td className={styles.cellWrap}>
                          {u.assets + u.assetTypes === 0 ? (
                            <IxTypography format="body-sm" textColor="soft">
                              Not assigned
                            </IxTypography>
                          ) : (
                            `${u.assets.toLocaleString()} asset(s), ${u.assetTypes} type(s)`
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <section className={styles.detailPane} aria-label="Selected file">
            {selectedUid ? (
              <FileDetail
                key={selectedUid}
                uid={selectedUid}
                index={index}
                contentMissing={present !== undefined && !present.has(index.files.get(selectedUid)?.blobId ?? "")}
                onDeleted={() => select(undefined)}
                onOpenAsset={(uid) => navigate(`/p/${project.id}/hierarchy/${uid}`)}
                onOpenAssetType={(uid) => navigate(`/p/${project.id}/asset-types/${uid}`)}
              />
            ) : null}
          </section>
        </div>
      )}
    </Page>
  );
}
