// Asset dialogs: create child, edit values, move, location, file assignment,
// delete, and the inputs of the batch "set variable value" operation.

import { useMemo, useState } from "react";
import {
  IxButton,
  IxInput,
  IxRadio,
  IxRadioGroup,
  IxSelect,
  IxSelectItem,
  IxTextarea,
  IxTypography,
} from "@siemens/ix-react";
import { iconSearch } from "@siemens/ix-icons/icons";
import type {
  AmAspectResource,
  AmAssetResource,
  AmAssetTypeResource,
  AmVariableDefinition,
} from "@/api/amTypes";
import { confirmDialog } from "@/components/dialogs";
import { notifySuccess } from "@/components/notify";
import { checkTimezone, timezoneMessage } from "@/domain/timezone";
import { checkValue } from "@/domain/values";
import {
  assetCreateRequest,
  assetDeleteSession,
  assetEditFrom,
  assetEditOk,
  assetEditSession,
  assetFileAssignSession,
  assetFileUnassignSession,
  assetLocationSession,
  assetMoveSession,
  hasOwnLocation,
  locationBody,
  locationFormFrom,
  moveBlockedReason,
  noErrors,
  staticAspects,
  validateAssetCreate,
  validateAssetEdit,
  validateLocation,
  type AssetCreateForm,
  type AssetEdit,
  type LocationForm,
} from "@/online/assets";
import { validateFileKey } from "@/online/assetTypes";
import type { VariableTarget } from "@/online/batch";
import { fetchWithEtag } from "@/online/etag";
import { upstreamError } from "@/online/errors";
import { buildFilter, textCondition } from "@/online/filters";
import { useLoader } from "@/online/hooks";
import { assetDeleteImpact } from "@/online/impact";
import { amPath, defaultTransport } from "@/online/transport";
import { fetchExplodedType } from "./AssetTypeDialogs";
import { itemsOf, type Catalog } from "./catalog";
import {
  confirmWithImpact,
  DialogFrame,
  ErrorBanner,
  Loading,
  notifyFailure,
  openDialog,
  runEdit,
  useBusy,
  type DialogControl,
} from "./ui";
import styles from "./explorer.module.css";

export const fetchAsset = (connectionId: string, id: string) =>
  fetchWithEtag<AmAssetResource>(defaultTransport, connectionId, amPath.asset(id));

const start = (a: AmAssetResource) => ({ resource: a, etag: a.etag });

function defLabel(v: AmVariableDefinition): string {
  return [v.name, `(${v.dataType}${v.unit ? `, ${v.unit}` : ""})`].join(" ");
}

// ---------------------------------------------------------------------------
// Create child
// ---------------------------------------------------------------------------

