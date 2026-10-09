// Asset requests: create (POST /assets), value edits (PATCH /assets/{id},
// merge patch), move (POST /assets/{id}/move), location (PUT / DELETE
// /assets/{id}/location), file assignments (PUT / DELETE
// /assets/{id}/fileAssignments/{key}) and delete — all updates with If-Match.

import type { AmRequest } from "@/api/client";
import type {
  AmAspect,
  AmAspectResource,
  AmAsset,
  AmAssetResource,
  AmLocation,
  AmVariable,
  AmVariableDefinition,
} from "@/api/amTypes";
import { LIMITS, PATTERNS } from "@/domain/rules";
import { checkTimezone, timezoneMessage } from "@/domain/timezone";
import { checkValue } from "@/domain/values";
import { validateDescription, type FieldErrors } from "./aspectTypes";
import { fetchWithEtag, type EditSession } from "./etag";
import { amPath, type AmTransport } from "./transport";

export interface AssetCreateForm {
  name: string;
  typeId: string;
  externalId: string;
  description: string;
  timezone: string;
  twinType: "performance" | "simulation";
}

export function validateAssetName(name: string): string | undefined {
  const n = name.trim();
  if (!n) return "Name is required.";
  if (n.length > LIMITS.assetNameMax) return `At most ${LIMITS.assetNameMax} characters.`;
  if (!PATTERNS.assetName.test(n)) return "Slashes and backslashes are not allowed.";
  return undefined;
}

export function validateExternalId(text: string): string | undefined {
  return text.length > LIMITS.externalIdMax ? `At most ${LIMITS.externalIdMax} characters.` : undefined;
}

export function validateAssetCreate(form: AssetCreateForm, instantiableTypeIds: ReadonlySet<string>): FieldErrors {
  const e: FieldErrors = {};
  e.name = validateAssetName(form.name);
  if (!form.typeId) e.typeId = "Select an asset type.";
  else if (!instantiableTypeIds.has(form.typeId)) e.typeId = "Only instantiable asset types can be used.";
  e.externalId = validateExternalId(form.externalId);
  e.description = validateDescription(form.description);
  if (form.timezone.trim()) e.timezone = timezoneMessage(checkTimezone(form.timezone), form.timezone.trim());
  return e;
}

export function noErrors(e: FieldErrors): boolean {
  return Object.values(e).every((v) => !v);
}

/** POST /assets body. Timezone and twinType can only be set here (create-only). */
export function assetCreateRequest(parentId: string, form: AssetCreateForm): AmRequest {
  const body: AmAsset = { name: form.name.trim(), typeId: form.typeId, parentId, twinType: form.twinType };
  if (form.externalId.trim()) body.externalId = form.externalId.trim();
  if (form.description.trim()) body.description = form.description.trim();
  if (form.timezone.trim()) body.timezone = form.timezone.trim();
  return { method: "POST", path: amPath.assets(), body };
}

// ---------------------------------------------------------------------------
// Value edits
// ---------------------------------------------------------------------------

export interface AssetEdit {
  name: string;
  externalId: string;
  description: string;
  /** Asset (type) variable values by name. "" = no value set. */
  variables: Record<string, string>;
  /** Static aspect variable values: aspect name → variable name → value. */
  aspects: Record<string, Record<string, string>>;
}

export function assetEditFrom(a: AmAssetResource): AssetEdit {
  const aspects: AssetEdit["aspects"] = {};
  for (const asp of a.aspects ?? []) {
    aspects[asp.name] = Object.fromEntries(asp.variables.map((v) => [v.name, v.value]));
  }
  return {
    name: a.name,
    externalId: a.externalId ?? "",
    description: a.description ?? "",
    variables: Object.fromEntries((a.variables ?? []).map((v) => [v.name, v.value])),
    aspects,
  };
}

/** Static aspects (the only ones that carry values on asset level). */
export function staticAspects(aspects: readonly AmAspectResource[]): AmAspectResource[] {
  return aspects.filter((a) => a.category === "static");
}

export interface AssetEditErrors {
  fields: FieldErrors;
  /** "variable:<name>" or "aspect:<aspect>.<name>" → message. */
  values: Record<string, string>;
}

