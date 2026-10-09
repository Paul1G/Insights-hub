// Aspect type create / edit / delete requests (PUT with If-None-Match: *,
// PATCH merge-patch for the description, PATCH …/variables for variables,
// DELETE with If-Match).

import type { AmRequest } from "@/api/client";
import type { AmAspectType, AmAspectTypeResource, AmVariableDefinition } from "@/api/amTypes";
import { isCoreId } from "@/domain/coreLibrary";
import { composeTypeId } from "@/domain/model";
import { LIMITS, PATTERNS } from "@/domain/rules";
import { fetchWithEtag, type EditSession, type PlannedRequest } from "./etag";
import { amPath, type AmTransport } from "./transport";
import {
  aspectTypeVariablePatches,
  definitionFromDraft,
  hasErrors,
  stripVariable,
  validateVariableDrafts,
  type DraftIssue,
  type VariableDraft,
  type VariableOwner,
} from "./variables";

export interface AspectTypeCreateForm {
  idSuffix: string;
  name: string;
  category: "static" | "dynamic";
  description: string;
  variables: VariableDraft[];
}

export type FieldErrors = Partial<Record<string, string>>;

export function validateTypeIdSuffix(tenant: string, suffix: string): string | undefined {
  const s = suffix.trim();
  if (!s) return "Id is required.";
  if (!PATTERNS.typeIdSuffix.test(s)) return "Letters, digits and _ only.";
  if (composeTypeId(tenant, s).length > LIMITS.typeIdMax) return `The full id <tenant>.<id> must be at most ${LIMITS.typeIdMax} characters.`;
  return undefined;
}

export function validateDescription(text: string): string | undefined {
  if (text.length > LIMITS.descriptionMax) return `At most ${LIMITS.descriptionMax} characters.`;
  if (!PATTERNS.noSingleQuote.test(text)) return "Single quotes are not allowed.";
  return undefined;
}

export function validateAspectTypeCreate(
  tenant: string,
  form: AspectTypeCreateForm,
  existing: readonly AmAspectTypeResource[],
): { fields: FieldErrors; variables: DraftIssue[]; ok: boolean } {
  const fields: FieldErrors = {};
  const id = composeTypeId(tenant, form.idSuffix.trim());
  fields.idSuffix = validateTypeIdSuffix(tenant, form.idSuffix);
  if (!fields.idSuffix && existing.some((t) => t.id.toLowerCase() === id.toLowerCase())) {
    fields.idSuffix = "An aspect type with this id already exists.";
  }
  const name = form.name.trim();
  if (!name) fields.name = "Name is required.";
  else if (name.length > LIMITS.aspectTypeNameMax) fields.name = `At most ${LIMITS.aspectTypeNameMax} characters.`;
  else if (!PATTERNS.aspectTypeName.test(name)) fields.name = "Letters, digits and _ only.";
  else if (existing.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    fields.name = "The name must be unique in the tenant (case-insensitive).";
  }
  fields.description = validateDescription(form.description);
  const owner: VariableOwner = { kind: "aspectType", category: form.category };
  const variables = validateVariableDrafts(form.variables, owner);
  if (form.variables.filter((v) => !v.deleted).length === 0) fields.variables = "An aspect type needs at least one variable.";
  const ok = Object.values(fields).every((v) => !v) && !hasErrors(variables);
  return { fields, variables, ok };
}

/** PUT /aspecttypes/{tenant}.{id} with If-None-Match: * (create only, never overwrite). */
export function aspectTypeCreateRequest(tenant: string, form: AspectTypeCreateForm): { id: string; request: AmRequest } {
  const id = composeTypeId(tenant, form.idSuffix.trim());
  const owner: VariableOwner = { kind: "aspectType", category: form.category };
  const body: AmAspectType = {
    name: form.name.trim(),
    category: form.category,
    scope: "private",
    variables: form.variables.filter((v) => !v.deleted).map((v) => definitionFromDraft(v, owner)),
  };
  if (form.description.trim()) body.description = form.description.trim();
  return { id, request: { method: "PUT", path: amPath.aspectType(id), ifNoneMatch: "*", body } };
}