function CreateBody({ catalog, parent, ctl }: { catalog: Catalog; parent: AmAssetResource; ctl: DialogControl<AmAssetResource> }) {
  const types = itemsOf(catalog.assetTypes).filter((t) => t.instantiable);
  const [form, setForm] = useState<AssetCreateForm>({
    name: "",
    typeId: types.find((t) => t.id === "core.basicasset")?.id ?? types[0]?.id ?? "",
    externalId: "",
    description: "",
    timezone: "",
    twinType: "performance",
  });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { busy, run } = useBusy(ctl);
  const ids = useMemo(() => new Set(types.map((t) => t.id)), [types]);
  const errors = validateAssetCreate(form, ids);
  const show = (m: string | undefined) => (touched ? m : undefined);
  const set = (patch: Partial<AssetCreateForm>) => setForm((f) => ({ ...f, ...patch }));
  const tz = form.timezone.trim() ? checkTimezone(form.timezone) : null;

  async function submit() {
    setTouched(true);
    if (!noErrors(errors)) return;
    setError(null);
    await run(async () => {
      try {
        const res = await defaultTransport.am<AmAssetResource>(catalog.connectionId, assetCreateRequest(parent.assetId, form));
        if (res.status >= 400) throw upstreamError(res.status, res.body);
        notifySuccess(`Asset ${res.body.name} created below ${parent.name}.`);
        ctl.close(res.body);
      } catch (e) {
        setError(e);
      }
    });
  }

  return (
    <DialogFrame
      title={`Create asset below ${parent.name}`}
      busy={busy}
      footer={
        <>
          <IxButton variant="secondary" disabled={busy} onClick={() => ctl.dismiss()}>
            Cancel
          </IxButton>
          <IxButton variant="primary" loading={busy} disabled={busy} onClick={() => void submit()}>
            Create asset
          </IxButton>
        </>
      }
    >
      <ErrorBanner error={error} prefix="Not created" />
      <div className={styles.formGrid}>
        <IxInput
          label="Name"
          required
          value={form.name}
          maxLength={128}
          invalidText={show(errors.name)}
          className={show(errors.name) ? "ix-invalid" : undefined}
          onValueChange={(e) => set({ name: e.detail })}
        />
        <IxSelect
          label="Asset type"
          value={form.typeId}
          helperText="Only instantiable types"
          invalidText={show(errors.typeId)}
          className={show(errors.typeId) ? "ix-invalid" : undefined}
          onValueChange={(e) => {
            if (typeof e.detail === "string") set({ typeId: e.detail });
          }}
        >
          {types.map((t) => (
            <IxSelectItem key={t.id} value={t.id} label={`${t.name} (${t.id})`} />
          ))}
        </IxSelect>
        <IxInput
          label="External id"
          value={form.externalId}
          maxLength={255}
          invalidText={show(errors.externalId)}
          onValueChange={(e) => set({ externalId: e.detail })}
        />
        <IxSelect
          label="Twin type"
          value={form.twinType}
          helperText="Create-only"
          onValueChange={(e) => {
            if (e.detail === "performance" || e.detail === "simulation") set({ twinType: e.detail });
          }}
        >
          <IxSelectItem value="performance" label="performance (real asset)" />
          <IxSelectItem value="simulation" label="simulation" />
        </IxSelect>
        <div className={styles.full}>
          <IxInput
            label="Time zone"
            value={form.timezone}
            placeholder="Europe/Berlin"
            helperText={
              tz?.ok
                ? `Offsets: ${tz.offsets.join(", ")} · cannot be changed after creation`
                : "Java time zone id; empty = tenant default. Cannot be changed after creation; 15/45-minute offsets are not supported."
            }
            invalidText={form.timezone.trim() && tz && !tz.ok ? timezoneMessage(tz, form.timezone.trim()) : undefined}
            className={form.timezone.trim() && tz && !tz.ok ? "ix-invalid" : undefined}
            onValueChange={(e) => set({ timezone: e.detail })}
          />
        </div>
        <div className={styles.full}>
          <IxTextarea textareaWidth="100%"
            label="Description"
            value={form.description}
            maxLength={255}
            textareaRows={2}
            resizeBehavior="vertical"
            invalidText={show(errors.description)}
            className={show(errors.description) ? "ix-invalid" : undefined}
            onValueChange={(e) => set({ description: e.detail })}
          />
        </div>
      </div>
    </DialogFrame>
  );
}

export function openAssetCreateDialog(catalog: Catalog, parent: AmAssetResource) {
  return openDialog<AmAssetResource>({
    title: `Create asset below ${parent.name}`,
    size: "720",
    content: (ctl) => <CreateBody catalog={catalog} parent={parent} ctl={ctl} />,
  });
}

// ---------------------------------------------------------------------------
// Edit values
// ---------------------------------------------------------------------------

interface Definitions {
  variables: AmVariableDefinition[];
  aspects: AmAspectResource[];
}

async function loadDefinitions(connectionId: string, assetId: string, signal: AbortSignal): Promise<Definitions> {
  const [vars, aspects] = await Promise.all([
    defaultTransport.listAll<AmVariableDefinition>(connectionId, { resource: "asset-variables", assetId }, signal),
    defaultTransport.listAll<AmAspectResource>(connectionId, { resource: "asset-aspects", assetId }, signal),
  ]);
  return { variables: vars.items, aspects: aspects.items };
}

