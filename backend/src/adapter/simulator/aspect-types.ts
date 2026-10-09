// adapter/simulator/aspect-types implements the /aspecttypes endpoints:
//
//   PUT    /aspecttypes/{id}            create (201) or restricted update (200)
//   PATCH  /aspecttypes/{id}            merge patch with the same restrictions
//   DELETE /aspecttypes/{id}            only if no asset type uses it
//   PATCH  /aspecttypes/{id}/variables  add / update / rename / delete (null)
//   GET    /aspecttypes, /aspecttypes/{id}
//
// Update rules (spec): only adding variables and restricted updates — unit,
// length of a static STRING may only grow, length of a dynamic STRING cannot
// change; name and category cannot change; renaming/removing variables only
// via PATCH .../variables, where all variable names must stay unique.

import {
  assertTenantId,
  assertUniqueNames,
  assertWritableType,
  checkDefault,
  checkIfMatch,
  checkLength,
  checkUnit,
  checkVariableName,
  isObject,
  notModified,
  optArray,
  optString,
  parseVariableDef,
  reqString,
  requireBody,
  resource,
  type Handler,
  type SimContext,
  type VariableContext,
} from './handler-util.js';
import type { AspectTypeRec, VariableDef } from './model.js';
import {
  applyFilter,
  applySort,
  halPage,
  pageParams,
  type QuerySpec,
} from './query.js';
import { LIMITS, PATTERNS, mergePatch, supportsLength } from './rules.js';
import { badRequest, notFound, preconditionFailed } from './sim-error.js';

const lc = (s: string): string => s.toLowerCase();

const LIST_SPEC: QuerySpec<AspectTypeRec> = {
  fields: ['id', 'tenantId', 'name', 'category', 'scope', 'description'],
  get: (t, f) => (t as unknown as Record<string, unknown>)[f],
};

function getExisting(ctx: SimContext, id: string): AspectTypeRec {
  const t = ctx.t.aspectType(id);
  if (!t) throw notFound(`Aspect type ${id} not found`);
  return t;
}

function variableContext(category: 'static' | 'dynamic'): VariableContext {
  return category === 'static' ? 'static-aspect' : 'dynamic-aspect';
}

interface AspectTypeDoc {
  name: string;
  category: 'static' | 'dynamic';
  scope: 'private' | 'public';
  description?: string;
  variables: unknown[];
}

function parseDoc(body: Record<string, unknown>): AspectTypeDoc {
  const name = reqString(
    body,
    'name',
    LIMITS.typeNameMax,
    PATTERNS.aspectTypeName,
  );
  const category = body.category;
  if (category !== 'static' && category !== 'dynamic') {
    throw badRequest('category must be "static" or "dynamic"');
  }
  const scope = body.scope;
  if (scope !== 'private' && scope !== 'public')
    throw badRequest('scope must be "private" or "public"');
  if (scope === 'public')
    throw badRequest('Currently only private aspect types can be created');
  const description = optString(
    body,
    'description',
    LIMITS.descriptionMax,
    PATTERNS.noSingleQuote,
  );
  const variables = optArray(body, 'variables');
  if (!variables || variables.length < 1)
    throw badRequest('An aspect type needs at least one variable');
  return {
    name,
    category,
    scope,
    ...(description !== undefined ? { description } : {}),
    variables,
  };
}

function assertNameFree(ctx: SimContext, name: string, selfId?: string): void {
  for (const t of ctx.t.aspectTypes.values()) {
    if (t.tenantId !== ctx.t.tenant) continue;
    if (selfId !== undefined && lc(t.id) === lc(selfId)) continue;
    if (lc(t.name) === lc(name)) {
      throw badRequest(
        `An aspect type named "${t.name}" already exists (${t.id})`,
      );
    }
  }
}

/**
 * Restricted update of an existing variable from a PUT/PATCH payload entry.
 * Immutable fields (dataType, searchable, qualityCode) may be repeated but
 * not changed; an omitted length keeps the current one; unit and
 * defaultValue are replaced (the payload is the complete definition).
 */