/**
 * Validate an asset edit against the variable definitions of the asset
 * (GET /assets/{id}/variables) and its static aspects (GET /assets/{id}/aspects).
 * A value that is already set cannot be emptied (Variable.value has minLength 1).
 */
export function validateAssetEdit(
  original: AmAssetResource,
  edit: AssetEdit,
  variableDefs: readonly AmVariableDefinition[],
  aspects: readonly AmAspectResource[],
): AssetEditErrors {
  const fields: FieldErrors = {
    name: validateAssetName(edit.name),
    externalId: validateExternalId(edit.externalId),
    description: validateDescription(edit.description),
  };
  const values: Record<string, string> = {};
  const was = assetEditFrom(original);
  for (const def of variableDefs) {
    const v = edit.variables[def.name] ?? "";
    const k = `variable:${def.name}`;
    if (v === "") {
      if ((was.variables[def.name] ?? "") !== "") values[k] = "A value that is set cannot be emptied.";
      continue;
    }
    const m = checkValue(def.dataType, v, def.length);
    if (m) values[k] = m;
  }
  for (const asp of staticAspects(aspects)) {
    for (const def of asp.variables) {
      const v = edit.aspects[asp.name]?.[def.name] ?? "";
      const k = `aspect:${asp.name}.${def.name}`;
      if (v === "") {
        if ((was.aspects[asp.name]?.[def.name] ?? "") !== "") values[k] = "A value that is set cannot be emptied.";
        continue;
      }
      const m = checkValue(def.dataType, v, def.length);
      if (m) values[k] = m;
    }
  }
  return { fields, values };
}

export function assetEditOk(e: AssetEditErrors): boolean {
  return noErrors(e.fields) && Object.keys(e.values).length === 0;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Values the user changed relative to `base` (three-way merge input). */
function changedValues(edited: Record<string, string>, base: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(edited)) if (v !== "" && v !== (base[k] ?? "")) out[k] = v;
  return out;
}

function mergeVariables(current: readonly AmVariable[], changed: Record<string, string>): AmVariable[] {
  const out = current.map((v) => ({ name: v.name, value: changed[v.name] ?? v.value }));
  for (const [name, value] of Object.entries(changed)) {
    if (!out.some((v) => v.name === name)) out.push({ name, value });
  }
  return out;
}

function mergeAspects(current: readonly AmAspect[], changed: Record<string, Record<string, string>>): AmAspect[] {
  const out: AmAspect[] = current.map((a) => ({ name: a.name, variables: mergeVariables(a.variables, changed[a.name] ?? {}) }));
  for (const [name, vars] of Object.entries(changed)) {
    if (out.some((a) => a.name === name)) continue;
    const variables = mergeVariables([], vars);
    if (variables.length) out.push({ name, variables });
  }
  return out;
}

/**
 * Merge patch for PATCH /assets/{id}, computed three-way: only what the user
 * changed relative to `base` (the version the edit started from) is applied
 * onto the *current* server asset. Arrays are replaced by merge patch
 * (RFC 7396), so `variables` and `aspects` are sent complete (current values
 * plus the changed values).
 */
export function assetPatchBody(current: AmAssetResource, edit: AssetEdit, baseAsset: AmAssetResource = current): Record<string, unknown> {
  const base = assetEditFrom(baseAsset);
  const body: Record<string, unknown> = {};
  const name = edit.name.trim();
  if (name !== base.name && name !== current.name) body.name = name;
  const ext = edit.externalId.trim();
  if (ext !== base.externalId && ext !== (current.externalId ?? "")) body.externalId = ext;
  const desc = edit.description.trim();
  if (desc !== base.description && desc !== (current.description ?? "")) body.description = desc;
  const vars = mergeVariables(current.variables ?? [], changedValues(edit.variables, base.variables));
  if (!sameJson(vars, (current.variables ?? []).map((v) => ({ name: v.name, value: v.value })))) body.variables = vars;
  const changedAspects: Record<string, Record<string, string>> = {};
  for (const [asp, vars2] of Object.entries(edit.aspects)) {
    const c = changedValues(vars2, base.aspects[asp] ?? {});
    if (Object.keys(c).length) changedAspects[asp] = c;
  }
  const aspects = mergeAspects(current.aspects ?? [], changedAspects);
  const before = (current.aspects ?? []).map((a) => ({ name: a.name, variables: a.variables.map((v) => ({ name: v.name, value: v.value })) }));
  if (!sameJson(aspects, before)) body.aspects = aspects;
  return body;
}

