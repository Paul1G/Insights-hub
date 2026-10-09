// Files tab: metadata list, upload (≤ 5 MB, content type checked against the
// extension), replace (If-Match), download, delete (If-Match; blocked while
// assigned), assign to an asset or an asset type.

import { useCallback, useMemo, useState } from "react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import {
  IxButton,
  IxCard,
  IxCardContent,
  IxChip,
  IxEmptyState,
  IxIcon,
  IxInput,
  IxRadio,
  IxRadioGroup,
  IxSelect,
  IxSelectItem,
  IxTextarea,
  IxTypography,
  IxUpload,
} from "@siemens/ix-react";
import { iconAttach, iconDownload, iconRefresh, iconSearch, iconTrashcan, iconUpload } from "@siemens/ix-icons/icons";
import { api } from "@/api/client";
import type { AmAssetResource, AmFileMetadata } from "@/api/amTypes";
import { notifySuccess } from "@/components/notify";
import { LIMITS } from "@/domain/rules";
import { upstreamError } from "@/online/errors";
import {
  decodeDownload,
  fileDeleteSession,
  formatBytes,
  replaceFileWithEtag,
  saveBlob,
  uploadInput,
  validateUpload,
  type UploadForm,
} from "@/online/files";
import { buildFilter, matchesSearch, textCondition } from "@/online/filters";
import { useTenantList } from "@/online/hooks";
import { fileDeleteImpact } from "@/online/impact";
import { defaultTransport } from "@/online/transport";
import { fetchAsset, openAssetFileDialog } from "./AssetDialogs";
import { openAssetTypeFileDialog } from "./AssetTypeDialogs";
import { itemsOf, type Catalog } from "./catalog";
import { Grid } from "./Grid";
import {
  confirmWithImpact,
  DialogFrame,
  ErrorBanner,
  formatTime,
  KeyValueGrid,
  Loading,
  notifyFailure,
  openConflictDialog,
  openDialog,
  PartialFailureBanner,
  runEdit,
  useBusy,
  type DialogControl,
} from "./ui";
import styles from "./explorer.module.css";

function AssignedCell({ data }: ICellRendererParams<AmFileMetadata>) {
  if (!data) return null;
  return data.isAssigned ? (
    <IxChip variant="info" outline inactive>
      assigned
    </IxChip>
  ) : (
    <IxChip variant="neutral" outline inactive>
      unassigned
    </IxChip>
  );
}

const COLUMNS: ColDef<AmFileMetadata>[] = [
  { field: "name", headerName: "Name", flex: 2, minWidth: 160 },
  { field: "originalFileName", headerName: "Original file", flex: 2, minWidth: 140 },
  { field: "scope", headerName: "Scope", width: 110 },
  { headerName: "Assignment", width: 150, cellRenderer: AssignedCell, valueGetter: (p) => (p.data?.isAssigned ? "assigned" : "unassigned") },
  { headerName: "Last modified", width: 190, valueGetter: (p) => formatTime(p.data?.lastModified ?? p.data?.uploaded) },
];

// ---------------------------------------------------------------------------
// Upload / replace
// ---------------------------------------------------------------------------

