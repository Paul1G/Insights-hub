// Dialogs of the hierarchy editor: add child, move to…, bulk create
// (name template and CSV). They render inside the iX modal host (outside the
// router), so navigation happens through the callbacks passed in.

import { useDeferredValue, useMemo, useRef, useState } from "react";
import {
  IxButton,
  IxInput,
  IxMessageBar,
  IxModalContent,
  IxModalFooter,
  IxModalHeader,
  IxNumberInput,
  IxSelect,
  IxSelectItem,
  IxTabItem,
  IxTabs,
  IxTextarea,
  IxTypography,
} from "@siemens/ix-react";
import { iconAdd, iconDocumentBulk, iconDownload, iconMove, iconUpload } from "@siemens/ix-icons/icons";
import { notifyError, notifySuccess } from "@/components/notify";
import { ROOT_ASSET_UID } from "@/domain/model";
import { DomainError, bulkCreateAssets, moveAsset, newAsset, uniqueName } from "@/domain/ops";
import { useModelIndex } from "@/state/hooks";
import { useProjectStore } from "@/state/projectStore";
import { BULK_MAX, planTemplate } from "@/features/hierarchy/bulkTemplate";
import { CSV_COLUMNS, createFromCsvPlan, csvTemplate, planCsvImport } from "@/features/hierarchy/csvImport";
import { assetNameError, externalIdError, instantiableTypeOptions, siblingNameSet, type TypeOption } from "@/features/hierarchy/types";
import { downloadBlob } from "../files/download";
import { AssetPicker } from "./AssetPicker";
import { assetPathLabel } from "./fields";
import { openModal } from "./modal";
import styles from "./AssetDialogs.module.css";

/** Last type chosen in a create dialog, offered as the default next time. */
let lastTypeKey: string | undefined;

export function TypeSelect({
  options,
  value,
  onChange,
  label = "Asset type",
  helperText,
  invalidText,
  readonly,
  extra,
}: {
  options: TypeOption[];
  value: string | undefined;
  onChange(key: string): void;
  label?: string;
  helperText?: string;
  invalidText?: string;
  readonly?: boolean;
  /** An item for the current value when it is not an option (e.g. an external type). */
  extra?: { key: string; label: string };
}) {
  return (
    <IxSelect
      label={label}
      value={value ?? ""}
      helperText={helperText}
      invalidText={invalidText}
      className={invalidText ? "ix-invalid" : undefined}
      readonly={readonly}
      i18nPlaceholder="Choose a type"
      onValueChange={(e) => {
        if (typeof e.detail === "string" && e.detail) onChange(e.detail);
      }}
    >
      {extra && !options.some((o) => o.key === extra.key) ? <IxSelectItem value={extra.key} label={extra.label} /> : null}
      {options.map((o) => (
        <IxSelectItem key={o.key} value={o.key} label={`${o.group === "core" ? "Core · " : ""}${o.label}`} />
      ))}
    </IxSelect>
  );
}

function DialogHeader({ title, icon }: { title: string; icon: string }) {
  return (
    <IxModalHeader icon={icon} iconColor="color-primary" ariaLabelIcon={title}>
      <h2 className={`typography-h5 ${styles.title}`}>{title}</h2>
    </IxModalHeader>
  );
}

function defaultTypeKey(options: TypeOption[]): string | undefined {
  if (lastTypeKey && options.some((o) => o.key === lastTypeKey)) return lastTypeKey;
  return (options.find((o) => o.group === "project") ?? options[0])?.key;
}

// ---------------------------------------------------------------------------
// Add child
// ---------------------------------------------------------------------------

