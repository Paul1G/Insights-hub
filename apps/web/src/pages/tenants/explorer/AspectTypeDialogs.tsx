// Aspect type create / edit / delete dialogs.

import { useMemo, useState } from "react";
import { IxButton, IxInput, IxMessageBar, IxSelect, IxSelectItem, IxTextarea, IxTypography } from "@siemens/ix-react";
import { UpstreamError } from "@/api/client";
import type { AmAspectTypeResource } from "@/api/amTypes";
import { notifySuccess } from "@/components/notify";
import {
  aspectTypeCreateRequest,
  aspectTypeDeleteSession,
  aspectTypeEditSession,
  validateAspectTypeCreate,
  validateAspectTypeEdit,
  type AspectTypeCreateForm,
} from "@/online/aspectTypes";
import { upstreamError } from "@/online/errors";
import { aspectTypeChangeImpact, aspectTypeDeleteImpact } from "@/online/impact";
import { defaultTransport } from "@/online/transport";
import { draftFromVariable, newVariableDraft, summarizeVariableChanges, type VariableOwner } from "@/online/variables";
import { itemsOf, type Catalog } from "./catalog";
import { VariableDraftEditor } from "./VariableDraftEditor";
import { confirmWithImpact, DialogFrame, ErrorBanner, notifyFailure, openDialog, runEdit, useBusy, type DialogControl } from "./ui";
import styles from "./explorer.module.css";