function UploadBody({
  catalog,
  file,
  ctl,
}: {
  catalog: Catalog;
  /** Replace this file instead of uploading a new one. */
  file?: AmFileMetadata;
  ctl: DialogControl<AmFileMetadata>;
}) {
  const [form, setForm] = useState<UploadForm>({
    name: file?.name ?? "",
    description: file?.description ?? "",
    scope: file?.scope ?? "private",
    file: null,
  });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { busy, run } = useBusy(ctl);
  const errors = validateUpload(form);
  const ok = Object.values(errors).every((v) => !v);
  const show = (m: string | undefined) => (touched ? m : undefined);

  async function submit() {
    setTouched(true);
    if (!ok) return;
    setError(null);
    await run(async () => {
      try {
        const input = await uploadInput(form);
        if (!file) {
          const res = await api.files.upload(catalog.connectionId, input);
          if (res.status >= 400) throw upstreamError(res.status, res.body);
          notifySuccess(`File ${res.body.name} uploaded.`);
          ctl.close(res.body);
          return;
        }
        const res = await replaceFileWithEtag(api.files, defaultTransport, catalog.connectionId, file, input, async (server, changes) =>
          openConflictDialog(
            { failedStep: 0, completedSteps: [], server, serverEtag: server.etag, changes },
            `File ${file.name}`,
          ),
        );
        if (res.kind === "done") {
          notifySuccess(`File ${res.file.name} replaced.`);
          ctl.close(res.file);
        } else ctl.dismiss();
      } catch (e) {
        setError(e);
      }
    });
  }

  const title = file ? `Replace file ${file.name}` : "Upload file";
  return (
    <DialogFrame
      title={title}
      busy={busy}
      footer={
        <>
          <IxButton variant="secondary" disabled={busy} onClick={() => ctl.dismiss()}>
            Cancel
          </IxButton>
          <IxButton variant="primary" icon={iconUpload} loading={busy} disabled={busy} onClick={() => void submit()}>
            {file ? "Replace file" : "Upload file"}
          </IxButton>
        </>
      }
    >
      <ErrorBanner error={error} prefix={file ? "Not replaced" : "Not uploaded"} />
      <IxUpload
        selectFileText={`Drop a file here (max. ${formatBytes(LIMITS.fileSizeMaxBytes)})`}
        i18nUploadFile="Choose file"
        onFilesChanged={(e) => {
          const f = e.detail[0] ?? null;
          setForm((x) => ({ ...x, file: f, name: x.name || (f ? f.name.replace(/[*&%\s/\\]+/g, "_") : "") }));
          setTouched(true);
        }}
      />
      <IxTypography format="body-sm" role="status" textColor={show(errors.file) ? "alarm" : "soft"}>
        {form.file
          ? `${form.file.name} · ${formatBytes(form.file.size)}${errors.file ? ` — ${errors.file}` : ""}`
          : show(errors.file) ?? "No file chosen. The content type must match the file extension."}
      </IxTypography>
      <div className={styles.formGrid}>
        <IxInput
          label="Name"
          required
          value={form.name}
          maxLength={255}
          helperText={"No spaces or * & % / \\"}
          invalidText={show(errors.name)}
          className={show(errors.name) ? "ix-invalid" : undefined}
          onValueChange={(e) => setForm((x) => ({ ...x, name: e.detail }))}
        />
        <IxSelect
          label="Scope"
          value={form.scope}
          helperText="private hides the file from subtenants"
          onValueChange={(e) => {
            if (e.detail === "private" || e.detail === "public") setForm((x) => ({ ...x, scope: e.detail as "private" | "public" }));
          }}
        >
          <IxSelectItem value="private" label="private" />
          <IxSelectItem value="public" label="public" />
        </IxSelect>
        <div className={styles.full}>
          <IxTextarea textareaWidth="100%"
            label="Description"
            value={form.description}
            maxLength={255}
            textareaRows={2}
            resizeBehavior="vertical"
            invalidText={show(errors.description)}
            onValueChange={(e) => setForm((x) => ({ ...x, description: e.detail }))}
          />
        </div>
      </div>
    </DialogFrame>
  );
}

export function openUploadDialog(catalog: Catalog, file?: AmFileMetadata) {
  return openDialog<AmFileMetadata>({
    title: file ? `Replace file ${file.name}` : "Upload file",
    size: "600",
    content: (ctl) => <UploadBody catalog={catalog} file={file} ctl={ctl} />,
  });
}

// ---------------------------------------------------------------------------
// Assign to asset / asset type
// ---------------------------------------------------------------------------

type AssignTarget = { kind: "asset"; asset: AmAssetResource } | { kind: "assettype"; typeId: string };

