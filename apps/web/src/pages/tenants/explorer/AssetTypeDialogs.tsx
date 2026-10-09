// Asset type create / edit / delete / file assignment dialogs.

import { useState } from "react";
import { IxButton, IxCheckbox, IxInput, IxSelect, IxSelectItem, IxTextarea, IxTypography } from "@siemens/ix-react";
import { iconAdd, iconTrashcan, iconUndo } from "@siemens/ix-icons/icons";
import { UpstreamError } from "@/api/client";
import type { AmAssetTypeResource } from "@/api/amTypes";
import { notifySuccess } from "@/components/notify";
import {
  aspectDraftsFrom,
  assetTypeCreateRequest,
  assetTypeDeleteSession,
  assetTypeEditSession,
  assetTypeFileAssignSession,
  assetTypeFileUnassignSession,
  newAspectDraft,
  validateAssetTypeCreate,
  validateAssetTypeEdit,
  validateFileKey,
  type AspectDraft,
  type AspectIssue,
  type AssetTypeCreateForm,
} from "@/online/assetTypes";
import { fetchWithEtag } from "@/online/etag";
import { upstreamError } from "@/online/errors";
import { useLoader } from "@/online/hooks";
import { assetTypeChangeImpact, assetTypeDeleteImpact, directVariables } from "@/online/impact";
import { amPath, defaultTransport } from "@/online/transport";
import { draftFromVariable, summarizeVariableChanges } from "@/online/variables";
import { itemsOf, type Catalog } from "./catalog";
import { VariableDraftEditor } from "./VariableDraftEditor";
import {
  confirmWithImpact,
  DialogFrame,
  ErrorBanner,
  notifyFailure,
  openDialog,
  runEdit,
  useBusy,
  type DialogControl,
} from "./ui";
import styles from "./explorer.module.css";

/** Exploded type (inherited variables and aspects carry `_links.origin`). */
export async function fetchExplodedType(connectionId: string, id: string) {
  return fetchWithEtag<AmAssetTypeResource>(defaultTransport, connectionId, amPath.assetType(id), { exploded: true });
}

function inheritedNames(exploded: AmAssetTypeResource | null | undefined) {
  if (!exploded) return { variables: [] as string[], aspects: [] as string[] };
  return {
    variables: exploded.variables.filter((v) => v._links?.origin).map((v) => v.name),
    aspects: exploded.aspects.filter((a) => a._links?.origin).map((a) => a.name),
  };
}

