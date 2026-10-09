// Asset type create / edit / delete requests.
//
//   create:  PUT /assettypes/{tenant}.{id} with If-None-Match: *
//   edit:    PATCH /assettypes/{id} (merge patch: name, description,
//            instantiable false→true, complete direct `variables` array for
//            additions/removals, complete `aspects` array keeping `aspectId`
//            for renames), then PATCH /assettypes/{id}/variables for
//            name/unit/length/defaultValue updates of existing variables.
//            Recreated variables (dataType/searchable change) are removed in a
//            first PATCH and re-added in the second.
//   files:   PUT / DELETE /assettypes/{id}/fileAssignments/{key} (If-Match)
//   delete:  DELETE /assettypes/{id} (If-Match)

import type { AmRequest } from "@/api/client";
import type { AmAssetType, AmAssetTypeResource } from "@/api/amTypes";
import { isCoreId } from "@/domain/coreLibrary";
import { composeTypeId } from "@/domain/model";
import { isReservedWord, LIMITS, PATTERNS } from "@/domain/rules";
import { validateDescription, validateTypeIdSuffix, type FieldErrors } from "./aspectTypes";
import { fetchWithEtag, type EditSession, type PlannedRequest } from "./etag";
import { directAspects, directVariables } from "./impact";
import { amPath, type AmTransport } from "./transport";
import {
  assetTypeVariableArrays,
  assetTypeVariableUpdateMap,
  definitionFromDraft,
  hasErrors,
  stripVariable,
  validateVariableDrafts,
  type DraftIssue,
  type VariableDraft,
  type VariableOwner,
} from "./variables";

const OWNER: VariableOwner = { kind: "assetType" };

export interface AspectDraft {
  key: string;
  /** Internal id of an existing aspect (kept on rename). */
  aspectId?: string;
  /** Name on the server when loaded; undefined for new aspects. */
  originalName?: string;
  name: string;
  aspectTypeId: string;
  deleted: boolean;
}

let seq = 0;
export function newAspectDraft(aspectTypeId = "", name = ""): AspectDraft {
  return { key: `a${++seq}`, name, aspectTypeId, deleted: false };
}

export function aspectDraftsFrom(type: AmAssetTypeResource): AspectDraft[] {
  return directAspects(type).map((a) => ({
    key: `a${++seq}`,
    aspectId: a.aspectId,
    originalName: a.name,
    name: a.name,
    aspectTypeId: a.aspectType?.id ?? "",
    deleted: false,
  }));
}

export interface AspectIssue {
  key: string;
  field: "name" | "aspectTypeId";
  message: string;
}

/** Aspect names: pattern, ≤ 64, not reserved, unique in the type family. */
export function validateAspectDrafts(drafts: readonly AspectDraft[], familyNames: readonly string[] = []): AspectIssue[] {
  const issues: AspectIssue[] = [];
  const seen = new Set<string>();
  const family = new Set(familyNames.map((n) => n.toLowerCase()));
  for (const d of drafts) {
    if (d.deleted) continue;
    const name = d.name.trim();
    const lower = name.toLowerCase();
    const err = (field: AspectIssue["field"], message: string) => issues.push({ key: d.key, field, message });
    if (!name) err("name", "Name is required.");
    else if (name.length > LIMITS.aspectNameMax) err("name", `At most ${LIMITS.aspectNameMax} characters.`);
    else if (!PATTERNS.aspectName.test(name)) err("name", "Letters, digits and _ only.");
    else if (isReservedWord(name)) err("name", `"${name}" is a reserved word.`);
    if (name && seen.has(lower)) err("name", "Aspect names must be unique in the type family.");
    if (name && family.has(lower)) err("name", "This aspect name already exists in the type family (inherited or derived).");
    seen.add(lower);
    if (!d.aspectTypeId) err("aspectTypeId", "Select an aspect type.");
    else if (!PATTERNS.typeId.test(d.aspectTypeId)) err("aspectTypeId", "Not a valid aspect type id.");
  }
  return issues;
}

export interface AssetTypeCreateForm {
  idSuffix: string;
  name: string;
  description: string;
  parentTypeId: string;
  instantiable: boolean;
  variables: VariableDraft[];
  aspects: AspectDraft[];
}

export function validateAssetTypeName(name: string): string | undefined {
  const n = name.trim();
  if (!n) return "Name is required.";
  if (n.length > LIMITS.typeNameMax) return `At most ${LIMITS.typeNameMax} characters.`;
  if (!PATTERNS.assetTypeName.test(n)) return "Letters, digits, spaces, '.' and '_' only.";
  return undefined;
}

