// Create / edit a tenant connection. Secrets are write-only: they are sent
// once to the backend and never shown again ("stored — leave empty to keep").

import { useState } from "react";
import { IxButton, IxInput, IxMessageBar, IxSelect, IxSelectItem, IxTypography } from "@siemens/ix-react";
import { api, type AuthMode, type ConnectionSummary } from "@/api/client";
import { notifySuccess } from "@/components/notify";
import {
  AUTH_MODES,
  connectionFormFrom,
  emptyConnectionForm,
  EXAMPLES,
  hasStoredSecret,
  SIMULATOR_LABEL,
  toConnectionInput,
  validateConnectionForm,
  type ConnectionForm,
} from "@/online/connections";
import { DialogFrame, ErrorBanner, openDialog, useBusy, type DialogControl } from "./explorer/ui";
import styles from "./explorer/explorer.module.css";

const STORED = "Stored — leave empty to keep";

function FormBody({ existing, ctl }: { existing?: ConnectionSummary; ctl: DialogControl<ConnectionSummary> }) {
  const [form, setForm] = useState<ConnectionForm>(() => (existing ? connectionFormFrom(existing) : emptyConnectionForm()));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { busy, run } = useBusy(ctl);
  const errors = validateConnectionForm(form, existing);
  const ok = Object.keys(errors).length === 0;
  const show = (k: keyof ConnectionForm) => (touched ? errors[k] : undefined);
  const set = (patch: Partial<ConnectionForm>) => setForm((f) => ({ ...f, ...patch }));
  const stored = hasStoredSecret(existing, form.mode);
  const field = (k: keyof ConnectionForm, label: string, opts: { required?: boolean; helper?: string; placeholder?: string; type?: "password" | "text" | "url" } = {}) => (
    <IxInput
      label={label}
      required={opts.required}
      type={opts.type ?? "text"}
      value={form[k] as string}
      placeholder={opts.placeholder}
      helperText={opts.helper}
      invalidText={show(k)}
      className={show(k) ? "ix-invalid" : undefined}
      onValueChange={(e) => set({ [k]: e.detail } as Partial<ConnectionForm>)}
    />
  );

  async function submit() {
    setTouched(true);
    if (!ok) return;
    setError(null);
    await run(async () => {
      try {
        const input = toConnectionInput(form);
        const saved = existing ? await api.connections.update(existing.id, input) : await api.connections.create(input);
        notifySuccess(`Connection ${saved.name} ${existing ? "updated" : "created"}.`);
        ctl.close(saved);
      } catch (e) {
        setError(e);
      }
    });
  }

  const title = existing ? `Edit connection ${existing.name}` : "New tenant connection";
  return (
    <DialogFrame
      title={title}
      busy={busy}
      footer={
        <>
          <IxButton variant="secondary" disabled={busy} onClick={() => ctl.dismiss()}>
            Cancel
          </IxButton>
          <IxButton variant="primary" loading={busy} disabled={busy} onClick={() => void submit()}>
            {existing ? "Save connection" : "Create connection"}
          </IxButton>
        </>
      }
    >
      <ErrorBanner error={error} prefix="Not saved" />
      <div className={styles.formGrid}>
        {field("name", "Name", { required: true, placeholder: "ACME development" })}
        {field("environment", "Environment", { required: true, helper: "Free label used for grouping, e.g. dev, qa, prod" })}
        {field("tenant", "Tenant name", {
          required: true,
          helper: "≤ 8 characters; type ids are composed as <tenant>.<id>",
        })}
        <IxSelect
          label="Authentication"
          value={form.mode}
          onValueChange={(e) => {
            if (typeof e.detail === "string") set({ mode: e.detail as AuthMode });
          }}
        >
          {AUTH_MODES.map((m) => (
            <IxSelectItem key={m.mode} value={m.mode} label={m.label} />
          ))}
        </IxSelect>
        <div className={styles.full}>
          <IxTypography format="body-sm" textColor="soft">
            {AUTH_MODES.find((m) => m.mode === form.mode)?.description}
          </IxTypography>
        </div>
        {form.mode === "simulator" ? (
          <div className={styles.full}>
            <IxMessageBar type="info" persistent>
              {SIMULATOR_LABEL}. The backend simulates Asset Management v3 in-process (ETags, filters, core types) so you can try
              everything without credentials.
            </IxMessageBar>
          </div>
        ) : (
          <div className={styles.full}>
            {field("apiBaseUrl", "Asset Management API base URL", {
              required: true,
              type: "url",
              placeholder: EXAMPLES.apiBaseUrl,
              helper: `https only; e.g. ${EXAMPLES.apiBaseUrl}`,
            })}
          </div>
        )}
        {form.mode === "client_credentials" || form.mode === "app_credentials" ? (
          <>
            <div className={styles.full}>
              {field("tokenUrl", "Token URL", {
                required: true,
                type: "url",
                placeholder: form.mode === "client_credentials" ? EXAMPLES.clientCredentialsTokenUrl : EXAMPLES.appCredentialsTokenUrl,
                helper:
                  form.mode === "client_credentials"
                    ? `Service credentials: ${EXAMPLES.clientCredentialsTokenUrl}`
                    : `Token Management Service: ${EXAMPLES.appCredentialsTokenUrl}`,
              })}
            </div>
            {field("clientId", "Client ID", {
              required: true,
              helper: existing?.clientIdHint ? `Currently ${existing.clientIdHint} — re-enter the client ID to save` : undefined,
            })}
            {field("clientSecret", "Client secret", {
              required: !stored,
              type: "password",
              helper: stored ? STORED : "Sent once to the backend (encrypted at rest), never shown again",
            })}
          </>
        ) : null}
        {form.mode === "app_credentials" ? (
          <>
            {field("appName", "App name", { required: true })}
            {field("appVersion", "App version", { required: true })}
            {field("hostTenant", "Host tenant", { required: true })}
            {field("userTenant", "User tenant", { required: true })}
          </>
        ) : null}
        {form.mode === "bearer" ? (
          <div className={styles.full}>
            {field("token", "Access token", {
              required: !stored,
              type: "password",
              helper: stored ? STORED : "Short-lived; it is not refreshed. Sent once, never shown again",
            })}
          </div>
        ) : null}
      </div>
    </DialogFrame>
  );
}

export function openConnectionDialog(existing?: ConnectionSummary) {
  return openDialog<ConnectionSummary>({
    title: existing ? `Edit connection ${existing.name}` : "New tenant connection",
    size: "720",
    content: (ctl) => <FormBody existing={existing} ctl={ctl} />,
  });
}