function AssignTargetBody({ catalog, file, ctl }: { catalog: Catalog; file: AmFileMetadata; ctl: DialogControl<AssignTarget> }) {
  const types = itemsOf(catalog.assetTypes).filter((t) => !t.id.startsWith("core."));
  const [kind, setKind] = useState<"asset" | "assettype">("asset");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AmAssetResource[]>([]);
  const [assetId, setAssetId] = useState("");
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [error, setError] = useState<unknown>(null);
  const { busy, run } = useBusy(ctl);

  async function search() {
    await run(async () => {
      try {
        const res = await defaultTransport.listAll<AmAssetResource>(catalog.connectionId, {
          resource: "assets",
          filter: buildFilter({ name: textCondition("contains", query) }),
          basicFieldsOnly: true,
          maxItems: 50,
        });
        setResults(res.items);
        setAssetId("");
      } catch (e) {
        setError(e);
      }
    });
  }

  async function next() {
    if (kind === "assettype") {
      if (typeId) ctl.close({ kind: "assettype", typeId });
      return;
    }
    if (!assetId) return;
    await run(async () => {
      try {
        ctl.close({ kind: "asset", asset: (await fetchAsset(catalog.connectionId, assetId)).resource });
      } catch (e) {
        setError(e);
      }
    });
  }

  return (
    <DialogFrame
      title={`Assign ${file.name}`}
      busy={busy}
      footer={
        <>
          <IxButton variant="secondary" disabled={busy} onClick={() => ctl.dismiss()}>
            Cancel
          </IxButton>
          <IxButton variant="primary" disabled={busy || (kind === "asset" ? !assetId : !typeId)} onClick={() => void next()}>
            Continue
          </IxButton>
        </>
      }
    >
      <ErrorBanner error={error} />
      <IxRadioGroup label="Assign to" value={kind} direction="row" onValueChange={(e) => setKind(e.detail === "assettype" ? "assettype" : "asset")}>
        <IxRadio value="asset" name="assign-kind" label="An asset" />
        <IxRadio value="assettype" name="assign-kind" label="An asset type (inherited by its assets)" />
      </IxRadioGroup>
      {kind === "assettype" ? (
        <IxSelect
          label="Asset type"
          value={typeId}
          onValueChange={(e) => {
            if (typeof e.detail === "string") setTypeId(e.detail);
          }}
        >
          {types.map((t) => (
            <IxSelectItem key={t.id} value={t.id} label={`${t.name} (${t.id})`} />
          ))}
        </IxSelect>
      ) : (
        <>
          <form
            className={styles.rowEnd}
            role="search"
            aria-label="Find the asset"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <IxInput className={styles.searchInput} label="Asset name contains" value={query} onValueChange={(e) => setQuery(e.detail)} />
            <IxButton variant="secondary" icon={iconSearch} type="submit" loading={busy}>
              Search
            </IxButton>
          </form>
          {results.length ? (
            <IxRadioGroup label="Asset" value={assetId} onValueChange={(e) => setAssetId(e.detail)}>
              {results.map((a) => (
                <IxRadio
                  key={a.assetId}
                  value={a.assetId}
                  name="assign-asset"
                  label={`${a.name} · ${a.typeId}${a.hierarchyPath?.length ? ` · ${a.hierarchyPath.map((p) => p.name).join(" › ")}` : ""}`}
                />
              ))}
            </IxRadioGroup>
          ) : (
            <IxTypography format="body-sm" textColor="soft">
              Search an asset by name.
            </IxTypography>
          )}
        </>
      )}
    </DialogFrame>
  );
}

async function assignFile(catalog: Catalog, file: AmFileMetadata): Promise<boolean> {
  const target = await openDialog<AssignTarget>({
    title: `Assign ${file.name}`,
    size: "720",
    content: (ctl) => <AssignTargetBody catalog={catalog} file={file} ctl={ctl} />,
  });
  if (!target) return false;
  if (target.kind === "asset") return !!(await openAssetFileDialog(catalog, target.asset, file.id));
  const type = itemsOf(catalog.assetTypes).find((t) => t.id === target.typeId);
  if (!type) return false;
  return !!(await openAssetTypeFileDialog(catalog, type, file.id));
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export function FilesTab({ catalog }: { catalog: Catalog }) {
  const [search, setSearch] = useState("");
  const [serverInput, setServerInput] = useState("");
  const [serverFilter, setServerFilter] = useState<string | undefined>();
  const [activeId, setActiveId] = useState<string | null>(null);
  const filtered = useTenantList<AmFileMetadata>(catalog.connectionId, { resource: "files", filter: serverFilter }, !!serverFilter);
  const source = serverFilter ? filtered : catalog.files;
  const all = itemsOf(source);
  const rows = useMemo(() => all.filter((f) => matchesSearch(search, f.name, f.originalFileName, f.description, f.id)), [all, search]);
  const active = all.find((f) => f.id === activeId) ?? null;

  const refresh = useCallback(() => {
    catalog.files.reload();
    catalog.assetTypes.reload();
    if (serverFilter) filtered.reload();
  }, [catalog.files, catalog.assetTypes, filtered, serverFilter]);

  async function upload() {
    const f = await openUploadDialog(catalog);
    if (f) {
      refresh();
      setActiveId(f.id);
    }
  }

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <search aria-label="File search and filters" className={styles.toolbarSearch}>
          <IxInput className={styles.searchInput} label="Search loaded files" value={search} onValueChange={(e) => setSearch(e.detail)}>
            <IxIcon slot="start" name={iconSearch} size="16" aria-hidden="true" />
          </IxInput>
          <IxInput className={styles.searchInput} label="Server filter: name contains" value={serverInput} onValueChange={(e) => setServerInput(e.detail)} />
          <IxButton variant="secondary" onClick={() => setServerFilter(buildFilter({ name: textCondition("contains", serverInput) }))}>
            Apply filter
          </IxButton>
          {serverFilter ? (
            <IxButton
              variant="subtle-tertiary"
              onClick={() => {
                setServerFilter(undefined);
                setServerInput("");
              }}
            >
              Clear filter
            </IxButton>
          ) : null}
        </search>
        <div className={styles.toolbarActions}>
          <IxButton variant="secondary" icon={iconRefresh} loading={source.loading} onClick={refresh}>
            Refresh
          </IxButton>
          <IxButton variant="primary" icon={iconUpload} onClick={() => void upload()}>
            Upload file
          </IxButton>
        </div>
      </div>
      <ErrorBanner error={source.error} prefix="Files could not be loaded" />
      <PartialFailureBanner result={source.data} what="file" />
      <div role="status" className={styles.srOnly}>
        {source.loading ? "" : `${rows.length} of ${all.length} files shown.`}
      </div>
      <div className={styles.split}>
        <div className={styles.stack}>
          {source.loading && !source.data ? <Loading label="Loading files…" /> : null}
          {source.data && rows.length === 0 ? (
            <IxEmptyState
              icon={iconUpload}
              header={all.length ? "No matching files" : "No files"}
              subHeader={all.length ? "Change the search or clear the server filter." : "Upload a file to assign it to assets or asset types."}
              action={all.length ? "Clear search" : "Upload file"}
              onActionClick={() => (all.length ? setSearch("") : void upload())}
            />
          ) : null}
          {rows.length ? <Grid label="Files" rows={rows} columns={COLUMNS} rowId={(f) => f.id} onOpen={(f) => setActiveId(f.id)} /> : null}
        </div>
        <FileDetails
          catalog={catalog}
          file={active}
          onChanged={refresh}
          onDeleted={() => {
            setActiveId(null);
            refresh();
          }}
        />
      </div>
    </div>
  );
}

