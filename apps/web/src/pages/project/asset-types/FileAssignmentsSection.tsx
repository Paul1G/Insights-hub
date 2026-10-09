// File assignments of an asset type: key (pattern \w+) → project file.

import { useNavigate } from "react-router";
import { IxButton, IxIconButton, IxInput, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { iconAdd, iconTrashcan } from "@siemens/ix-icons/icons";
import { notifyError } from "@/components/notify";
import type { AssetTypeDef, Project } from "@/domain/model";
import { DomainError, uniqueName } from "@/domain/ops";
import { fieldProps } from "@/features/types/fieldState";
import { DetailSection } from "@/features/types/MasterDetail";
import { useEntityIssues, useProject } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import styles from "./AssetTypes.module.css";

function findType(d: Project, uid: string): AssetTypeDef {
  const t = d.assetTypes.find((x) => x.uid === uid);
  if (!t) throw new DomainError("Asset type not found.");
  return t;
}

export function FileAssignmentsSection({ type }: { type: AssetTypeDef }) {
  const project = useProject();
  const navigate = useNavigate();
  const apply = useProjectStore((s) => s.apply);
  const issues = useEntityIssues(type.uid);
  const files = [...project.files].sort((a, b) => a.name.localeCompare(b.name));

  const edit = (position: number, label: string, mutate: (fa: AssetTypeDef["fileAssignments"][number]) => void, field: string) => {
    try {
      apply(
        label,
        (d) => {
          const fa = findType(d, type.uid).fileAssignments[position];
          if (!fa) throw new DomainError("File assignment not found.");
          mutate(fa);
        },
        { coalesceKey: `${type.uid}:file:${position}:${field}` },
      );
    } catch (e) {
      notifyError(e);
    }
  };

  const add = () => {
    const file = files[0];
    if (!file) return;
    const key = uniqueName("file", type.fileAssignments.map((f) => f.key));
    try {
      apply(`Assign file to ${type.name}`, (d) => {
        findType(d, type.uid).fileAssignments.push({ key, fileUid: file.uid });
      });
    } catch (e) {
      notifyError(e);
    }
  };

  const remove = (position: number) => {
    try {
      apply(`Remove file assignment from ${type.name}`, (d) => {
        findType(d, type.uid).fileAssignments.splice(position, 1);
      });
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <DetailSection
      title={`File assignments (${type.fileAssignments.length})`}
      description="Files assigned to the type under a key (letters, digits and _). Assets of the type inherit the assignments."
      actions={
        files.length ? (
          <IxButton variant="secondary" icon={iconAdd} onClick={add}>
            Assign file
          </IxButton>
        ) : (
          <IxButton variant="secondary" icon={iconAdd} onClick={() => navigate(`/p/${project.id}/files`)}>
            Add files to the project
          </IxButton>
        )
      }
    >
      {type.fileAssignments.length ? (
        <ul className={styles.aspectList}>
          {type.fileAssignments.map((fa, i) => {
            const fieldIssueList = issues.filter((x) => x.target.field === `fileAssignments.${fa.key}`);
            return (
              <li key={`${i}:${fa.fileUid}`} className={styles.fileRow} aria-label={`File assignment ${fa.key || "(no key)"}`}>
                <IxInput
                  label="Key"
                  value={fa.key}
                  required
                  onValueChange={(e) => {
                    const key = e.detail;
                    if (key !== fa.key) edit(i, `Change file assignment key`, (x) => (x.key = key), "key");
                  }}
                  {...fieldProps(fieldIssueList)}
                />
                <IxSelect
                  label="File"
                  value={fa.fileUid}
                  onValueChange={(e) => {
                    const uid = String(e.detail);
                    if (uid !== fa.fileUid) edit(i, `Change assigned file`, (x) => (x.fileUid = uid), "file");
                  }}
                >
                  {files.map((f) => (
                    <IxSelectItem key={f.uid} value={f.uid} label={f.name} />
                  ))}
                </IxSelect>
                <IxIconButton
                  icon={iconTrashcan}
                  variant="danger-tertiary"
                  aria-label={`Remove file assignment ${fa.key || "(no key)"}`}
                  onClick={() => remove(i)}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <IxTypography format="body-sm" textColor="soft">
          {files.length ? "No files assigned." : "The project has no files yet."}
        </IxTypography>
      )}
    </DetailSection>
  );
}