function EditBody({ catalog, asset, ctl }: { catalog: Catalog; asset: AmAssetResource; ctl: DialogControl<true> }) {
  const defs = useLoader((signal) => loadDefinitions(catalog.connectionId, asset.assetId, signal), `defs:${asset.assetId}`);
  const [edit, setEdit] = useState<AssetEdit>(() => assetEditFrom(asset));
  const [error, setError] = useState<unknown>(null);
  const { busy, run } = useBusy(ctl);
  const check = validateAssetEdit(asset, edit, defs.data?.variables ?? [], defs.data?.aspects ?? []);
  const setVar = (name: string, value: string) => setEdit((e) => ({ ...e, variables: { ...e.variables, [name]: value } }));
  const setAspectVar = (aspect: string, name: string, value: string) =>
    setEdit((e) => ({ ...e, aspects: { ...e.aspects, [aspect]: { ...(e.aspects[aspect] ?? {}), [name]: value } } }));

  async function submit() {
    if (!assetEditOk(check)) return;
    setError(null);
    await run(async () => {
      try {
        const res = await runEdit(catalog.connectionId, assetEditSession(defaultTransport, catalog.connectionId, asset, edit), start(asset), `Asset ${asset.name}`);
        if (res.kind === "done") notifySuccess(res.steps.length ? `Asset ${edit.name.trim()} updated.` : "No changes to save.");
        ctl.close(true);
      } catch (e) {
        setError(e);
      }
    });
  }

  const statics = staticAspects(defs.data?.aspects ?? []);
  return (
    <DialogFrame
      title={`Edit asset ${asset.name}`}
      busy={busy}
      footer={
        <>
          <IxButton variant="secondary" disabled={busy} onClick={() => ctl.dismiss()}>
            Cancel
          </IxButton>
          <IxButton variant="primary" loading={busy} disabled={busy || !defs.data || !assetEditOk(check)} onClick={() => void submit()}>
            Save changes
          </IxButton>
        </>
      }
    >
      <ErrorBanner error={error} prefix="Not saved" />
      <IxTypography format="body-sm" textColor="soft">
        Sent as merge patch (PATCH /assets/{"{id}"}) on ETag {asset.etag}. Type, time zone and twin type cannot be changed; the
        structure is defined by the asset type. Empty fields keep the type's default.
      </IxTypography>
      <div className={styles.formGrid}>
        <IxInput
          label="Name"
          required
          value={edit.name}
          maxLength={128}
          invalidText={check.fields.name}
          className={check.fields.name ? "ix-invalid" : undefined}
          onValueChange={(e) => setEdit((x) => ({ ...x, name: e.detail }))}
        />
        <IxInput
          label="External id"
          value={edit.externalId}
          maxLength={255}
          invalidText={check.fields.externalId}
          onValueChange={(e) => setEdit((x) => ({ ...x, externalId: e.detail }))}
        />
        <div className={styles.full}>
          <IxTextarea textareaWidth="100%"
            label="Description"
            value={edit.description}
            maxLength={255}
            textareaRows={2}
            resizeBehavior="vertical"
            invalidText={check.fields.description}
            className={check.fields.description ? "ix-invalid" : undefined}
            onValueChange={(e) => setEdit((x) => ({ ...x, description: e.detail }))}
          />
        </div>
      </div>
      {defs.loading && !defs.data ? <Loading label="Loading the variables of the asset…" /> : null}
      <ErrorBanner error={defs.error} prefix="Variables could not be loaded" />
      {defs.data ? (
        <>
          <h3 className={`typography-h6 ${styles.heading}`}>Variables</h3>
          {defs.data.variables.length ? (
            <div className={styles.formGrid}>
              {defs.data.variables.map((v) => {
                const k = `variable:${v.name}`;
                return (
                  <IxInput
                    key={k}
                    label={defLabel(v)}
                    value={edit.variables[v.name] ?? ""}
                    placeholder={v.defaultValue ?? ""}
                    helperText={v._links?.origin ? "Inherited from a parent type" : undefined}
                    invalidText={check.values[k]}
                    className={check.values[k] ? "ix-invalid" : undefined}
                    onValueChange={(e) => setVar(v.name, e.detail)}
                  />
                );
              })}
            </div>
          ) : (
            <IxTypography format="body-sm" textColor="soft">
              The asset type defines no variables.
            </IxTypography>
          )}
          {statics.map((a) => (
            <section key={a.name} className={styles.stack} aria-label={`Aspect ${a.name}`}>
              <h3 className={`typography-h6 ${styles.heading}`}>
                Aspect {a.name} <span className={styles.muted}>({a.aspectTypeId}, static)</span>
              </h3>
              <div className={styles.formGrid}>
                {a.variables.map((v) => {
                  const k = `aspect:${a.name}.${v.name}`;
                  return (
                    <IxInput
                      key={k}
                      label={defLabel(v)}
                      value={edit.aspects[a.name]?.[v.name] ?? ""}
                      placeholder={v.defaultValue ?? ""}
                      invalidText={check.values[k]}
                      className={check.values[k] ? "ix-invalid" : undefined}
                      onValueChange={(e) => setAspectVar(a.name, v.name, e.detail)}
                    />
                  );
                })}
              </div>
            </section>
          ))}
          {(defs.data.aspects.length ?? 0) > statics.length ? (
            <IxTypography format="body-xs" textColor="soft">
              Dynamic aspects ({defs.data.aspects.filter((a) => a.category !== "static").map((a) => a.name).join(", ")}) hold time
              series and have no values here.
            </IxTypography>
          ) : null}
        </>
      ) : null}
    </DialogFrame>
  );
}

