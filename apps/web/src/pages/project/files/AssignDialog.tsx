// "Assign file" dialog: key + target (an asset via the searchable picker, or
// a project asset type).

import { useMemo, useState } from "react";
import {
  IxButton,
  IxInput,
  IxModalContent,
  IxModalFooter,
  IxModalHeader,
  IxRadio,
  IxRadioGroup,
  IxSelect,
  IxSelectItem,
  IxTypography,
} from "@siemens/ix-react";
import { iconAttach } from "@siemens/ix-icons/icons";
import { notifyError, notifySuccess } from "@/components/notify";
import { ROOT_ASSET_UID } from "@/domain/model";
import { DomainError, toIdentifier } from "@/domain/ops";
import { useModelIndex } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import { AssetPicker } from "../hierarchy/AssetPicker";
import { fileKeyError } from "../hierarchy/fields";
import { openModal } from "../hierarchy/modal";
import styles from "./FilesPage.module.css";

function defaultKey(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return toIdentifier(dot > 0 ? fileName.slice(0, dot) : fileName, "file");
}

function AssignBody({ fileUid, close }: { fileUid: string; close(): void }) {
  const index = useModelIndex();
  const file = index.files.get(fileUid);
  const [kind, setKind] = useState<"asset" | "assetType">("asset");
  const [key, setKey] = useState(() => defaultKey(file?.name ?? "file"));
  const [assetUid, setAssetUid] = useState<string | undefined>();
  const [typeUid, setTypeUid] = useState<string>("");
  const exclude = useMemo(() => new Set([ROOT_ASSET_UID]), []);
  const types = [...index.project.assetTypes].sort((a, b) => a.name.localeCompare(b.name));
  const target = kind === "asset" ? (assetUid ? index.assets.get(assetUid) : undefined) : index.assetTypes.get(typeUid);
  const keyErr = fileKeyError(key, target?.fileAssignments.map((f) => f.key) ?? []);
  const disabled = !file || !target || !!keyErr;

  function assign() {
    if (disabled || !target) return;
    try {
      useProjectStore.getState().apply(`Assign file “${file!.name}” to “${target.name}”`, (d) => {
        const owner = kind === "asset" ? d.assets.find((a) => a.uid === target.uid) : d.assetTypes.find((t) => t.uid === target.uid);
        if (!owner) throw new DomainError("The target no longer exists.");
        owner.fileAssignments.push({ key, fileUid });
      });
      notifySuccess(`Assigned to “${target.name}” as ${key}.`);
      close();
    } catch (e) {
      notifyError(e);
    }
  }

  return (
    <>
      <IxModalHeader icon={iconAttach} iconColor="color-primary" ariaLabelIcon="Assign file">
        <h2 className={`typography-h5 ${styles.heading}`}>Assign “{file?.name}”</h2>
      </IxModalHeader>
      <IxModalContent>
        <div className={styles.detail}>
          <IxRadioGroup label="Assign to" value={kind} direction="row" onValueChange={(e) => setKind(e.detail === "assetType" ? "assetType" : "asset")}>
            <IxRadio label="Asset" value="asset" />
            <IxRadio label="Asset type (inherited by its assets)" value="assetType" />
          </IxRadioGroup>
          {kind === "asset" ? (
            <AssetPicker index={index} value={assetUid} onChange={setAssetUid} exclude={exclude} label="Asset" idPrefix="assign-asset" />
          ) : types.length ? (
            <IxSelect
              label="Asset type"
              value={typeUid}
              i18nPlaceholder="Choose an asset type"
              onValueChange={(e) => {
                const v = Array.isArray(e.detail) ? e.detail[0] : e.detail;
                setTypeUid(v ?? "");
              }}
            >
              {types.map((t) => (
                <IxSelectItem key={t.uid} value={t.uid} label={`${t.name} ({tenant}.${t.idSuffix})`} />
              ))}
            </IxSelect>
          ) : (
            <IxTypography format="body-sm" textColor="soft">
              The project has no asset types yet.
            </IxTypography>
          )}
          <IxInput
            label="Assignment key"
            value={key}
            helperText={keyErr ? undefined : "Letters, digits and _; unique per asset or asset type."}
            invalidText={target ? keyErr : undefined}
            className={target && keyErr ? "ix-invalid" : undefined}
            onValueChange={(e) => setKey(e.detail)}
          />
        </div>
      </IxModalContent>
      <IxModalFooter>
        <IxButton variant="secondary" onClick={close}>
          Cancel
        </IxButton>
        <IxButton variant="primary" disabled={disabled} onClick={assign}>
          Assign file
        </IxButton>
      </IxModalFooter>
    </>
  );
}

export function openAssignDialog(fileUid: string): void {
  openModal({ title: "Assign file", size: "720", render: (close) => <AssignBody fileUid={fileUid} close={close} /> });
}