function AddChildBody({ parentUid, close, onCreated }: { parentUid: string; close(): void; onCreated(uid: string): void }) {
  const index = useModelIndex();
  const options = useMemo(() => instantiableTypeOptions(index), [index]);
  const parent = index.assets.get(parentUid);
  const [name, setName] = useState(() => uniqueName("New asset", index.childrenOf(parentUid).map((a) => a.name), " "));
  const [typeKey, setTypeKey] = useState(() => defaultTypeKey(options));
  const [externalId, setExternalId] = useState("");
  const option = options.find((o) => o.key === typeKey);
  const nameErr =
    assetNameError(name) ??
    (siblingNameSet(index, parentUid).has(name.trim().toLowerCase())
      ? "Another asset under this parent already has this name (case-insensitive)."
      : undefined);
  const extErr = externalIdError(externalId);
  const disabled = !parent || !!nameErr || !!extErr || !option;

  function create() {
    if (disabled || !option) return;
    let created = "";
    try {
      useProjectStore.getState().apply(`Add asset “${name.trim()}”`, (d) => {
        if (!d.assets.some((a) => a.uid === parentUid)) throw new DomainError("The parent asset no longer exists.");
        const a = newAsset(name.trim(), option.ref, parentUid);
        if (externalId.trim()) a.externalId = externalId.trim();
        d.assets.push(a);
        created = a.uid;
      });
      lastTypeKey = option.key;
      close();
      onCreated(created);
    } catch (e) {
      notifyError(e);
    }
  }

  return (
    <>
      <DialogHeader title="Add child asset" icon={iconAdd} />
      <IxModalContent>
        <form
          className={styles.body}
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
            Parent: {parent ? assetPathLabel(index, parent.uid) : "(missing)"}
          </IxTypography>
          <IxInput
            label="Name"
            required
            value={name}
            maxLength={128}
            invalidText={nameErr}
            className={nameErr ? "ix-invalid" : undefined}
            onValueChange={(e) => setName(e.detail)}
          />
          <TypeSelect
            options={options}
            value={typeKey}
            onChange={setTypeKey}
            helperText="Instantiable project types and core types. Root hierarchy types are reserved for tenant roots."
            invalidText={option ? undefined : "Choose an asset type."}
          />
          <IxInput
            label="External id (optional)"
            value={externalId}
            invalidText={extErr}
            className={extErr ? "ix-invalid" : undefined}
            onValueChange={(e) => setExternalId(e.detail)}
          />
        </form>
      </IxModalContent>
      <IxModalFooter>
        <IxButton variant="secondary" onClick={close}>
          Cancel
        </IxButton>
        <IxButton variant="primary" disabled={disabled} onClick={create}>
          Add asset
        </IxButton>
      </IxModalFooter>
    </>
  );
}

export function openAddChildDialog(parentUid: string, onCreated: (uid: string) => void): void {
  openModal({ title: "Add child asset", size: "600", render: (close) => <AddChildBody parentUid={parentUid} close={close} onCreated={onCreated} /> });
}

// ---------------------------------------------------------------------------
// Move to…
// ---------------------------------------------------------------------------

function MoveBody({ uid, close, onMoved }: { uid: string; close(): void; onMoved(uid: string, parentUid: string): void }) {
  const index = useModelIndex();
  const asset = index.assets.get(uid);
  const exclude = useMemo(() => new Set([uid, ...index.descendantsOf(uid)]), [index, uid]);
  const [target, setTarget] = useState<string | undefined>(undefined);
  const sameParent = !!asset && target === asset.parentUid;
  const conflict = !!asset && !!target && !sameParent && siblingNameSet(index, target).has(asset.name.toLowerCase());

  function move() {
    if (!asset || !target || sameParent) return;
    try {
      useProjectStore.getState().apply(`Move “${asset.name}”`, (d) => moveAsset(d, index, uid, target));
      close();
      onMoved(uid, target);
    } catch (e) {
      notifyError(e);
    }
  }

  return (
    <>
      <DialogHeader title={`Move “${asset?.name ?? ""}”`} icon={iconMove} />
      <IxModalContent>
        <div className={styles.body}>
          <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
            Current location: {asset ? assetPathLabel(index, asset.uid) : "(missing)"}. The asset moves together with its{" "}
            {exclude.size - 1} descendant(s); its own subtree is not offered as a target.
          </IxTypography>
          <AssetPicker index={index} value={target} onChange={setTarget} exclude={exclude} label="New parent" idPrefix="move-target" />
          {target ? (
            <IxTypography format="body-sm" className={styles.wrap}>
              New parent: {assetPathLabel(index, target)}
            </IxTypography>
          ) : null}
          {sameParent ? <IxMessageBar persistent type="info">The asset is already under this parent.</IxMessageBar> : null}
          {conflict ? (
            <IxMessageBar persistent type="warning">
              An asset named “{asset?.name}” already exists under the new parent. Sibling names must be unique; rename one of them before
              deploying.
            </IxMessageBar>
          ) : null}
        </div>
      </IxModalContent>
      <IxModalFooter>
        <IxButton variant="secondary" onClick={close}>
          Cancel
        </IxButton>
        <IxButton variant="primary" disabled={!target || sameParent} onClick={move}>
          Move here
        </IxButton>
      </IxModalFooter>
    </>
  );
}