function AspectDraftEditor({
  drafts,
  onChange,
  issues,
  catalog,
}: {
  drafts: AspectDraft[];
  onChange: (next: AspectDraft[]) => void;
  issues: AspectIssue[];
  catalog: Catalog;
}) {
  const aspectTypes = itemsOf(catalog.aspectTypes);
  const update = (key: string, patch: Partial<AspectDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const err = (key: string, field: AspectIssue["field"]) =>
    issues.filter((i) => i.key === key && i.field === field).map((i) => i.message).join(" ") || undefined;
  return (
    <div className={styles.stack}>
      {drafts.length === 0 ? (
        <IxTypography format="body-sm" textColor="soft">
          No own aspects.
        </IxTypography>
      ) : null}
      {drafts.map((d, i) => {
        const label = d.name.trim() || `aspect ${i + 1}`;
        return (
          <div key={d.key} className={`${styles.editorRow} ${d.deleted ? styles.deletedRow : ""}`} role="group" aria-label={`Aspect ${label}`}>
            <IxInput
              label="Aspect name"
              required
              value={d.name}
              maxLength={64}
              disabled={d.deleted}
              helperText={d.aspectId ? "Renaming keeps the aspect (aspectId) and its data" : undefined}
              invalidText={err(d.key, "name")}
              className={err(d.key, "name") ? "ix-invalid" : undefined}
              onValueChange={(e) => update(d.key, { name: e.detail })}
            />
            <IxSelect
              label="Aspect type"
              value={d.aspectTypeId}
              disabled={d.deleted || !!d.aspectId}
              helperText={d.aspectId ? "The aspect type of an existing aspect cannot be changed" : undefined}
              invalidText={err(d.key, "aspectTypeId")}
              className={err(d.key, "aspectTypeId") ? "ix-invalid" : undefined}
              onValueChange={(e) => {
                if (typeof e.detail === "string") {
                  const at = aspectTypes.find((t) => t.id === e.detail);
                  update(d.key, { aspectTypeId: e.detail, name: d.name || at?.name || "" });
                }
              }}
            >
              {aspectTypes.map((t) => (
                <IxSelectItem key={t.id} value={t.id} label={`${t.name} (${t.id}, ${t.category})`} />
              ))}
              {d.aspectTypeId && !aspectTypes.some((t) => t.id === d.aspectTypeId) ? (
                <IxSelectItem value={d.aspectTypeId} label={d.aspectTypeId} />
              ) : null}
            </IxSelect>
            <div className={styles.editorRowWide}>
              <IxTypography format="body-xs" textColor="soft">
                {d.aspectId ? `aspectId ${d.aspectId}` : "New aspect"}
              </IxTypography>
              <IxButton
                variant="subtle-tertiary"
                icon={d.deleted ? iconUndo : iconTrashcan}
                onClick={() =>
                  d.aspectId || d.originalName
                    ? update(d.key, { deleted: !d.deleted })
                    : onChange(drafts.filter((x) => x.key !== d.key))
                }
              >
                {d.deleted ? `Keep ${label}` : `Remove ${label}`}
              </IxButton>
            </div>
          </div>
        );
      })}
      <div>
        <IxButton variant="secondary" icon={iconAdd} onClick={() => onChange([...drafts, newAspectDraft()])}>
          Add aspect
        </IxButton>
      </div>
    </div>
  );
}

function CreateBody({
  catalog,
  initialParent,
  ctl,
}: {
  catalog: Catalog;
  initialParent?: string;
  ctl: DialogControl<AmAssetTypeResource>;
}) {
  const [form, setForm] = useState<AssetTypeCreateForm>({
    idSuffix: "",
    name: "",
    description: "",
    parentTypeId: initialParent ?? "core.basicasset",
    instantiable: true,
    variables: [],
    aspects: [],
  });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { busy, run } = useBusy(ctl);
  const parent = useLoader(
    () => fetchExplodedType(catalog.connectionId, form.parentTypeId).then((r) => r.resource),
    `parent:${form.parentTypeId}`,
    !!form.parentTypeId,
  );
  // Everything the parent has (own + inherited) is inherited by the new type.
  const inheritedVariables = parent.data?.variables.map((v) => v.name) ?? [];
  const inheritedAspects = parent.data?.aspects.map((a) => a.name) ?? [];
  const types = itemsOf(catalog.assetTypes);
  const check = validateAssetTypeCreate(catalog.tenant, form, types, inheritedVariables, inheritedAspects);
  const show = (m: string | undefined) => (touched ? m : undefined);
  const set = (patch: Partial<AssetTypeCreateForm>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    setTouched(true);
    if (!check.ok) return;
    setError(null);
    await run(async () => {
      try {
        const { request } = assetTypeCreateRequest(catalog.tenant, form);
        const res = await defaultTransport.am<AmAssetTypeResource>(catalog.connectionId, request);
        if (res.status === 412) {
          throw new UpstreamError(412, { errors: [{ message: "An asset type with this id already exists (If-None-Match: * prevents overwriting)." }] });
        }
        if (res.status >= 400) throw upstreamError(res.status, res.body);
        notifySuccess(`Asset type ${res.body.name} created.`);
        ctl.close(res.body);
      } catch (e) {
        setError(e);
      }
    });
  }

  return (
    <DialogFrame
      title="Create asset type"
      busy={busy}
      footer={
        <>
          <IxButton variant="secondary" disabled={busy} onClick={() => ctl.dismiss()}>
            Cancel
          </IxButton>
          <IxButton variant="primary" loading={busy} disabled={busy} onClick={() => void submit()}>
            Create asset type
          </IxButton>
        </>
      }
    >
      <ErrorBanner error={error} prefix="Not created" />
      <div className={styles.formGrid}>
        <IxInput
          label="Id"
          required
          value={form.idSuffix}
          helperText={`Full id: ${catalog.tenant}.${form.idSuffix || "<id>"} (cannot be changed later)`}
          invalidText={show(check.fields.idSuffix)}
          className={show(check.fields.idSuffix) ? "ix-invalid" : undefined}
          onValueChange={(e) => set({ idSuffix: e.detail })}
        />
        <IxInput
          label="Name"
          required
          value={form.name}
          maxLength={128}
          invalidText={show(check.fields.name)}
          className={show(check.fields.name) ? "ix-invalid" : undefined}
          onValueChange={(e) => set({ name: e.detail })}
        />
        <IxSelect
          label="Parent type"
          value={form.parentTypeId}
          helperText="Variables and aspects of the parent are inherited (core types included)"
          invalidText={show(check.fields.parentTypeId)}
          className={show(check.fields.parentTypeId) ? "ix-invalid" : undefined}
          onValueChange={(e) => {
            if (typeof e.detail === "string") set({ parentTypeId: e.detail });
          }}
        >
          {types.map((t) => (
            <IxSelectItem key={t.id} value={t.id} label={`${t.name} (${t.id})`} />
          ))}
          {!types.some((t) => t.id === form.parentTypeId) ? <IxSelectItem value={form.parentTypeId} label={form.parentTypeId} /> : null}
        </IxSelect>
        <IxCheckbox
          label="Instantiable (assets can be created from this type; cannot be switched off later)"
          checked={form.instantiable}
          onCheckedChange={(e) => set({ instantiable: e.detail })}
        />
        <div className={styles.full}>
          <IxTextarea textareaWidth="100%"
            label="Description"
            value={form.description}
            maxLength={255}
            textareaRows={2}
            resizeBehavior="vertical"
            invalidText={show(check.fields.description)}
            className={show(check.fields.description) ? "ix-invalid" : undefined}
            onValueChange={(e) => set({ description: e.detail })}
          />
        </div>
      </div>
      {parent.data ? (
        <IxTypography format="body-sm" textColor="soft">
          Inherited from {parent.data.name}: {parent.data.variables.length} variable{parent.data.variables.length === 1 ? "" : "s"},{" "}
          {parent.data.aspects.length} aspect{parent.data.aspects.length === 1 ? "" : "s"}.
        </IxTypography>
      ) : null}
      <ErrorBanner error={parent.error} prefix="Parent type could not be read" />
      <h3 className={`typography-h6 ${styles.heading}`}>Direct variables</h3>
      <VariableDraftEditor
        drafts={form.variables}
        owner={{ kind: "assetType" }}
        issues={touched ? check.variables : []}
        onChange={(variables) => set({ variables })}
      />
      <h3 className={`typography-h6 ${styles.heading}`}>Aspects</h3>
      <AspectDraftEditor drafts={form.aspects} onChange={(aspects) => set({ aspects })} issues={touched ? check.aspects : []} catalog={catalog} />
    </DialogFrame>
  );
}

export function openAssetTypeCreateDialog(catalog: Catalog, parentTypeId?: string) {
  return openDialog<AmAssetTypeResource>({
    title: "Create asset type",
    size: "840",
    content: (ctl) => <CreateBody catalog={catalog} initialParent={parentTypeId} ctl={ctl} />,
  });
}

function EditBody({
  catalog,
  type,
  exploded,
  ctl,
}: {
  catalog: Catalog;
  type: AmAssetTypeResource;
  exploded: AmAssetTypeResource | null;
  ctl: DialogControl<true>;
}) {
  const [name, setName] = useState(type.name);
  const [description, setDescription] = useState(type.description ?? "");
  const [instantiable, setInstantiable] = useState(type.instantiable);
  const [variables, setVariables] = useState(() => directVariables(type).map(draftFromVariable));
  const [aspects, setAspects] = useState(() => aspectDraftsFrom(type));
  const [error, setError] = useState<unknown>(null);
  const { busy, run } = useBusy(ctl);
  const inherited = inheritedNames(exploded);
  const edit = { name, description, instantiable, variables, aspects };
  const check = validateAssetTypeEdit(type, edit, inherited.variables, inherited.aspects);

  async function submit() {
    if (!check.ok) return;
    setError(null);
    await run(async () => {
      try {
        const changes = summarizeVariableChanges(directVariables(type), variables, { kind: "assetType" });
        const removedAspects = aspects.filter((a) => a.deleted && a.aspectId).map((a) => a.originalName ?? a.name);
        if (changes.deleted.length || changes.recreated.length || removedAspects.length) {
          const impact = await assetTypeChangeImpact(defaultTransport, catalog.connectionId, type, itemsOf(catalog.assetTypes));
          const ok = await confirmWithImpact({
            title: "Remove data from assets?",
            message: [
              changes.deleted.length ? `Deleted variables: ${changes.deleted.join(", ")}.` : "",
              changes.recreated.length ? `Deleted and recreated: ${changes.recreated.join(", ")}.` : "",
              removedAspects.length ? `Removed aspects: ${removedAspects.join(", ")}.` : "",
              "Values overridden on asset instances (and aspect data) are removed for this type and every derived type.",
            ]
              .filter(Boolean)
              .join(" "),
            confirmLabel: "Apply and remove the data",
            impact,
          });
          if (!ok) return;
        }
        const res = await runEdit(
          catalog.connectionId,
          assetTypeEditSession(defaultTransport, catalog.connectionId, type, edit),
          { resource: type, etag: type.etag },
          `Asset type ${type.name}`,
        );
        if (res.kind === "done") notifySuccess(res.steps.length ? `Asset type updated (${res.steps.join(", ")}).` : "No changes to save.");
        ctl.close(true);
      } catch (e) {
        setError(e);
      }
    });
  }

  const inheritedVars = exploded ? exploded.variables.filter((v) => v._links?.origin) : [];
  const inheritedAspects = exploded ? exploded.aspects.filter((a) => a._links?.origin) : [];

  return (
    <DialogFrame
      title={`Edit asset type ${type.name}`}
      busy={busy}
      footer={
        <>
          <IxButton variant="secondary" disabled={busy} onClick={() => ctl.dismiss()}>
            Cancel
          </IxButton>
          <IxButton variant="primary" loading={busy} disabled={busy || !check.ok} onClick={() => void submit()}>
            Save changes
          </IxButton>
        </>
      }
    >
      <ErrorBanner error={error} prefix="Not saved" />
      <IxTypography format="body-sm" textColor="soft">
        Changes are sent as merge patch on ETag {type.etag}: name, description, instantiable (only off → on), the complete list of
        direct variables (additions and removals) and aspects (renames keep the aspectId). Name, unit, length and default value
        of existing variables are updated with PATCH …/variables. Data type and searchable cannot change — use “Delete and
        recreate”.
      </IxTypography>
      <div className={styles.formGrid}>
        <IxInput
          label="Name"
          required
          value={name}
          maxLength={128}
          invalidText={check.name}
          className={check.name ? "ix-invalid" : undefined}
          onValueChange={(e) => setName(e.detail)}
        />
        <IxCheckbox
          label="Instantiable"
          checked={instantiable}
          disabled={type.instantiable}
          onCheckedChange={(e) => setInstantiable(e.detail)}
        />
        <div className={styles.full}>
          <IxTextarea textareaWidth="100%"
            label="Description"
            value={description}
            maxLength={255}
            textareaRows={2}
            resizeBehavior="vertical"
            invalidText={check.description}
            className={check.description ? "ix-invalid" : undefined}
            onValueChange={(e) => setDescription(e.detail)}
          />
        </div>
      </div>
      <h3 className={`typography-h6 ${styles.heading}`}>Direct variables</h3>
      <VariableDraftEditor drafts={variables} owner={{ kind: "assetType" }} issues={check.variables} onChange={setVariables} />
      {inheritedVars.length ? (
        <IxTypography format="body-xs" textColor="soft">
          Inherited (read-only): {inheritedVars.map((v) => v.name).join(", ")}
        </IxTypography>
      ) : null}
      <h3 className={`typography-h6 ${styles.heading}`}>Aspects</h3>
      <AspectDraftEditor drafts={aspects} onChange={setAspects} issues={check.aspects} catalog={catalog} />
      {inheritedAspects.length ? (
        <IxTypography format="body-xs" textColor="soft">
          Inherited (read-only): {inheritedAspects.map((a) => a.name).join(", ")}
        </IxTypography>
      ) : null}
    </DialogFrame>
  );
}

export function openAssetTypeEditDialog(catalog: Catalog, type: AmAssetTypeResource, exploded: AmAssetTypeResource | null) {
  return openDialog<true>({
    title: `Edit asset type ${type.name}`,
    size: "840",
    content: (ctl) => <EditBody catalog={catalog} type={type} exploded={exploded} ctl={ctl} />,
  });
}

export async function deleteAssetType(catalog: Catalog, type: AmAssetTypeResource): Promise<boolean> {
  try {
    const impact = await assetTypeDeleteImpact(defaultTransport, catalog.connectionId, type, itemsOf(catalog.assetTypes));
    const ok = await confirmWithImpact({
      title: `Delete asset type ${type.name}?`,
      message: `${type.id} is deleted from tenant ${catalog.tenant}. This cannot be undone.`,
      confirmLabel: "Delete asset type",
      impact,
    });
    if (!ok) return false;
    const res = await runEdit(
      catalog.connectionId,
      assetTypeDeleteSession(defaultTransport, catalog.connectionId, type),
      { resource: type, etag: type.etag },
      `Asset type ${type.name}`,
    );
    if (res.kind === "done") notifySuccess(`Asset type ${type.name} deleted.`);
    return res.kind === "done";
  } catch (e) {
    notifyFailure(e, `Asset type ${type.name} was not deleted`);
    return false;
  }
}

function AssignFileBody({
  catalog,
  type,
  fixedFileId,
  ctl,
}: {
  catalog: Catalog;
  type: AmAssetTypeResource;
  fixedFileId?: string;
  ctl: DialogControl<true>;
}) {
  const files = itemsOf(catalog.files);
  const [key, setKey] = useState("");
  const [fileId, setFileId] = useState(fixedFileId ?? files[0]?.id ?? "");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { busy, run } = useBusy(ctl);
  const keyError = validateFileKey(key);
  const fileError = fileId ? undefined : "Select a file.";
  const existing = (type.fileAssignments ?? []).find((f) => f.key === key.trim() && !f._links?.origin);

  async function submit() {
    setTouched(true);
    if (keyError || fileError) return;
    await run(async () => {
      try {
        const res = await runEdit(
          catalog.connectionId,
          assetTypeFileAssignSession(defaultTransport, catalog.connectionId, type, key, fileId),
          { resource: type, etag: type.etag },
          `Asset type ${type.name}`,
        );
        if (res.kind === "done") notifySuccess(`File assigned to ${type.name} as ${key.trim()}.`);
        ctl.close(true);
      } catch (e) {
        setError(e);
      }
    });
  }

  return (
    <DialogFrame
      title={`Assign file to ${type.name}`}
      busy={busy}
      footer={
        <>
          <IxButton variant="secondary" disabled={busy} onClick={() => ctl.dismiss()}>
            Cancel
          </IxButton>
          <IxButton variant="primary" loading={busy} disabled={busy || !fileId} onClick={() => void submit()}>
            Assign file
          </IxButton>
        </>
      }
    >
      <ErrorBanner error={error} prefix="Not assigned" />
      {!files.length && !fixedFileId ? (
        <IxTypography>No files on this tenant yet. Upload one in the Files tab first.</IxTypography>
      ) : (
        <div className={styles.formGrid}>
          <IxInput
            label="Key"
            required
            value={key}
            helperText={existing ? `Replaces the current file of key ${existing.key}` : "Letters, digits and _; assets of this type inherit it"}
            invalidText={touched ? keyError : undefined}
            className={touched && keyError ? "ix-invalid" : undefined}
            onValueChange={(e) => setKey(e.detail)}
          />
          <IxSelect
            label="File"
            value={fileId}
            disabled={!!fixedFileId}
            invalidText={touched ? fileError : undefined}
            onValueChange={(e) => {
              if (typeof e.detail === "string") setFileId(e.detail);
            }}
          >
            {files.map((f) => (
              <IxSelectItem key={f.id} value={f.id} label={`${f.name} (${f.id})`} />
            ))}
            {fixedFileId && !files.some((f) => f.id === fixedFileId) ? <IxSelectItem value={fixedFileId} label={fixedFileId} /> : null}
          </IxSelect>
        </div>
      )}
    </DialogFrame>
  );
}

export function openAssetTypeFileDialog(catalog: Catalog, type: AmAssetTypeResource, fixedFileId?: string) {
  return openDialog<true>({
    title: `Assign file to ${type.name}`,
    size: "600",
    content: (ctl) => <AssignFileBody catalog={catalog} type={type} fixedFileId={fixedFileId} ctl={ctl} />,
  });
}

export async function removeAssetTypeFile(catalog: Catalog, type: AmAssetTypeResource, key: string): Promise<boolean> {
  try {
    const res = await runEdit(
      catalog.connectionId,
      assetTypeFileUnassignSession(defaultTransport, catalog.connectionId, type, key),
      { resource: type, etag: type.etag },
      `Asset type ${type.name}`,
    );
    if (res.kind === "done") notifySuccess(`File assignment ${key} removed from ${type.name}.`);
    return res.kind === "done";
  } catch (e) {
    notifyFailure(e, "File assignment not removed");
    return false;
  }
}