function restrictedUpdate(
  existing: VariableDef,
  raw: Record<string, unknown>,
  category: 'static' | 'dynamic',
): VariableDef {
  const name = existing.name;
  if (raw.dataType !== undefined && raw.dataType !== existing.dataType) {
    throw badRequest(`Variable "${name}": dataType cannot be changed`);
  }
  if (raw.searchable !== undefined && raw.searchable !== existing.searchable) {
    throw badRequest(`Variable "${name}": searchable cannot be changed`);
  }
  if (
    raw.qualityCode !== undefined &&
    raw.qualityCode !== (existing.qualityCode ?? false)
  ) {
    throw badRequest(`Variable "${name}": qualityCode cannot be changed`);
  }
  let length = existing.length;
  if (
    supportsLength(existing.dataType) &&
    raw.length !== undefined &&
    raw.length !== null
  ) {
    length = checkLength(existing.dataType, raw.length);
    if (length !== existing.length) {
      if (category === 'dynamic') {
        throw badRequest(
          `Variable "${name}": the length of a dynamic string variable cannot be changed`,
        );
      }
      if ((length ?? 0) < (existing.length ?? 0)) {
        throw badRequest(`Variable "${name}": length can only be increased`);
      }
    }
  }
  return {
    ...existing,
    unit: checkUnit(raw.unit),
    length,
    defaultValue: checkDefault(
      variableContext(category),
      name,
      existing.dataType,
      length,
      raw.defaultValue,
    ),
  };
}

/** PUT/PATCH semantics on an existing aspect type's variable list. */
function mergeVariables(
  existing: AspectTypeRec,
  raw: unknown[],
): VariableDef[] {
  const vctx = variableContext(existing.category);
  const incoming = new Map<string, Record<string, unknown>>();
  for (const item of raw) {
    if (!isObject(item)) throw badRequest('Each variable must be an object');
    const name = checkVariableName(item.name);
    if (incoming.has(lc(name))) {
      throw badRequest(
        `Variable name "${name}" is not unique (names are case-insensitive)`,
      );
    }
    incoming.set(lc(name), item);
  }
  for (const v of existing.variables) {
    if (!incoming.has(lc(v.name))) {
      throw badRequest(
        `Variable "${v.name}" is missing; variables can only be renamed or removed with PATCH /aspecttypes/{id}/variables`,
      );
    }
  }
  const out = existing.variables.map((v) =>
    restrictedUpdate(v, incoming.get(lc(v.name))!, existing.category),
  );
  const known = new Set(existing.variables.map((v) => lc(v.name)));
  for (const [key, item] of incoming) {
    if (!known.has(key)) out.push(parseVariableDef(item, vctx));
  }
  return out;
}

function applyUpdate(
  ctx: SimContext,
  existing: AspectTypeRec,
  doc: AspectTypeDoc,
): AspectTypeRec {
  if (doc.name !== existing.name)
    throw badRequest('The name of an aspect type cannot be changed');
  if (doc.category !== existing.category)
    throw badRequest('The category of an aspect type cannot be changed');
  const variables = mergeVariables(existing, doc.variables);
  const next: AspectTypeRec = {
    ...existing,
    variables,
    etag: existing.etag + 1,
  };
  if (doc.description !== undefined) next.description = doc.description;
  else delete next.description;
  ctx.t.aspectTypes.set(lc(existing.id), next);
  return next;
}

function docOf(t: AspectTypeRec): Record<string, unknown> {
  return {
    name: t.name,
    category: t.category,
    scope: t.scope,
    ...(t.description !== undefined ? { description: t.description } : {}),
    variables: t.variables.map((v) => ({ ...v })),
  };
}