export interface AspectTypeEdit {
  description: string;
  variables: VariableDraft[];
}

export function validateAspectTypeEdit(type: AmAspectTypeResource, edit: AspectTypeEdit) {
  const owner: VariableOwner = { kind: "aspectType", category: type.category };
  const description = validateDescription(edit.description);
  const variables = validateVariableDrafts(edit.variables, owner);
  const remaining = edit.variables.filter((v) => !v.deleted).length;
  const variablesError = remaining === 0 ? "An aspect type needs at least one variable." : undefined;
  return { description, variablesError, variables, ok: !description && !variablesError && !hasErrors(variables) };
}

/**
 * Requests that apply the edit to `current` (description first, then
 * variables). Three-way against `base` (the version the edit started from).
 */
export function planAspectTypeEdit(
  current: AmAspectTypeResource,
  edit: AspectTypeEdit,
  base: AmAspectTypeResource = current,
): PlannedRequest[] {
  if (isCoreId(current.id)) return [];
  const steps: PlannedRequest[] = [];
  const desc = edit.description.trim();
  if (desc !== (base.description ?? "") && desc !== (current.description ?? "")) {
    steps.push({
      label: "Update description",
      build: (etag) => ({
        method: "PATCH",
        path: amPath.aspectType(current.id),
        ifMatch: etag,
        contentType: "application/merge-patch+json",
        body: { description: desc },
      }),
    });
  }
  const patches = aspectTypeVariablePatches(current.variables, edit.variables, current.category);
  patches.forEach((body, i) => {
    steps.push({
      label: patches.length > 1 && i === 0 ? "Delete variables to recreate" : "Update variables",
      build: (etag) => ({
        method: "PATCH",
        path: amPath.aspectTypeVariables(current.id),
        ifMatch: etag,
        contentType: "application/merge-patch+json",
        body,
      }),
    });
  });
  return steps;
}

/** Comparable projection (description + variables) for the conflict diff. */
export function projectAspectType(t: AmAspectTypeResource) {
  const owner: VariableOwner = { kind: "aspectType", category: t.category };
  return {
    description: t.description ?? "",
    variables: t.variables.map((v) => stripVariable(v, owner)),
  };
}

export function intendedAspectType(t: AmAspectTypeResource, edit: AspectTypeEdit) {
  const owner: VariableOwner = { kind: "aspectType", category: t.category };
  return {
    description: edit.description.trim(),
    variables: edit.variables.filter((v) => !v.deleted).map((v): AmVariableDefinition => definitionFromDraft(v, owner)),
  };
}

export function aspectTypeEditSession(
  t: AmTransport,
  connectionId: string,
  original: AmAspectTypeResource,
  edit: AspectTypeEdit,
): EditSession<AmAspectTypeResource> {
  return {
    fetch: () => fetchWithEtag<AmAspectTypeResource>(t, connectionId, amPath.aspectType(original.id)),
    plan: (current) => planAspectTypeEdit(current, edit, original),
    mine: intendedAspectType(original, edit),
    project: projectAspectType,
  };
}

export function aspectTypeDeleteSession(
  t: AmTransport,
  connectionId: string,
  original: AmAspectTypeResource,
): EditSession<AmAspectTypeResource> {
  return {
    fetch: () => fetchWithEtag<AmAspectTypeResource>(t, connectionId, amPath.aspectType(original.id)),
    plan: (current) => [
      {
        label: "Delete aspect type",
        build: (etag) => ({ method: "DELETE", path: amPath.aspectType(current.id), ifMatch: etag }),
      },
    ],
    mine: projectAspectType(original),
    project: projectAspectType,
  };
}
