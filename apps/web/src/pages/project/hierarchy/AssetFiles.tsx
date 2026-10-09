// File assignments of an asset (key → project file), plus the assignments
// inherited from its asset type chain (read-only).

import { useState } from "react";
import { IxButton, IxIconButton, IxInput, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { iconAdd, iconTrashcan } from "@siemens/ix-icons/icons";
import { Section } from "@/components/Page";
import type { AssetDef } from "@/domain/model";
import type { ModelIndex, ResolvedAssetType } from "@/domain/resolve";
import type { Issue } from "@/domain/validator";
import type { AssetEdit } from "./editAsset";
import { fieldState, fileKeyError } from "./fields";
import styles from "./AssetDetail.module.css";

export function AssetFiles({
  asset,
  resolved,
  index,
  issues,
  edit,
  labelName,
  onOpenFiles,
}: {
  asset: AssetDef;
  resolved: ResolvedAssetType | undefined;
  index: ModelIndex;
  issues: Issue[];
  edit: AssetEdit;
  labelName: string;
  onOpenFiles(): void;
}) {
  const files = index.project.files;
  const [key, setKey] = useState("");
  const [fileUid, setFileUid] = useState<string>("");
  const keyErr = key ? fileKeyError(key, asset.fileAssignments.map((f) => f.key)) : undefined;

  const inherited = (resolved?.chain ?? [])
    .filter((r) => r.kind === "project")
    .flatMap((r) => {
      const t = r.kind === "project" ? index.assetTypes.get(r.uid) : undefined;
      return (t?.fileAssignments ?? []).map((fa) => ({ ...fa, typeName: t!.name }));
    });

  function add() {
    if (!key || keyErr || !fileUid) return;
    edit(`Assign file to “${labelName}”`, (a) => {
      a.fileAssignments.push({ key, fileUid });
    });
    setKey("");
    setFileUid("");
  }

  return (
    <div className={styles.form}>
      <Section title="Assigned files" level="h3">
        {files.length === 0 ? (
          <div className={styles.inlineRow}>
            <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
              The project has no files yet. Upload files on the Files page, then assign them here.
            </IxTypography>
            <IxButton variant="secondary" onClick={onOpenFiles}>
              Open files
            </IxButton>
          </div>
        ) : null}
        {asset.fileAssignments.length === 0 ? (
          <IxTypography format="body-sm" textColor="soft">
            No files assigned to this asset.
          </IxTypography>
        ) : (
          <ul className={styles.list}>
            {asset.fileAssignments.map((fa, i) => (
              <li key={`${fa.key}:${i}`} className={styles.assignment}>
                <IxInput
                  label="Key"
                  value={fa.key}
                  {...fieldState(issues, `fileAssignments.${fa.key}`)}
                  onValueChange={(e) =>
                    edit(`Edit file assignment of “${labelName}”`, (a) => {
                      const target = a.fileAssignments[i];
                      if (target) target.key = e.detail;
                    }, `file-key-${i}`)
                  }
                />
                <IxSelect
                  label="File"
                  value={fa.fileUid}
                  onValueChange={(e) => {
                    const v = Array.isArray(e.detail) ? e.detail[0] : e.detail;
                    if (!v) return;
                    edit(`Edit file assignment of “${labelName}”`, (a) => {
                      const target = a.fileAssignments[i];
                      if (target) target.fileUid = v;
                    });
                  }}
                >
                  {!index.files.has(fa.fileUid) ? <IxSelectItem value={fa.fileUid} label="(missing file)" /> : null}
                  {files.map((f) => (
                    <IxSelectItem key={f.uid} value={f.uid} label={f.name} />
                  ))}
                </IxSelect>
                <IxIconButton
                  icon={iconTrashcan}
                  variant="subtle-tertiary"
                  aria-label={`Remove file assignment ${fa.key}`}
                  onClick={() =>
                    edit(`Remove file assignment ${fa.key} from “${labelName}”`, (a) => {
                      a.fileAssignments.splice(i, 1);
                    })
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {files.length > 0 ? (
          <form
            className={styles.assignment}
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <IxInput
              label="New key"
              value={key}
              placeholder="e.g. manual"
              invalidText={keyErr}
              className={keyErr ? "ix-invalid" : undefined}
              onValueChange={(e) => setKey(e.detail)}
            />
            <IxSelect
              label="File"
              value={fileUid}
              i18nPlaceholder="Choose a file"
              onValueChange={(e) => {
                const v = Array.isArray(e.detail) ? e.detail[0] : e.detail;
                setFileUid(v ?? "");
              }}
            >
              {files.map((f) => (
                <IxSelectItem key={f.uid} value={f.uid} label={f.name} />
              ))}
            </IxSelect>
            <IxButton variant="secondary" icon={iconAdd} disabled={!key || !!keyErr || !fileUid} onClick={add}>
              Assign
            </IxButton>
          </form>
        ) : null}
      </Section>
      <Section title="Inherited from the asset type" level="h3">
        {inherited.length === 0 ? (
          <IxTypography format="body-sm" textColor="soft">
            The asset type assigns no files.
          </IxTypography>
        ) : (
          <ul className={styles.list}>
            {inherited.map((fa) => (
              <li key={`${fa.typeName}:${fa.key}`}>
                <IxTypography format="body-sm" className={styles.wrap}>
                  <strong>{fa.key}</strong> → {index.files.get(fa.fileUid)?.name ?? "(missing file)"} · from {fa.typeName}
                </IxTypography>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