export function openMoveDialog(uid: string, onMoved: (uid: string, parentUid: string) => void): void {
  openModal({ title: "Move asset", size: "720", render: (close) => <MoveBody uid={uid} close={close} onMoved={onMoved} /> });
}

// ---------------------------------------------------------------------------
// Bulk create
// ---------------------------------------------------------------------------

const PREVIEW_NAMES = 6;
const PREVIEW_ROWS = 200;

function TemplateTab({ parentUid, close, onCreated }: { parentUid: string; close(): void; onCreated(parentUid: string, count: number): void }) {
  const index = useModelIndex();
  const options = useMemo(() => instantiableTypeOptions(index), [index]);
  const [template, setTemplate] = useState("Asset {n:3}");
  const [count, setCount] = useState(10);
  const [start, setStart] = useState(1);
  const [typeKey, setTypeKey] = useState(() => defaultTypeKey(options));
  const option = options.find((o) => o.key === typeKey);
  const plan = useMemo(
    () => planTemplate(index, { template, count, start, type: option?.ref, parentUid }),
    [index, template, count, start, option, parentUid],
  );
  const parentName = parentUid === ROOT_ASSET_UID ? "Tenant root" : (index.assets.get(parentUid)?.name ?? "");

  function create() {
    if (plan.errors.length || plan.rows.length === 0) return;
    try {
      useProjectStore.getState().apply(`Bulk create ${plan.rows.length} assets under “${parentName}”`, (d) => {
        bulkCreateAssets(d, plan.rows);
      });
      if (option) lastTypeKey = option.key;
      close();
      onCreated(parentUid, plan.rows.length);
    } catch (e) {
      notifyError(e);
    }
  }

  return (
    <>
      <div className={styles.body}>
        <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
          Parent: {assetPathLabel(index, parentUid)}
        </IxTypography>
        <div className={styles.grid}>
          <IxInput
            label="Name template"
            value={template}
            helperText="{n} is the running number, {n:3} pads it to 3 digits (001). Without a placeholder _{n} is appended."
            onValueChange={(e) => setTemplate(e.detail)}
          />
          <TypeSelect options={options} value={typeKey} onChange={setTypeKey} invalidText={option ? undefined : "Choose an asset type."} />
          <IxNumberInput
            label="Count"
            min={1}
            max={BULK_MAX}
            value={count}
            helperText={`1 – ${BULK_MAX.toLocaleString()} per run`}
            onValueChange={(e) => setCount(typeof e.detail === "number" && Number.isFinite(e.detail) ? e.detail : 0)}
          />
          <IxNumberInput
            label="Start number"
            min={0}
            value={start}
            onValueChange={(e) => setStart(typeof e.detail === "number" && Number.isFinite(e.detail) ? e.detail : -1)}
          />
        </div>
        {plan.names.length ? (
          <div className={styles.preview}>
            <IxTypography format="label-sm" textColor="soft">
              Preview
            </IxTypography>
            <IxTypography format="body-sm" className={styles.wrap}>
              {plan.names.slice(0, PREVIEW_NAMES).join(", ")}
              {plan.names.length > PREVIEW_NAMES ? `, … ${plan.names[plan.names.length - 1]} (${plan.names.length.toLocaleString()} assets)` : ""}
            </IxTypography>
          </div>
        ) : null}
        {plan.errors.map((err) => (
          <IxMessageBar key={err} persistent type="alarm">
            {err}
          </IxMessageBar>
        ))}
      </div>
      <div className={styles.footerRow}>
        <IxButton variant="secondary" onClick={close}>
          Cancel
        </IxButton>
        <IxButton variant="primary" disabled={plan.errors.length > 0 || plan.rows.length === 0} onClick={create}>
          Create {plan.rows.length ? plan.rows.length.toLocaleString() : ""} assets
        </IxButton>
      </div>
    </>
  );
}