export const listAspectTypes: Handler = (ctx, req) => {
  const p = pageParams(req.query);
  const items = applySort(
    applyFilter([...ctx.t.aspectTypes.values()], req.query.filter, LIST_SPEC),
    req.query.sort,
    LIST_SPEC,
    (t) => t.id,
  );
  return {
    status: 200,
    body: halPage(
      items,
      'aspectTypes',
      p,
      ctx.t.link('/aspecttypes').href,
      (t) => ctx.t.renderAspectType(t),
    ),
  };
};

export const getAspectType: Handler = (ctx, req) => {
  const t = getExisting(ctx, req.params.id!);
  return (
    notModified(req, t.etag) ?? resource(200, ctx.t.renderAspectType(t), t.etag)
  );
};

export const putAspectType: Handler = (ctx, req) => {
  const id = req.params.id!;
  const body = requireBody(req, 'json');
  const existing = ctx.t.aspectType(id);
  if (existing) {
    if (req.headers['if-none-match']?.trim() === '*') {
      throw preconditionFailed(`Aspect type ${existing.id} already exists`);
    }
    assertWritableType(ctx, existing.id, 'aspect type');
    checkIfMatch(req, existing.etag, 'aspect type');
    const next = applyUpdate(ctx, existing, parseDoc(body));
    return {
      ...resource(200, ctx.t.renderAspectType(next), next.etag),
      mutated: true,
    };
  }

  assertTenantId(ctx, id, 'aspect type');
  const doc = parseDoc(body);
  assertNameFree(ctx, doc.name);
  const vctx = variableContext(doc.category);
  const variables = doc.variables.map((v) => parseVariableDef(v, vctx));
  assertUniqueNames(
    variables.map((v) => v.name),
    'Variable name',
  );
  const rec: AspectTypeRec = {
    id,
    tenantId: ctx.t.tenant,
    name: doc.name,
    category: doc.category,
    scope: doc.scope,
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    variables,
    etag: 0,
  };
  ctx.t.aspectTypes.set(lc(id), rec);
  return {
    ...resource(201, ctx.t.renderAspectType(rec), rec.etag, {
      headers: { location: ctx.t.link(`/aspecttypes/${id}`).href },
    }),
    mutated: true,
  };
};

export const patchAspectType: Handler = (ctx, req) => {
  const existing = getExisting(ctx, req.params.id!);
  const patch = requireBody(req, 'merge-patch');
  assertWritableType(ctx, existing.id, 'aspect type');
  checkIfMatch(req, existing.etag, 'aspect type');
  const merged = mergePatch(docOf(existing), patch);
  if (!isObject(merged))
    throw badRequest('The merge patch must produce an object');
  const next = applyUpdate(ctx, existing, parseDoc(merged));
  return {
    ...resource(200, ctx.t.renderAspectType(next), next.etag),
    mutated: true,
  };
};

export const deleteAspectType: Handler = (ctx, req) => {
  const existing = getExisting(ctx, req.params.id!);
  assertWritableType(ctx, existing.id, 'aspect type');
  checkIfMatch(req, existing.etag, 'aspect type');
  const user = [...ctx.t.assetTypes.values()].find((t) =>
    t.aspects.some((a) => lc(a.aspectTypeId) === lc(existing.id)),
  );
  if (user) {
    throw badRequest(
      `Aspect type ${existing.id} is used by asset type ${user.id} and cannot be deleted`,
    );
  }
  ctx.t.aspectTypes.delete(lc(existing.id));
  return { status: 204, mutated: true };
};