export function validateAssetTypeCreate(
  tenant: string,
  form: AssetTypeCreateForm,
  existing: readonly AmAssetTypeResource[],
  inheritedVariableNames: readonly string[] = [],
  inheritedAspectNames: readonly string[] = [],
): { fields: FieldErrors; variables: DraftIssue[]; aspects: AspectIssue[]; ok: boolean } {
  const fields: FieldErrors = {};
  const id = composeTypeId(tenant, form.idSuffix.trim());
  fields.idSuffix = validateTypeIdSuffix(tenant, form.idSuffix);
  if (!fields.idSuffix && existing.some((t) => t.id.toLowerCase() === id.toLowerCase())) {
    fields.idSuffix = "An asset type with this id already exists.";
  }
  fields.name = validateAssetTypeName(form.name);
  fields.description = validateDescription(form.description);
  if (!form.parentTypeId) fields.parentTypeId = "Select a parent type.";
  const variables = validateVariableDrafts(form.variables, OWNER, inheritedVariableNames);
  const aspects = validateAspectDrafts(form.aspects, inheritedAspectNames);
  const ok = Object.values(fields).every((v) => !v) && !hasErrors(variables) && aspects.length === 0;
  return { fields, variables, aspects, ok };
}

export function assetTypeCreateRequest(tenant: string, form: AssetTypeCreateForm): { id: string; request: AmRequest } {
  const id = composeTypeId(tenant, form.idSuffix.trim());
  const body: AmAssetType = {
    name: form.name.trim(),
    parentTypeId: form.parentTypeId,
    instantiable: form.instantiable,
    scope: "private",
    variables: form.variables.filter((v) => !v.deleted).map((v) => definitionFromDraft(v, OWNER)),
    aspects: form.aspects
      .filter((a) => !a.deleted)
      .map((a) => ({ name: a.name.trim(), aspectTypeId: a.aspectTypeId })),
  };
  if (form.description.trim()) body.description = form.description.trim();
  return { id, request: { method: "PUT", path: amPath.assetType(id), ifNoneMatch: "*", body } };
}

export interface AssetTypeEdit {
  name: string;
  description: string;
  instantiable: boolean;
  variables: VariableDraft[];
  aspects: AspectDraft[];
}

export function validateAssetTypeEdit(
  type: AmAssetTypeResource,
  edit: AssetTypeEdit,
  inheritedVariableNames: readonly string[] = [],
  inheritedAspectNames: readonly string[] = [],
) {
  const name = validateAssetTypeName(edit.name);
  const description = validateDescription(edit.description);
  const instantiable =
    type.instantiable && !edit.instantiable ? "An instantiable type cannot be made non-instantiable." : undefined;
  const variables = validateVariableDrafts(edit.variables, OWNER, inheritedVariableNames);
  const aspects = validateAspectDrafts(edit.aspects, inheritedAspectNames);
  return {
    name,
    description,
    instantiable,
    variables,
    aspects,
    ok: !name && !description && !instantiable && !hasErrors(variables) && aspects.length === 0,
  };
}

type AspectPayload = { name: string; aspectId?: string; aspectTypeId: string };

/** Final direct aspects for PATCH: renames keep aspectId, deletions are omitted. */
export function aspectArray(current: AmAssetTypeResource, drafts: readonly AspectDraft[]): { list: AspectPayload[]; changed: boolean } {
  const existing = directAspects(current);
  const byId = new Map(drafts.filter((d) => d.aspectId).map((d) => [d.aspectId!, d]));
  const byName = new Map(drafts.filter((d) => d.originalName).map((d) => [d.originalName!.toLowerCase(), d]));
  const list: AspectPayload[] = [];
  let changed = false;
  for (const a of existing) {
    const d = (a.aspectId && byId.get(a.aspectId)) || byName.get(a.name.toLowerCase());
    const payload: AspectPayload = { name: a.name, aspectTypeId: a.aspectType?.id ?? "" };
    if (a.aspectId) payload.aspectId = a.aspectId;
    if (d?.deleted) {
      changed = true;
      continue;
    }
    // Rename only when the user renamed it (three-way: keep concurrent renames otherwise).
    if (d && d.originalName !== undefined && d.name.trim() !== d.originalName && d.name.trim() !== a.name) {
      payload.name = d.name.trim();
      changed = true;
    }
    list.push(payload);
  }
  for (const d of drafts) {
    if (d.deleted || d.aspectId || d.originalName) continue;
    list.push({ name: d.name.trim(), aspectTypeId: d.aspectTypeId });
    changed = true;
  }
  return { list, changed };
}

/**
 * Requests that apply the edit to `current`. `base` is the version the edit
 * started from: scalar fields are only sent when the user changed them
 * (three-way), so a re-plan after a 412 keeps concurrent changes to untouched fields.
 */