export function projectAsset(a: AmAssetResource) {
  return {
    name: a.name,
    externalId: a.externalId ?? "",
    description: a.description ?? "",
    parentId: a.parentId ?? null,
    variables: (a.variables ?? []).map((v) => ({ name: v.name, value: v.value })),
    aspects: (a.aspects ?? []).map((x) => ({ name: x.name, variables: x.variables.map((v) => ({ name: v.name, value: v.value })) })),
    location: a.location ?? null,
    fileAssignments: (a.fileAssignments ?? []).map((f) => ({ key: f.key, fileId: f.fileId })),
  };
}

const fetchAsset = (t: AmTransport, connectionId: string, id: string) =>
  fetchWithEtag<AmAssetResource>(t, connectionId, amPath.asset(id));

export function assetEditSession(
  t: AmTransport,
  connectionId: string,
  original: AmAssetResource,
  edit: AssetEdit,
): EditSession<AmAssetResource> {
  const mine = projectAsset({ ...original, ...assetPatchBody(original, edit) } as AmAssetResource);
  return {
    fetch: () => fetchAsset(t, connectionId, original.assetId),
    plan: (current) => {
      const body = assetPatchBody(current, edit, original);
      if (!Object.keys(body).length) return [];
      return [
        {
          label: "Update asset",
          build: (etag) => ({
            method: "PATCH",
            path: amPath.asset(current.assetId),
            ifMatch: etag,
            contentType: "application/merge-patch+json",
            body,
          }),
        },
      ];
    },
    mine,
    project: projectAsset,
  };
}

export function assetDeleteSession(t: AmTransport, connectionId: string, original: AmAssetResource): EditSession<AmAssetResource> {
  return {
    fetch: () => fetchAsset(t, connectionId, original.assetId),
    plan: (current) => [
      { label: "Delete asset", build: (etag) => ({ method: "DELETE", path: amPath.asset(current.assetId), ifMatch: etag }) },
    ],
    mine: projectAsset(original),
    project: projectAsset,
  };
}

/** Why `target` cannot become the new parent of `asset` (undefined = allowed). */
export function moveBlockedReason(asset: AmAssetResource, target: AmAssetResource): string | undefined {
  if (!asset.parentId) return "The root asset cannot be moved.";
  if (target.assetId === asset.assetId) return "An asset cannot be moved below itself.";
  if ((target.hierarchyPath ?? []).some((p) => p.assetId === asset.assetId)) return "The target is a descendant of this asset.";
  if (asset.parentId === target.assetId) return "The asset is already below this parent.";
  return undefined;
}