/** PATCH /aspecttypes/{id}/variables (aspectVariableUpdateMap). */
export const patchAspectTypeVariables: Handler = (ctx, req) => {
  const existing = getExisting(ctx, req.params.id!);
  const map = requireBody(req, 'merge-patch');
  assertWritableType(ctx, existing.id, 'aspect type');
  checkIfMatch(req, existing.etag, 'aspect type');
  const entries = Object.entries(map);
  if (entries.length === 0)
    throw badRequest('The variables map must not be empty');

  const vctx = variableContext(existing.category);
  const byName = new Map(existing.variables.map((v, i) => [lc(v.name), i]));
  const result: (VariableDef | null)[] = existing.variables.map((v) => ({
    ...v,
  }));
  const renames = new Map<string, string>();
  const deleted = new Set<string>();
  const added: VariableDef[] = [];

  for (const [key, value] of entries) {
    const idx = byName.get(lc(key));
    if (value === null) {
      if (idx === undefined)
        throw notFound(
          `Variable ${key} not found in aspect type ${existing.id}`,
        );
      deleted.add(lc(existing.variables[idx]!.name));
      result[idx] = null;
      continue;
    }
    if (!isObject(value))
      throw badRequest(`Variable ${key}: value must be an object or null`);
    if (idx === undefined) {
      if (value.name !== undefined && value.name !== key) {
        throw badRequest(
          `Variable ${key}: the name of a new variable must equal its key`,
        );
      }
      added.push(parseVariableDef({ ...value, name: key }, vctx));
      continue;
    }
    const cur = existing.variables[idx]!;
    for (const immutable of [
      'dataType',
      'searchable',
      'qualityCode',
    ] as const) {
      const v = value[immutable];
      const curValue =
        immutable === 'qualityCode'
          ? (cur.qualityCode ?? false)
          : cur[immutable];
      if (v !== undefined && v !== curValue) {
        throw badRequest(
          `Variable ${cur.name}: ${immutable} cannot be changed`,
        );
      }
    }
    const next: VariableDef = { ...cur };
    if (value.name !== undefined) {
      next.name = checkVariableName(value.name);
      if (next.name !== cur.name) renames.set(lc(cur.name), next.name);
    }
    if ('unit' in value) next.unit = checkUnit(value.unit);
    if (
      'length' in value &&
      value.length !== null &&
      supportsLength(cur.dataType)
    ) {
      const length = checkLength(cur.dataType, value.length);
      if ((length ?? 0) < (cur.length ?? 0)) {
        throw badRequest(`Variable ${cur.name}: length can only be increased`);
      }
      next.length = length;
    }
    if ('defaultValue' in value) {
      next.defaultValue = checkDefault(
        vctx,
        next.name,
        next.dataType,
        next.length,
        value.defaultValue,
      );
    }
    result[idx] = next;
  }

  const variables = [
    ...result.filter((v): v is VariableDef => v !== null),
    ...added,
  ];
  if (variables.length < 1)
    throw badRequest('An aspect type needs at least one variable');
  const seen = new Set<string>();
  for (const v of variables) {
    if (seen.has(lc(v.name))) {
      throw badRequest(
        `All variable names must be unique in an aspect type ("${v.name}")`,
      );
    }
    seen.add(lc(v.name));
  }

  const next: AspectTypeRec = {
    ...existing,
    variables,
    etag: existing.etag + 1,
  };
  ctx.t.aspectTypes.set(lc(existing.id), next);
  propagateAspectVariableChanges(ctx, existing.id, renames, deleted);
  return { status: 204, headers: { etag: String(next.etag) }, mutated: true };
};

/** Renames/removes stored asset values of aspects backed by `aspectTypeId`. */
function propagateAspectVariableChanges(
  ctx: SimContext,
  aspectTypeId: string,
  renames: Map<string, string>,
  deleted: Set<string>,
): void {
  if (renames.size === 0 && deleted.size === 0) return;
  for (const asset of ctx.t.assets.values()) {
    for (const asp of asset.aspects) {
      const at = ctx.t.assetAspectType(asset, asp.name);
      if (!at || lc(at.id) !== lc(aspectTypeId)) continue;
      asp.variables = asp.variables
        .filter((v) => !deleted.has(lc(v.name)))
        .map((v) => {
          const renamed = renames.get(lc(v.name));
          return renamed ? { ...v, name: renamed } : v;
        });
    }
    asset.aspects = asset.aspects.filter((a) => a.variables.length > 0);
  }
}