function CreateBody({ catalog, ctl }: { catalog: Catalog; ctl: DialogControl<AmAspectTypeResource> }) {
  const [form, setForm] = useState<AspectTypeCreateForm>(() => ({
    idSuffix: "",
    name: "",
    category: "static",
    description: "",
    variables: [newVariableDraft({ kind: "aspectType", category: "static" })],
  }));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { busy, run } = useBusy(ctl);
  const owner: VariableOwner = { kind: "aspectType", category: form.category };
  const check = useMemo(
    () => validateAspectTypeCreate(catalog.tenant, form, itemsOf(catalog.aspectTypes)),
    [catalog.tenant, catalog.aspectTypes, form],
  );
  const show = (msg: string | undefined) => (touched ? msg : undefined);
  const set = (patch: Partial<AspectTypeCreateForm>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    setTouched(true);
    if (!check.ok) return;
    setError(null);
    await run(async () => {
      try {
        const { request } = aspectTypeCreateRequest(catalog.tenant, form);
        const res = await defaultTransport.am<AmAspectTypeResource>(catalog.connectionId, request);
        if (res.status === 412) {
          throw new UpstreamError(412, {
            errors: [{ message: "An aspect type with this id already exists (If-None-Match: * prevents overwriting)." }],
          });
        }
        if (res.status >= 400) throw upstreamError(res.status, res.body);
        notifySuccess(`Aspect type ${res.body.name} created.`);
        ctl.close(res.body);
      } catch (e) {
        setError(e);
      }
    });
  }

  return (
    <DialogFrame
      title="Create aspect type"
      busy={busy}
      footer={
        <>
          <IxButton variant="secondary" disabled={busy} onClick={() => ctl.dismiss()}>
            Cancel
          </IxButton>
          <IxButton variant="primary" loading={busy} disabled={busy} onClick={() => void submit()}>
            Create aspect type
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
          helperText="Unique in the tenant; cannot be changed later"
          invalidText={show(check.fields.name)}
          className={show(check.fields.name) ? "ix-invalid" : undefined}
          onValueChange={(e) => set({ name: e.detail })}
        />
        <IxSelect
          label="Category"
          value={form.category}
          helperText="static: values on the asset · dynamic: time series (cannot be changed later)"
          onValueChange={(e) => {
            if (e.detail === "static" || e.detail === "dynamic") {
              const category = e.detail;
              setForm((f) => ({
                ...f,
                category,
                variables: f.variables.map((v) => ({
                  ...v,
                  defaultValue: category === "dynamic" ? "" : v.defaultValue,
                  dataType: category === "static" && v.dataType === "BIG_STRING" ? "STRING" : v.dataType,
                })),
              }));
            }
          }}
        >
          <IxSelectItem value="static" label="static" />
          <IxSelectItem value="dynamic" label="dynamic" />
        </IxSelect>
        <IxInput label="Scope" value="private" readonly helperText="Only private types can be created" />
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
      <h3 className={`typography-h6 ${styles.heading}`}>Variables</h3>
      {touched && check.fields.variables ? <IxMessageBar type="alarm" persistent>{check.fields.variables}</IxMessageBar> : null}
      <VariableDraftEditor
        drafts={form.variables}
        owner={owner}
        issues={touched ? check.variables : check.variables.filter((i) => i.severity === "warning")}
        onChange={(variables) => set({ variables })}
      />
    </DialogFrame>
  );
}

export function openAspectTypeCreateDialog(catalog: Catalog) {
  return openDialog<AmAspectTypeResource>({
    title: "Create aspect type",
    size: "840",
    content: (ctl) => <CreateBody catalog={catalog} ctl={ctl} />,
  });
}

function EditBody({ catalog, type, ctl }: { catalog: Catalog; type: AmAspectTypeResource; ctl: DialogControl<true> }) {
  const [description, setDescription] = useState(type.description ?? "");
  const [variables, setVariables] = useState(() => type.variables.map(draftFromVariable));
  const [error, setError] = useState<unknown>(null);
  const { busy, run } = useBusy(ctl);
  const owner: VariableOwner = { kind: "aspectType", category: type.category };
  const edit = { description, variables };
  const check = validateAspectTypeEdit(type, edit);

  async function submit() {
    if (!check.ok) return;
    setError(null);
    await run(async () => {
      try {
        const changes = summarizeVariableChanges(type.variables, variables, owner);
        if (changes.deleted.length || changes.recreated.length) {
          const impact = await aspectTypeChangeImpact(defaultTransport, catalog.connectionId, type.id, itemsOf(catalog.assetTypes));
          const ok = await confirmWithImpact({
            title: "Delete variable data?",
            message: [
              changes.deleted.length ? `Deleted: ${changes.deleted.join(", ")}.` : "",
              changes.recreated.length ? `Deleted and recreated: ${changes.recreated.join(", ")}.` : "",
              "Values and time series stored for these variables on every asset using this aspect type are lost.",
            ]
              .filter(Boolean)
              .join(" "),
            confirmLabel: "Apply and lose the data",
            impact,
          });
          if (!ok) return;
        }
        const session = aspectTypeEditSession(defaultTransport, catalog.connectionId, type, edit);
        const res = await runEdit(catalog.connectionId, session, { resource: type, etag: type.etag }, `Aspect type ${type.name}`);
        if (res.kind === "done") {
          notifySuccess(res.steps.length ? `Aspect type ${type.name} updated (${res.steps.join(", ")}).` : "No changes to save.");
          ctl.close(true);
        } else ctl.close(true);
      } catch (e) {
        setError(e);
      }
    });
  }

  return (
    <DialogFrame
      title={`Edit aspect type ${type.name}`}
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
        Name ({type.name}), id, category ({type.category}) and the data type / searchable / quality code of existing
        variables cannot be changed. Variables are renamed, updated, added and deleted with PATCH …/variables; the
        description with a merge patch. Every request carries the ETag {type.etag}.
      </IxTypography>
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
      <h3 className={`typography-h6 ${styles.heading}`}>Variables</h3>
      {check.variablesError ? <IxMessageBar type="alarm" persistent>{check.variablesError}</IxMessageBar> : null}
      <VariableDraftEditor drafts={variables} owner={owner} issues={check.variables} onChange={setVariables} />
    </DialogFrame>
  );
}

export function openAspectTypeEditDialog(catalog: Catalog, type: AmAspectTypeResource) {
  return openDialog<true>({
    title: `Edit aspect type ${type.name}`,
    size: "840",
    content: (ctl) => <EditBody catalog={catalog} type={type} ctl={ctl} />,
  });
}

/** Impact analysis → danger confirm → DELETE with If-Match (412 → conflict dialog). */
export async function deleteAspectType(catalog: Catalog, type: AmAspectTypeResource): Promise<boolean> {
  try {
    const impact = aspectTypeDeleteImpact(type, itemsOf(catalog.assetTypes));
    const ok = await confirmWithImpact({
      title: `Delete aspect type ${type.name}?`,
      message: `${type.id} is deleted from tenant ${catalog.tenant}. This cannot be undone.`,
      confirmLabel: "Delete aspect type",
      impact,
    });
    if (!ok) return false;
    const res = await runEdit(
      catalog.connectionId,
      aspectTypeDeleteSession(defaultTransport, catalog.connectionId, type),
      { resource: type, etag: type.etag },
      `Aspect type ${type.name}`,
    );
    if (res.kind === "done") notifySuccess(`Aspect type ${type.name} deleted.`);
    return res.kind === "done";
  } catch (e) {
    notifyFailure(e, `Aspect type ${type.name} was not deleted`);
    return false;
  }
}