export function assetMoveSession(
  t: AmTransport,
  connectionId: string,
  original: AmAssetResource,
  newParentId: string,
): EditSession<AmAssetResource> {
  return {
    fetch: () => fetchAsset(t, connectionId, original.assetId),
    plan: (current) =>
      current.parentId === newParentId
        ? []
        : [
            {
              label: "Move asset",
              build: (etag) => ({ method: "POST", path: amPath.assetMove(current.assetId), ifMatch: etag, body: { newParentId } }),
            },
          ],
    mine: { ...projectAsset(original), parentId: newParentId },
    project: projectAsset,
  };
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

export interface LocationForm {
  country: string;
  region: string;
  locality: string;
  streetAddress: string;
  postalCode: string;
  longitude: string;
  latitude: string;
}

export function locationFormFrom(l: AmLocation | undefined | null): LocationForm {
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return {
    country: s(l?.country),
    region: s(l?.region),
    locality: s(l?.locality),
    streetAddress: s(l?.streetAddress),
    postalCode: s(l?.postalCode),
    longitude: s(l?.longitude),
    latitude: s(l?.latitude),
  };
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export function validateLocation(f: LocationForm): FieldErrors {
  const e: FieldErrors = {};
  for (const k of ["country", "region", "locality", "streetAddress", "postalCode"] as const) {
    if (f[k].length > LIMITS.locationFieldMax) e[k] = `At most ${LIMITS.locationFieldMax} characters.`;
  }
  if (!e.locality && !PATTERNS.locality.test(f.locality)) e.locality = "Letters, digits, spaces, _, - and ' only.";
  const num = (k: "longitude" | "latitude", min: number, max: number) => {
    const v = f[k].trim();
    if (!v) return;
    if (!NUMBER.test(v)) e[k] = "Enter a decimal number.";
    else if (Number(v) < min || Number(v) > max) e[k] = `Between ${min} and ${max}.`;
  };
  num("longitude", -180, 180);
  num("latitude", -90, 90);
  const any = Object.values(f).some((v) => v.trim() !== "");
  if (!any) e.country = "Enter at least one location field.";
  return e;
}

export function locationBody(f: LocationForm): AmLocation {
  const out: AmLocation = {};
  for (const k of ["country", "region", "locality", "streetAddress", "postalCode"] as const) {
    if (f[k].trim()) out[k] = f[k].trim();
  }
  if (f.longitude.trim()) out.longitude = Number(f.longitude.trim());
  if (f.latitude.trim()) out.latitude = Number(f.latitude.trim());
  return out;
}

/**
 * True when the asset's location is its own (PUT/DELETE /assets/{id}/location
 * address it); an inherited location's `_links.location` points to the ancestor.
 */
export function hasOwnLocation(a: AmAssetResource): boolean {
  if (!a.location) return false;
  const href = a._links?.location?.href;
  if (!href) return true;
  return href.includes(a.assetId);
}

export function assetLocationSession(
  t: AmTransport,
  connectionId: string,
  original: AmAssetResource,
  location: AmLocation | null,
): EditSession<AmAssetResource> {
  return {
    fetch: () => fetchAsset(t, connectionId, original.assetId),
    plan: (current) => [
      location
        ? {
            label: "Set location",
            build: (etag) => ({ method: "PUT", path: amPath.assetLocation(current.assetId), ifMatch: etag, body: location }),
          }
        : {
            label: "Remove location",
            build: (etag) => ({ method: "DELETE", path: amPath.assetLocation(current.assetId), ifMatch: etag }),
          },
    ],
    mine: { ...projectAsset(original), location },
    project: projectAsset,
  };
}

// ---------------------------------------------------------------------------
// File assignments
// ---------------------------------------------------------------------------

export function assetFileAssignSession(
  t: AmTransport,
  connectionId: string,
  original: AmAssetResource,
  key: string,
  fileId: string,
): EditSession<AmAssetResource> {
  const k = key.trim();
  const project = (a: AmAssetResource) => projectAsset(a).fileAssignments;
  return {
    fetch: () => fetchAsset(t, connectionId, original.assetId),
    plan: (current) => [
      {
        label: `Assign file to key ${k}`,
        build: (etag) => ({ method: "PUT", path: amPath.assetFileAssignment(current.assetId, k), ifMatch: etag, body: { fileId } }),
      },
    ],
    mine: [...project(original).filter((f) => f.key !== k), { key: k, fileId }],
    project,
  };
}

export function assetFileUnassignSession(
  t: AmTransport,
  connectionId: string,
  original: AmAssetResource,
  key: string,
): EditSession<AmAssetResource> {
  const project = (a: AmAssetResource) => projectAsset(a).fileAssignments;
  return {
    fetch: () => fetchAsset(t, connectionId, original.assetId),
    plan: (current) =>
      (current.fileAssignments ?? []).some((f) => f.key === key)
        ? [
            {
              label: `Remove file assignment ${key}`,
              build: (etag) => ({ method: "DELETE", path: amPath.assetFileAssignment(current.assetId, key), ifMatch: etag }),
            },
          ]
        : [],
    mine: project(original).filter((f) => f.key !== key),
    project,
  };
}

/** Breadcrumb of an asset (hierarchyPath ends with the parent; the asset itself is appended). */
export function assetBreadcrumb(a: AmAssetResource): { assetId: string; name: string }[] {
  const path = (a.hierarchyPath ?? []).map((p) => ({ assetId: p.assetId, name: p.name }));
  if (!path.length || path[path.length - 1]!.assetId !== a.assetId) path.push({ assetId: a.assetId, name: a.name });
  return path;
}