function CsvTab({ close, onCreated }: { close(): void; onCreated(parentUid: string, count: number): void }) {
  const index = useModelIndex();
  const options = useMemo(() => instantiableTypeOptions(index), [index]);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | undefined>();
  const [errorsOnly, setErrorsOnly] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const deferred = useDeferredValue(text);
  const plan = useMemo(() => (deferred.trim() ? planCsvImport(index, deferred, options) : undefined), [index, deferred, options]);
  const shown = (plan?.rows ?? []).filter((r) => !errorsOnly || r.errors.length > 0);
  const ready = !!plan && plan.fileErrors.length === 0 && plan.invalid === 0 && plan.valid > 0 && deferred === text;

  async function loadFile(file: File | undefined) {
    if (!file) return;
    try {
      setText(await file.text());
      setFileName(file.name);
    } catch (e) {
      notifyError(e, "Could not read the file");
    }
  }

  function create() {
    if (!plan || !ready) return;
    try {
      useProjectStore.getState().apply(`Import ${plan.rows.length} assets from CSV`, (d) => {
        createFromCsvPlan(d, plan);
      });
      close();
      const firstParent = plan.rows[0]?.parent;
      onCreated(firstParent?.kind === "existing" ? firstParent.uid : ROOT_ASSET_UID, plan.rows.length);
    } catch (e) {
      notifyError(e);
    }
  }

  return (
    <>
      <div className={styles.body}>
        <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
          Columns: {CSV_COLUMNS.join(", ")}. <strong>parentPath</strong> lists names separated by “ / ” starting below the tenant root (empty =
          top level); earlier rows can be parents of later rows. <strong>type</strong> is a project asset type id or a core type id (e.g.
          core.basicsite). Comma, semicolon and tab separated files are accepted.
        </IxTypography>
        <div className={styles.actions}>
          <IxButton variant="secondary" icon={iconDownload} onClick={() => downloadBlob(new Blob([csvTemplate()], { type: "text/csv" }), "assets-template.csv")}>
            Download template
          </IxButton>
          <IxButton variant="secondary" icon={iconUpload} onClick={() => fileRef.current?.click()}>
            Upload CSV file
          </IxButton>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className={styles.hiddenInput}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              void loadFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {fileName ? (
            <IxTypography format="body-sm" textColor="soft" className={styles.wrap}>
              Loaded {fileName}
            </IxTypography>
          ) : null}
        </div>
        <IxTextarea textareaWidth="100%"
          label="CSV content"
          value={text}
          textareaRows={6}
          resizeBehavior="vertical"
          placeholder={CSV_COLUMNS.join(",")}
          onValueChange={(e) => {
            setText(e.detail);
            setFileName(undefined);
          }}
        />
        {plan?.fileErrors.map((err) => (
          <IxMessageBar key={err} persistent type="alarm">
            {err}
          </IxMessageBar>
        ))}
        {plan?.unknownColumns.length ? (
          <IxMessageBar persistent type="info">
            Ignored column(s): {plan.unknownColumns.join(", ")}.
          </IxMessageBar>
        ) : null}
        {plan && plan.rows.length ? (
          <>
            <div className={styles.actions}>
              <IxTypography format="label" className={styles.wrap}>
                {plan.valid.toLocaleString()} row(s) ready · {plan.invalid.toLocaleString()} with errors
              </IxTypography>
              <IxButton variant="tertiary" onClick={() => setErrorsOnly((v) => !v)} aria-pressed={errorsOnly ? "true" : "false"}>
                {errorsOnly ? "Show all rows" : "Show rows with errors only"}
              </IxButton>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>CSV preview</caption>
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col">Parent path</th>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">External id</th>
                    <th scope="col">Timezone</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, PREVIEW_ROWS).map((r) => (
                    <tr key={r.key}>
                      <td>{r.line}</td>
                      <td className={styles.cellWrap}>{r.parentPath || "(top level)"}</td>
                      <th scope="row" className={styles.cellWrap}>
                        {r.name}
                      </th>
                      <td className={styles.cellWrap}>{r.typeLabel ?? r.typeToken}</td>
                      <td className={styles.cellWrap}>{r.externalId}</td>
                      <td className={styles.cellWrap}>{r.timezone || "Tenant default"}</td>
                      <td className={styles.cellWrap}>
                        {r.errors.length ? (
                          <span className={styles.error}>{r.errors.join(" ")}</span>
                        ) : (
                          <IxTypography format="body-sm" textColor="soft">
                            Ready
                          </IxTypography>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shown.length > PREVIEW_ROWS ? (
              <IxTypography format="body-sm" textColor="soft">
                Showing the first {PREVIEW_ROWS} of {shown.length.toLocaleString()} rows.
              </IxTypography>
            ) : null}
          </>
        ) : null}
      </div>
      <div className={styles.footerRow}>
        <IxButton variant="secondary" onClick={close}>
          Cancel
        </IxButton>
        <IxButton variant="primary" disabled={!ready} onClick={create}>
          Create {ready && plan ? plan.valid.toLocaleString() : ""} assets
        </IxButton>
      </div>
    </>
  );
}

function BulkBody({ parentUid, close, onCreated }: { parentUid: string; close(): void; onCreated(parentUid: string, count: number): void }) {
  const [tab, setTab] = useState<"template" | "csv">("template");
  return (
    <>
      <DialogHeader title="Bulk create assets" icon={iconDocumentBulk} />
      <IxModalContent>
        <div className={styles.body}>
          <IxTabs activeTabKey={tab} onTabChange={(e) => setTab(e.detail === "csv" ? "csv" : "template")}>
            <IxTabItem tabKey="template" id="bulk-tab-template" aria-controls="bulk-panel-template">
              Name template
            </IxTabItem>
            <IxTabItem tabKey="csv" id="bulk-tab-csv" aria-controls="bulk-panel-csv">
              CSV paste or upload
            </IxTabItem>
          </IxTabs>
          <div role="tabpanel" id="bulk-panel-template" aria-labelledby="bulk-tab-template" hidden={tab !== "template"}>
            {tab === "template" ? <TemplateTab parentUid={parentUid} close={close} onCreated={onCreated} /> : null}
          </div>
          <div role="tabpanel" id="bulk-panel-csv" aria-labelledby="bulk-tab-csv" hidden={tab !== "csv"}>
            {tab === "csv" ? <CsvTab close={close} onCreated={onCreated} /> : null}
          </div>
        </div>
      </IxModalContent>
    </>
  );
}

export function openBulkDialog(parentUid: string, onCreated: (parentUid: string, count: number) => void): void {
  openModal({
    title: "Bulk create assets",
    size: "full-width",
    render: (close) => (
      <BulkBody
        parentUid={parentUid}
        close={close}
        onCreated={(p, n) => {
          notifySuccess(`${n.toLocaleString()} assets created.`);
          onCreated(p, n);
        }}
      />
    ),
  });
}