export function planAssetTypeEdit(
  current: AmAssetTypeResource,
  edit: AssetTypeEdit,
  base: AmAssetTypeResource = current,
): PlannedRequest[] {
  if (isCoreId(current.id)) return [];
  const steps: PlannedRequest[] = [];
  const currentDirect = directVariables(current);
  const vars = assetTypeVariableArrays(currentDirect, edit.variables);
  const aspects = aspectArray(current, edit.aspects);
  const patch = (label: string, body: Record<string, unknown>): PlannedRequest => ({
    label,
    build: (etag) => ({
      method: "PATCH",
      path: amPath.assetType(current.id),
      ifMatch: etag,
      contentType: "application/merge-patch+json",
      body,
    }),
  });

  if (vars.removal) steps.push(patch("Remove variables to recreate", { variables: vars.removal }));

  const body: Record<string, unknown> = {};
  const name = edit.name.trim();
  if (name !== base.name && name !== current.name) body.name = name;
  const desc = edit.description.trim();
  if (desc !== (base.description ?? "") && desc !== (current.description ?? "")) body.description = desc;
  if (!current.instantiable && edit.instantiable && !base.instantiable) body.instantiable = true;
  if (vars.changed) body.variables = vars.final;
  if (aspects.changed) body.aspects = aspects.list;
  if (Object.keys(body).length) steps.push(patch("Update asset type", body));

  const updates = assetTypeVariableUpdateMap(currentDirect, edit.variables);
  if (Object.keys(updates).length) {
    steps.push({
      label: "Update variables",
      build: (etag) => ({
        method: "PATCH",
        path: amPath.assetTypeVariables(current.id),
        ifMatch: etag,
        contentType: "application/merge-patch+json",
        body: updates,
      }),
    });
  }
  return steps;
}

export function projectAssetType(t: AmAssetTypeResource) {
  return {
    name: t.name,
    description: t.description ?? "",
    instantiable: t.instantiable,
    variables: directVariables(t).map((v) => stripVariable(v, OWNER)),
    aspects: directAspects(t).map((a) => ({ name: a.name, aspectTypeId: a.aspectType?.id ?? "" })),
    fileAssignments: (t.fileAssignments ?? []).filter((f) => !f._links?.origin).map((f) => ({ key: f.key, fileId: f.fileId })),
  };
}

export function intendedAssetType(t: AmAssetTypeResource, edit: AssetTypeEdit) {
  return {
    ...projectAssetType(t),
    name: edit.name.trim(),
    description: edit.description.trim(),
    instantiable: edit.instantiable,
    variables: edit.variables.filter((v) => !v.deleted).map((v) => definitionFromDraft(v, OWNER)),
    aspects: edit.aspects.filter((a) => !a.deleted).map((a) => ({ name: a.name.trim(), aspectTypeId: a.aspectTypeId })),
  };
}

const fetchType = (t: AmTransport, connectionId: string, id: string) =>
  fetchWithEtag<AmAssetTypeResource>(t, connectionId, amPath.assetType(id));

export function assetTypeEditSession(
  t: AmTransport,
  connectionId: string,
  original: AmAssetTypeResource,
  edit: AssetTypeEdit,
): EditSession<AmAssetTypeResource> {
  return {
    fetch: () => fetchType(t, connectionId, original.id),
    plan: (current) => planAssetTypeEdit(current, edit, original),
    mine: intendedAssetType(original, edit),
    project: projectAssetType,
  };
}

export function assetTypeDeleteSession(
  t: AmTransport,
  connectionId: string,
  original: AmAssetTypeResource,
): EditSession<AmAssetTypeResource> {
  return {
    fetch: () => fetchType(t, connectionId, original.id),
    plan: (current) => [
      { label: "Delete asset type", build: (etag) => ({ method: "DELETE", path: amPath.assetType(current.id), ifMatch: etag }) },
    ],
    mine: projectAssetType(original),
    project: projectAssetType,
  };
}

export function validateFileKey(key: string): string | undefined {
  if (!key.trim()) return "Key is required.";
  if (!PATTERNS.fileKey.test(key.trim())) return "Letters, digits and _ only.";
  return undefined;
}

/** PUT /assettypes/{id}/fileAssignments/{key} {fileId}. */
export function assetTypeFileAssignSession(
  t: AmTransport,
  connectionId: string,
  original: AmAssetTypeResource,
  key: string,
  fileId: string,
): EditSession<AmAssetTypeResource> {
  const k = key.trim();
  const project = (r: AmAssetTypeResource) => projectAssetType(r).fileAssignments;
  return {
    fetch: () => fetchType(t, connectionId, original.id),
    plan: (current) => [
      {
        label: `Assign file to key ${k}`,
        build: (etag) => ({
          method: "PUT",
          path: amPath.assetTypeFileAssignment(current.id, k),
          ifMatch: etag,
          body: { fileId },
        }),
      },
    ],
    mine: [...project(original).filter((f) => f.key !== k), { key: k, fileId }],
    project,
  };
}

/** DELETE /assettypes/{id}/fileAssignments/{key}. */
export function assetTypeFileUnassignSession(
  t: AmTransport,
  connectionId: string,
  original: AmAssetTypeResource,
  key: string,
): EditSession<AmAssetTypeResource> {
  const project = (r: AmAssetTypeResource) => projectAssetType(r).fileAssignments;
  return {
    fetch: () => fetchType(t, connectionId, original.id),
    plan: (current) =>
      (current.fileAssignments ?? []).some((f) => f.key === key && !f._links?.origin)
        ? [
            {
              label: `Remove file assignment ${key}`,
              build: (etag) => ({ method: "DELETE", path: amPath.assetTypeFileAssignment(current.id, key), ifMatch: etag }),
            },
          ]
        : [],
    mine: project(original).filter((f) => f.key !== key),
    project,
  };
}