export function openAssetEditDialog(catalog: Catalog, asset: AmAssetResource) {
  return openDialog<true>({ title: `Edit asset ${asset.name}`, size: "840", content: (ctl) => <EditBody catalog={catalog} asset={asset} ctl={ctl} /> });
}

// ---------------------------------------------------------------------------
// Move (target picker)
// ---------------------------------------------------------------------------

function MoveBody({
  catalog,
  assets,
  root,
  ctl,
}: {
  catalog: Catalog;
  assets: AmAssetResource[];
  root: AmAssetResource | null;
  ctl: DialogControl<AmAssetResource>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AmAssetResource[]>(root ? [root] : []);
  const [targetId, setTargetId] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { busy, run } = useBusy(ctl);
  const moving = new Set(assets.map((a) => a.assetId));

  async function search() {
    setSearching(true);
    setError(null);
    try {
      const res = await defaultTransport.listAll<AmAssetResource>(catalog.connectionId, {
        resource: "assets",
        filter: buildFilter({ name: textCondition("contains", query) }),
        basicFieldsOnly: true,
        maxItems: 50,
      });
      setResults(res.items.filter((a) => !moving.has(a.assetId)));
      setTargetId("");
    } catch (e) {
      setError(e);
    } finally {
      setSearching(false);
    }
  }

  async function choose() {
    if (!targetId) return;
    await run(async () => {
      try {
        // Re-read the target for its current hierarchyPath (cycle check).
        const target = (await fetchAsset(catalog.connectionId, targetId)).resource;
        if (assets.length === 1) {
          const reason = moveBlockedReason(assets[0]!, target);
          if (reason) throw new Error(reason);
        }
        ctl.close(target);
      } catch (e) {
        setError(e);
      }
    });
  }

  return (
    <DialogFrame
      title={assets.length === 1 ? `Move ${assets[0]!.name}` : `Move ${assets.length} assets`}
      busy={busy}
      footer={
        <>
          <IxButton variant="secondary" disabled={busy} onClick={() => ctl.dismiss()}>
            Cancel
          </IxButton>
          <IxButton variant="primary" loading={busy} disabled={busy || !targetId} onClick={() => void choose()}>
            {assets.length === 1 ? "Move here" : "Preview move"}
          </IxButton>
        </>
      }
    >
      <ErrorBanner error={error} />
      <IxTypography format="body-sm" textColor="soft">
        The asset moves together with all its children (POST /assets/{"{id}"}/move with If-Match). Search the new parent by name.
      </IxTypography>
      <form
        className={styles.rowEnd}
        role="search"
        aria-label="Find the new parent"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <IxInput className={styles.searchInput} label="Name contains" value={query} onValueChange={(e) => setQuery(e.detail)} />
        <IxButton variant="secondary" icon={iconSearch} loading={searching} type="submit">
          Search
        </IxButton>
      </form>
      {results.length ? (
        <IxRadioGroup label="New parent" value={targetId} onValueChange={(e) => setTargetId(e.detail)}>
          {results.map((a) => (
            <IxRadio
              key={a.assetId}
              value={a.assetId}
              name="move-target"
              label={`${a.name} · ${a.typeId}${a.parentId ? "" : " (root)"}${a.hierarchyPath?.length ? ` · ${a.hierarchyPath.map((p) => p.name).join(" › ")}` : ""}`}
            />
          ))}
        </IxRadioGroup>
      ) : (
        <IxTypography format="body-sm" textColor="soft">
          {searching ? "Searching…" : "No candidates. Search by name."}
        </IxTypography>
      )}
    </DialogFrame>
  );
}

/** Pick a new parent; resolves with the (freshly read) target asset. */
export function openMoveTargetDialog(catalog: Catalog, assets: AmAssetResource[], root: AmAssetResource | null) {
  return openDialog<AmAssetResource>({
    title: "Move assets",
    size: "720",
    content: (ctl) => <MoveBody catalog={catalog} assets={assets} root={root} ctl={ctl} />,
  });
}

export async function moveAsset(catalog: Catalog, asset: AmAssetResource, target: AmAssetResource): Promise<boolean> {
  try {
    const res = await runEdit(catalog.connectionId, assetMoveSession(defaultTransport, catalog.connectionId, asset, target.assetId), start(asset), `Asset ${asset.name}`);
    if (res.kind === "done") notifySuccess(`${asset.name} moved below ${target.name}.`);
    return res.kind === "done";
  } catch (e) {
    notifyFailure(e, `${asset.name} was not moved`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

const LOCATION_FIELDS: { key: keyof LocationForm; label: string }[] = [
  { key: "country", label: "Country" },
  { key: "region", label: "Region" },
  { key: "locality", label: "Locality" },
  { key: "streetAddress", label: "Street address" },
  { key: "postalCode", label: "Postal code" },
  { key: "latitude", label: "Latitude (−90…90)" },
  { key: "longitude", label: "Longitude (−180…180)" },
];

function LocationBody({ catalog, asset, ctl }: { catalog: Catalog; asset: AmAssetResource; ctl: DialogControl<true> }) {
  const own = hasOwnLocation(asset);
  const [form, setForm] = useState<LocationForm>(() => locationFormFrom(asset.location));
  const [error, setError] = useState<unknown>(null);
  const { busy, run } = useBusy(ctl);
  const errors = validateLocation(form);

  async function save() {
    if (!noErrors(errors)) return;
    await run(async () => {
      try {
        const res = await runEdit(
          catalog.connectionId,
          assetLocationSession(defaultTransport, catalog.connectionId, asset, locationBody(form)),
          start(asset),
          `Asset ${asset.name}`,
        );
        if (res.kind === "done") notifySuccess(`Location of ${asset.name} saved.`);
        ctl.close(true);
      } catch (e) {
        setError(e);
      }
    });
  }

  return (
    <DialogFrame
      title={`Location of ${asset.name}`}
      busy={busy}
      footer={
        <>
          <IxButton variant="secondary" disabled={busy} onClick={() => ctl.dismiss()}>
            Cancel
          </IxButton>
          <IxButton variant="primary" loading={busy} disabled={busy || !noErrors(errors)} onClick={() => void save()}>
            Save location
          </IxButton>
        </>
      }
    >
      <ErrorBanner error={error} prefix="Not saved" />
      <IxTypography format="body-sm" textColor="soft">
        {asset.location && !own
          ? "The asset currently inherits the location of an ancestor. Saving creates an own location for this asset (PUT /assets/{id}/location)."
          : "PUT /assets/{id}/location creates or updates the asset's own location."}
      </IxTypography>
      <div className={styles.formGrid}>
        {LOCATION_FIELDS.map((f) => (
          <IxInput
            key={f.key}
            label={f.label}
            value={form[f.key]}
            maxLength={255}
            invalidText={errors[f.key]}
            className={errors[f.key] ? "ix-invalid" : undefined}
            onValueChange={(e) => setForm((x) => ({ ...x, [f.key]: e.detail }))}
          />
        ))}
      </div>
    </DialogFrame>
  );
}

export function openLocationDialog(catalog: Catalog, asset: AmAssetResource) {
  return openDialog<true>({ title: `Location of ${asset.name}`, size: "720", content: (ctl) => <LocationBody catalog={catalog} asset={asset} ctl={ctl} /> });
}

export async function removeLocation(catalog: Catalog, asset: AmAssetResource): Promise<boolean> {
  const ok = await confirmDialog({
    title: `Remove the location of ${asset.name}?`,
    message: "The asset's own location is deleted (DELETE /assets/{id}/location). Afterwards it shows the location inherited from an ancestor, if any.",
    confirmLabel: "Remove location",
    danger: true,
  });
  if (!ok) return false;
  try {
    const res = await runEdit(catalog.connectionId, assetLocationSession(defaultTransport, catalog.connectionId, asset, null), start(asset), `Asset ${asset.name}`);
    if (res.kind === "done") notifySuccess(`Location of ${asset.name} removed.`);
    return res.kind === "done";
  } catch (e) {
    notifyFailure(e, "Location not removed");
    return false;
  }
}

// ---------------------------------------------------------------------------
// File assignments
// ---------------------------------------------------------------------------

function AssignFileBody({
  catalog,
  asset,
  fixedFileId,
  ctl,
}: {
  catalog: Catalog;
  asset: AmAssetResource;
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
  const existing = (asset.fileAssignments ?? []).find((f) => f.key === key.trim());

  async function submit() {
    setTouched(true);
    if (keyError || !fileId) return;
    await run(async () => {
      try {
        const res = await runEdit(
          catalog.connectionId,
          assetFileAssignSession(defaultTransport, catalog.connectionId, asset, key, fileId),
          start(asset),
          `Asset ${asset.name}`,
        );
        if (res.kind === "done") notifySuccess(`File assigned to ${asset.name} as ${key.trim()}.`);
        ctl.close(true);
      } catch (e) {
        setError(e);
      }
    });
  }

  return (
    <DialogFrame
      title={`Assign file to ${asset.name}`}
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
            helperText={existing ? `Replaces the current assignment of key ${existing.key}` : "Letters, digits and _"}
            invalidText={touched ? keyError : undefined}
            className={touched && keyError ? "ix-invalid" : undefined}
            onValueChange={(e) => setKey(e.detail)}
          />
          <IxSelect
            label="File"
            value={fileId}
            disabled={!!fixedFileId}
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

export function openAssetFileDialog(catalog: Catalog, asset: AmAssetResource, fixedFileId?: string) {
  return openDialog<true>({
    title: `Assign file to ${asset.name}`,
    size: "600",
    content: (ctl) => <AssignFileBody catalog={catalog} asset={asset} fixedFileId={fixedFileId} ctl={ctl} />,
  });
}

export async function removeAssetFile(catalog: Catalog, asset: AmAssetResource, key: string): Promise<boolean> {
  try {
    const res = await runEdit(catalog.connectionId, assetFileUnassignSession(defaultTransport, catalog.connectionId, asset, key), start(asset), `Asset ${asset.name}`);
    if (res.kind === "done") notifySuccess(`File assignment ${key} removed from ${asset.name}.`);
    return res.kind === "done";
  } catch (e) {
    notifyFailure(e, "File assignment not removed");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteAsset(catalog: Catalog, asset: AmAssetResource): Promise<boolean> {
  try {
    const impact = await assetDeleteImpact(defaultTransport, catalog.connectionId, asset);
    const ok = await confirmWithImpact({
      title: `Delete asset ${asset.name}?`,
      message: `${asset.name} (${asset.assetId}) is deleted with its values and file assignments. This cannot be undone.`,
      confirmLabel: "Delete asset",
      impact,
    });
    if (!ok) return false;
    const res = await runEdit(catalog.connectionId, assetDeleteSession(defaultTransport, catalog.connectionId, asset), start(asset), `Asset ${asset.name}`);
    if (res.kind === "done") notifySuccess(`Asset ${asset.name} deleted.`);
    return res.kind === "done";
  } catch (e) {
    notifyFailure(e, `Asset ${asset.name} was not deleted`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Batch "set variable value" inputs
// ---------------------------------------------------------------------------

interface TargetOption {
  id: string;
  label: string;
  target: VariableTarget;
  def: AmVariableDefinition;
  /** Type ids (exploded) that have this variable. */
  typeIds: Set<string>;
}

async function loadTargetOptions(connectionId: string, typeIds: string[]): Promise<TargetOption[]> {
  const types: AmAssetTypeResource[] = await Promise.all(typeIds.map((id) => fetchExplodedType(connectionId, id).then((r) => r.resource)));
  const options = new Map<string, TargetOption>();
  const add = (id: string, label: string, target: VariableTarget, def: AmVariableDefinition, typeId: string) => {
    const o = options.get(id) ?? { id, label, target, def, typeIds: new Set<string>() };
    o.typeIds.add(typeId);
    options.set(id, o);
  };
  for (const t of types) {
    for (const v of t.variables) add(`variable:${v.name}`, `Variable ${defLabel(v)}`, { kind: "variable", name: v.name }, v, t.id);
    for (const a of t.aspects) {
      if (a.aspectType?.category !== "static") continue;
      for (const v of a.aspectType.variables) {
        add(`aspect:${a.name}.${v.name}`, `Aspect ${a.name} · ${defLabel(v)}`, { kind: "aspect", aspect: a.name, name: v.name }, v, t.id);
      }
    }
  }
  return [...options.values()].sort((x, y) => x.label.localeCompare(y.label));
}

export interface SetVariableChoice {
  target: VariableTarget;
  value: string;
  /** Reason an asset cannot get the value (its type lacks the variable). */
  applicable: (a: AmAssetResource) => string | undefined;
}

function SetVariableBody({ catalog, assets, ctl }: { catalog: Catalog; assets: AmAssetResource[]; ctl: DialogControl<SetVariableChoice> }) {
  const typeIds = useMemo(() => [...new Set(assets.map((a) => a.typeId))].sort(), [assets]);
  const options = useLoader(() => loadTargetOptions(catalog.connectionId, typeIds), `targets:${typeIds.join(",")}`);
  const [optionId, setOptionId] = useState("");
  const [value, setValue] = useState("");
  const option = options.data?.find((o) => o.id === optionId);
  const valueError = option && value !== "" ? checkValue(option.def.dataType, value, option.def.length) : undefined;
  const ready = !!option && value !== "" && !valueError;

  return (
    <DialogFrame
      title={`Set a value on ${assets.length} assets`}
      footer={
        <>
          <IxButton variant="secondary" onClick={() => ctl.dismiss()}>
            Cancel
          </IxButton>
          <IxButton
            variant="primary"
            disabled={!ready}
            onClick={() =>
              option &&
              ctl.close({
                target: option.target,
                value,
                applicable: (a) => (option.typeIds.has(a.typeId) ? undefined : `Type ${a.typeId} has no ${option.label}.`),
              })
            }
          >
            Preview requests
          </IxButton>
        </>
      }
    >
      {options.loading && !options.data ? <Loading label="Reading the asset types of the selection…" /> : null}
      <ErrorBanner error={options.error} prefix="Asset types could not be read" />
      {options.data ? (
        options.data.length ? (
          <div className={styles.formGrid}>
            <div className={styles.full}>
              <IxSelect
                label="Variable"
                value={optionId}
                helperText={`Variables and static aspect variables of ${typeIds.length} asset type${typeIds.length === 1 ? "" : "s"}`}
                onValueChange={(e) => {
                  if (typeof e.detail === "string") setOptionId(e.detail);
                }}
              >
                {options.data.map((o) => (
                  <IxSelectItem key={o.id} value={o.id} label={`${o.label}${o.typeIds.size < typeIds.length ? " — not on every type" : ""}`} />
                ))}
              </IxSelect>
            </div>
            <div className={styles.full}>
              <IxInput
                label="Value"
                value={value}
                maxLength={255}
                disabled={!option}
                helperText={option ? `Must match ${option.def.dataType}` : "Select a variable first"}
                invalidText={valueError}
                className={valueError ? "ix-invalid" : undefined}
                onValueChange={(e) => setValue(e.detail)}
              />
            </div>
          </div>
        ) : (
          <IxTypography>The asset types of the selected assets define no variables or static aspects.</IxTypography>
        )
      ) : null}
    </DialogFrame>
  );
}

export function openSetVariableDialog(catalog: Catalog, assets: AmAssetResource[]) {
  return openDialog<SetVariableChoice>({
    title: `Set a value on ${assets.length} assets`,
    size: "600",
    content: (ctl) => <SetVariableBody catalog={catalog} assets={assets} ctl={ctl} />,
  });
}