function FileDetails({
  catalog,
  file,
  onChanged,
  onDeleted,
}: {
  catalog: Catalog;
  file: AmFileMetadata | null;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  if (!file) {
    return (
      <IxCard variant="outline" className={styles.card} passive>
        <IxCardContent>
          <div className={styles.cardBody}>
            <h2 className={`typography-h4 ${styles.heading}`}>Details</h2>
            <IxTypography format="body-sm" textColor="soft">
              Select a file to download, replace, assign or delete it.
            </IxTypography>
          </div>
        </IxCardContent>
      </IxCard>
    );
  }

  async function download(f: AmFileMetadata) {
    setDownloading(true);
    try {
      const res = await api.files.download(catalog.connectionId, f.id);
      if (res.status >= 400) throw upstreamError(res.status, res.body);
      saveBlob(decodeDownload(res.body), f.originalFileName || f.name);
    } catch (e) {
      notifyFailure(e, "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  async function remove(f: AmFileMetadata) {
    try {
      const impact = await fileDeleteImpact(defaultTransport, catalog.connectionId, f, itemsOf(catalog.assetTypes));
      const ok = await confirmWithImpact({
        title: `Delete file ${f.name}?`,
        message: `${f.name} (${f.id}) is deleted from the tenant. This cannot be undone.`,
        confirmLabel: "Delete file",
        impact,
      });
      if (!ok) return;
      const res = await runEdit(catalog.connectionId, fileDeleteSession(defaultTransport, catalog.connectionId, f), { resource: f, etag: f.etag }, `File ${f.name}`);
      if (res.kind === "done") {
        notifySuccess(`File ${f.name} deleted.`);
        onDeleted();
      }
    } catch (e) {
      notifyFailure(e, `File ${f.name} was not deleted`);
    }
  }

  return (
    <IxCard variant="outline" className={styles.card} passive>
      <IxCardContent>
        <div className={styles.cardBody}>
          <div className={styles.headerRow}>
            <div className={styles.headerText}>
              <h2 className={`typography-h4 ${styles.heading}`}>{file.name}</h2>
              <IxTypography format="code-sm" textColor="soft">
                {file.id}
              </IxTypography>
            </div>
          </div>
          <div className={styles.row}>
            <IxButton variant="secondary" icon={iconDownload} loading={downloading} onClick={() => void download(file)}>
              Download
            </IxButton>
            <IxButton
              variant="secondary"
              icon={iconUpload}
              onClick={async () => {
                if (await openUploadDialog(catalog, file)) onChanged();
              }}
            >
              Replace content
            </IxButton>
            <IxButton
              variant="secondary"
              icon={iconAttach}
              onClick={async () => {
                if (await assignFile(catalog, file)) onChanged();
              }}
            >
              Assign file
            </IxButton>
            <IxButton variant="danger-secondary" icon={iconTrashcan} onClick={() => void remove(file)}>
              Delete file
            </IxButton>
          </div>
          <KeyValueGrid
            items={[
              { label: "Original file name", value: file.originalFileName ?? "" },
              { label: "Scope", value: file.scope ?? "private" },
              { label: "Assigned", value: file.isAssigned ? "yes" : "no" },
              { label: "ETag", value: String(file.etag) },
              { label: "Uploaded", value: formatTime(file.uploaded) },
              { label: "Last modified", value: formatTime(file.lastModified) },
              { label: "Description", value: file.description ?? "" },
            ]}
          />
        </div>
      </IxCardContent>
    </IxCard>
  );
}
