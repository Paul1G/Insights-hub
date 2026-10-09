// adapter/simulator/asset-types implements the /assettypes endpoints:
//
//   PUT    /assettypes/{id}                        create (201) / update (200)
//   PATCH  /assettypes/{id}                        RFC 7396 merge patch
//   DELETE /assettypes/{id}                        no child types, no instances
//   PATCH  /assettypes/{id}/variables              update name/unit/length/defaultValue
//   PUT    /assettypes/{id}/fileAssignments/{key}  add/replace own assignment
//   DELETE /assettypes/{id}/fileAssignments/{key}
//   GET    /assettypes, /assettypes/{id}           (exploded = include inherited)
//
// Rules (spec + modelling guidelines): variable and aspect names are unique in
// the whole type family (ancestors and descendants); dataType and searchable
// are immutable; string length only grows; parentTypeId cannot change; a
// type can become instantiable but not the other way round; aspects are
// updated by aspectId (name only) and removed by omission.

import {
  assertTenantId,
  assertUniqueNames,
  assertWritableType,
  boolParam,
  checkAssignableFile,
  checkDefault,
  checkIfMatch,
  checkLength,
  checkUnit,
  checkVariableName,
  isObject,
  notModified,
  optArray,
  optString,
  parseFileAssignments,
  parseVariableDef,
  reqString,
  requireBody,
  resource,
  type Handler,
  type SimContext,
} from './handler-util.js';
import type {
  AssetTypeRec,
  FileAssignmentRec,
  TypeAspectRec,
  VariableDef,
} from './model.js';
import {
  applyFilter,
  applySort,
  halPage,
  pageParams,
  type QuerySpec,
} from './query.js';
import {
  LIMITS,
  PATTERNS,
  isReserved,
  mergePatch,
  supportsLength,
} from './rules.js';
import { badRequest, notFound, preconditionFailed } from './sim-error.js';

const lc = (s: string): string => s.toLowerCase();

const LIST_SPEC: QuerySpec<AssetTypeRec> = {
  fields: [
    'id',
    'tenantId',
    'name',
    'description',
    'parentTypeId',
    'instantiable',
    'scope',
  ],
  get: (t, f) => (t as unknown as Record<string, unknown>)[f],
};

function getExisting(ctx: SimContext, id: string): AssetTypeRec {
  const t = ctx.t.assetType(id);
  if (!t) throw notFound(`Asset type ${id} not found`);
  return t;
}

interface AssetTypeDoc {
  name: string;
  description?: string;
  parentTypeId: string;
  instantiable: boolean;
  scope: 'private';
  variables: unknown[];
  aspects: unknown[];
  fileAssignments: unknown[];
}

function parseDoc(body: Record<string, unknown>): AssetTypeDoc {
  const name = reqString(
    body,
    'name',
    LIMITS.typeNameMax,
    PATTERNS.assetTypeName,
  );
  const description = optString(body, 'description', LIMITS.descriptionMax);
  const parentTypeId = reqString(
    body,
    'parentTypeId',
    LIMITS.typeIdMax,
    PATTERNS.typeId,
  );
  if (
    body.instantiable !== undefined &&
    typeof body.instantiable !== 'boolean'
  ) {
    throw badRequest('instantiable must be a boolean');
  }
  if (
    body.scope !== undefined &&
    body.scope !== 'private' &&
    body.scope !== 'public'
  ) {
    throw badRequest('scope must be "private" or "public"');
  }
  if (body.scope === 'public')
    throw badRequest('Currently only private asset types can be created');
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    parentTypeId,
    instantiable: body.instantiable !== false,
    scope: 'private',
    variables: optArray(body, 'variables') ?? [],
    aspects: optArray(body, 'aspects') ?? [],
    fileAssignments: optArray(body, 'fileAssignments') ?? [],
  };
}

/** Variable/aspect names used by the type family, excluding the type itself. */
function familyNames(
  ctx: SimContext,
  parentTypeId: string,
  selfId: string | undefined,
): { variables: Map<string, string>; aspects: Map<string, string> } {
  const variables = new Map<string, string>();
  const aspects = new Map<string, string>();
  const related = [
    ...ctx.t.typeChain(parentTypeId),
    ...(selfId ? ctx.t.descendantTypes(selfId) : []),
  ];
  for (const t of related) {
    for (const v of t.variables)
      if (!variables.has(lc(v.name))) variables.set(lc(v.name), t.id);
    for (const a of t.aspects)
      if (!aspects.has(lc(a.name))) aspects.set(lc(a.name), t.id);
  }
  return { variables, aspects };
}

function updateTypeVariable(
  existing: VariableDef,
  raw: Record<string, unknown>,
): VariableDef {
  const name = existing.name;
  if (raw.dataType !== undefined && raw.dataType !== existing.dataType) {
    throw badRequest(`Variable "${name}": dataType cannot be changed`);
  }
  if (raw.searchable !== undefined && raw.searchable !== existing.searchable) {
    throw badRequest(`Variable "${name}": searchable cannot be changed`);
  }
  let length = existing.length;
  if (
    supportsLength(existing.dataType) &&
    raw.length !== undefined &&
    raw.length !== null
  ) {
    length = checkLength(existing.dataType, raw.length);
    if ((length ?? 0) < (existing.length ?? 0)) {
      throw badRequest(`Variable "${name}": length can only be increased`);
    }
  }
  return {
    ...existing,
    unit: checkUnit(raw.unit),
    length,
    defaultValue: checkDefault(
      'asset-type',
      name,
      existing.dataType,
      length,
      raw.defaultValue,
    ),
  };
}

interface TypeContent {
  variables: VariableDef[];
  aspects: TypeAspectRec[];
  fileAssignments: FileAssignmentRec[];
  removedVariables: Set<string>;
  removedAspects: Set<string>;
  renamedAspects: Map<string, string>;
}

function buildContent(
  ctx: SimContext,
  doc: AssetTypeDoc,
  existing: AssetTypeRec | undefined,
): TypeContent {
  // Variables: matched by name; omitted ones are removed.
  const own = new Map((existing?.variables ?? []).map((v) => [lc(v.name), v]));
  const variables: VariableDef[] = [];
  const seenVars = new Set<string>();
  for (const raw of doc.variables) {
    if (!isObject(raw)) throw badRequest('Each variable must be an object');
    const name = checkVariableName(raw.name);
    if (seenVars.has(lc(name))) {
      throw badRequest(
        `Variable name "${name}" is not unique (names are case-insensitive)`,
      );
    }
    seenVars.add(lc(name));
    const cur = own.get(lc(name));
    variables.push(
      cur ? updateTypeVariable(cur, raw) : parseVariableDef(raw, 'asset-type'),
    );
  }
  const removedVariables = new Set(
    [...own.keys()].filter((k) => !seenVars.has(k)),
  );

  // Aspects: matched by aspectId; without aspectId they are created.
  const ownAspects = new Map(
    (existing?.aspects ?? []).map((a) => [a.aspectId, a]),
  );
  const aspects: TypeAspectRec[] = [];
  const keptIds = new Set<string>();
  const renamedAspects = new Map<string, string>();
  for (const raw of doc.aspects) {
    if (!isObject(raw)) throw badRequest('Each aspect must be an object');
    const name = raw.name;
    if (
      typeof name !== 'string' ||
      name.length < 1 ||
      name.length > LIMITS.aspectNameMax ||
      !PATTERNS.aspectName.test(name)
    ) {
      throw badRequest(
        `Aspect name must be 1..${LIMITS.aspectNameMax} characters of [a-zA-Z0-9_]`,
      );
    }
    if (isReserved(name))
      throw badRequest(`Aspect name "${name}" is a reserved word`);
    const aspectTypeId = raw.aspectTypeId;
    if (typeof aspectTypeId !== 'string' || !ctx.t.aspectType(aspectTypeId)) {
      throw badRequest(
        `Aspect "${name}": aspect type ${String(aspectTypeId)} does not exist`,
      );
    }
    const canonicalTypeId = ctx.t.aspectType(aspectTypeId)!.id;
    if (raw.aspectId !== undefined && raw.aspectId !== null) {
      const cur =
        typeof raw.aspectId === 'string'
          ? ownAspects.get(raw.aspectId)
          : undefined;
      if (!cur)
        throw badRequest(
          `Aspect "${name}": unknown aspectId ${JSON.stringify(raw.aspectId)}`,
        );
      if (lc(cur.aspectTypeId) !== lc(canonicalTypeId)) {
        throw badRequest(
          `Aspect "${cur.name}": the aspect type of an aspect cannot be changed`,
        );
      }
      if (keptIds.has(cur.aspectId))
        throw badRequest(`Aspect ${cur.aspectId} is listed twice`);
      keptIds.add(cur.aspectId);
      if (cur.name !== name) renamedAspects.set(lc(cur.name), name);
      aspects.push({ ...cur, name });
    } else {
      aspects.push({
        name,
        aspectTypeId: canonicalTypeId,
        aspectId: ctx.newId(),
      });
    }
  }
  assertUniqueNames(
    aspects.map((a) => a.name),
    'Aspect name',
  );
  const removedAspects = new Set(
    (existing?.aspects ?? [])
      .filter((a) => !keptIds.has(a.aspectId))
      .map((a) => lc(a.name)),
  );

  // Family uniqueness (ancestors via the parent, descendants of an existing type).
  const family = familyNames(ctx, doc.parentTypeId, existing?.id);
  for (const v of variables) {
    const owner = family.variables.get(lc(v.name));
    if (owner) {
      throw badRequest(
        `Variable "${v.name}" is already defined in asset type ${owner}; variable names must be unique in the type family`,
      );
    }
  }
  for (const a of aspects) {
    const owner = family.aspects.get(lc(a.name));
    if (owner) {
      throw badRequest(
        `Aspect "${a.name}" is already defined in asset type ${owner}; aspect names must be unique in the type family`,
      );
    }
  }

  return {
    variables,
    aspects,
    fileAssignments: parseFileAssignments(ctx, doc.fileAssignments),
    removedVariables,
    removedAspects,
    renamedAspects,
  };
}

function assertNameFree(ctx: SimContext, name: string, selfId?: string): void {
  for (const t of ctx.t.assetTypes.values()) {
    if (t.tenantId !== ctx.t.tenant) continue;
    if (selfId !== undefined && lc(t.id) === lc(selfId)) continue;
    if (lc(t.name) === lc(name)) {
      throw badRequest(
        `An asset type named "${t.name}" already exists (${t.id})`,
      );
    }
  }
}

/** Applies removed variables/aspects and aspect renames to instances. */
function propagate(
  ctx: SimContext,
  typeId: string,
  c: Pick<
    TypeContent,
    'removedVariables' | 'removedAspects' | 'renamedAspects'
  >,
): void {
  if (
    c.removedVariables.size === 0 &&
    c.removedAspects.size === 0 &&
    c.renamedAspects.size === 0
  )
    return;
  for (const asset of ctx.t.instancesOf(typeId)) {
    asset.variables = asset.variables.filter(
      (v) => !c.removedVariables.has(lc(v.name)),
    );
    asset.aspects = asset.aspects
      .filter((a) => !c.removedAspects.has(lc(a.name)))
      .map((a) => {
        const renamed = c.renamedAspects.get(lc(a.name));
        return renamed ? { ...a, name: renamed } : a;
      });
  }
}

function applyUpdate(
  ctx: SimContext,
  existing: AssetTypeRec,
  doc: AssetTypeDoc,
): AssetTypeRec {
  if (lc(doc.parentTypeId) !== lc(existing.parentTypeId ?? '')) {
    throw badRequest('The parentTypeId of an asset type cannot be changed');
  }
  if (existing.instantiable && !doc.instantiable) {
    throw badRequest(
      'An instantiable asset type cannot be changed to non-instantiable',
    );
  }
  assertNameFree(ctx, doc.name, existing.id);
  const content = buildContent(ctx, doc, existing);
  const next: AssetTypeRec = {
    ...existing,
    name: doc.name,
    instantiable: doc.instantiable,
    variables: content.variables,
    aspects: content.aspects,
    fileAssignments: content.fileAssignments,
    etag: existing.etag + 1,
  };
  if (doc.description !== undefined) next.description = doc.description;
  else delete next.description;
  ctx.t.assetTypes.set(lc(existing.id), next);
  propagate(ctx, existing.id, content);
  return next;
}

function docOf(t: AssetTypeRec): Record<string, unknown> {
  return {
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    parentTypeId: t.parentTypeId,
    instantiable: t.instantiable,
    scope: t.scope,
    variables: t.variables.map((v) => ({ ...v })),
    aspects: t.aspects.map((a) => ({ ...a })),
    fileAssignments: t.fileAssignments.map((f) => ({ ...f })),
  };
}

export const listAssetTypes: Handler = (ctx, req) => {
  const p = pageParams(req.query);
  const exploded = boolParam(req, 'exploded', false);
  boolParam(req, 'includeShared', false);
  const items = applySort(
    applyFilter([...ctx.t.assetTypes.values()], req.query.filter, LIST_SPEC),
    req.query.sort,
    LIST_SPEC,
    (t) => t.id,
  );
  return {
    status: 200,
    body: halPage(items, 'assetTypes', p, ctx.t.link('/assettypes').href, (t) =>
      ctx.t.renderAssetType(t, exploded),
    ),
  };
};

export const getAssetType: Handler = (ctx, req) => {
  const t = getExisting(ctx, req.params.id!);
  const exploded = boolParam(req, 'exploded', false);
  return (
    notModified(req, t.etag) ??
    resource(200, ctx.t.renderAssetType(t, exploded), t.etag)
  );
};

export const putAssetType: Handler = (ctx, req) => {
  const id = req.params.id!;
  const body = requireBody(req, 'json');
  const exploded = boolParam(req, 'exploded', false);
  const existing = ctx.t.assetType(id);
  if (existing) {
    if (req.headers['if-none-match']?.trim() === '*') {
      throw preconditionFailed(`Asset type ${existing.id} already exists`);
    }
    assertWritableType(ctx, existing.id, 'asset type');
    checkIfMatch(req, existing.etag, 'asset type');
    const next = applyUpdate(ctx, existing, parseDoc(body));
    return {
      ...resource(200, ctx.t.renderAssetType(next, exploded), next.etag),
      mutated: true,
    };
  }

  assertTenantId(ctx, id, 'asset type');
  const doc = parseDoc(body);
  const parent = ctx.t.assetType(doc.parentTypeId);
  if (!parent)
    throw badRequest(`Parent asset type ${doc.parentTypeId} does not exist`);
  assertNameFree(ctx, doc.name);
  const content = buildContent(
    ctx,
    { ...doc, parentTypeId: parent.id },
    undefined,
  );
  const rec: AssetTypeRec = {
    id,
    tenantId: ctx.t.tenant,
    name: doc.name,
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    parentTypeId: parent.id,
    instantiable: doc.instantiable,
    scope: doc.scope,
    variables: content.variables,
    aspects: content.aspects,
    fileAssignments: content.fileAssignments,
    etag: 0,
  };
  ctx.t.assetTypes.set(lc(id), rec);
  return {
    ...resource(201, ctx.t.renderAssetType(rec, exploded), rec.etag, {
      headers: { location: ctx.t.link(`/assettypes/${id}`).href },
    }),
    mutated: true,
  };
};

export const patchAssetType: Handler = (ctx, req) => {
  const existing = getExisting(ctx, req.params.id!);
  const patch = requireBody(req, 'merge-patch');
  const exploded = boolParam(req, 'exploded', false);
  assertWritableType(ctx, existing.id, 'asset type');
  checkIfMatch(req, existing.etag, 'asset type');
  const merged = mergePatch(docOf(existing), patch);
  if (!isObject(merged))
    throw badRequest('The merge patch must produce an object');
  const next = applyUpdate(ctx, existing, parseDoc(merged));
  return {
    ...resource(200, ctx.t.renderAssetType(next, exploded), next.etag),
    mutated: true,
  };
};

export const deleteAssetType: Handler = (ctx, req) => {
  const existing = getExisting(ctx, req.params.id!);
  assertWritableType(ctx, existing.id, 'asset type');
  checkIfMatch(req, existing.etag, 'asset type');
  const child = ctx.t.childTypes(existing.id)[0];
  if (child) {
    throw badRequest(
      `Asset type ${existing.id} has child type ${child.id} and cannot be deleted`,
    );
  }
  const instance = ctx.t.instancesOf(existing.id, false)[0];
  if (instance) {
    throw badRequest(
      `Asset type ${existing.id} is instantiated by asset ${instance.assetId} and cannot be deleted`,
    );
  }
  ctx.t.assetTypes.delete(lc(existing.id));
  return { status: 204, mutated: true };
};

const VARIABLE_UPDATE_FIELDS = new Set([
  'name',
  'unit',
  'length',
  'defaultValue',
]);

/** PATCH /assettypes/{id}/variables (VariableUpdateMap). */
export const patchAssetTypeVariables: Handler = (ctx, req) => {
  const existing = getExisting(ctx, req.params.id!);
  const map = requireBody(req, 'merge-patch');
  assertWritableType(ctx, existing.id, 'asset type');
  checkIfMatch(req, existing.etag, 'asset type');
  const entries = Object.entries(map);
  if (entries.length === 0)
    throw badRequest('The variables map must not be empty');

  const ownIndex = new Map(existing.variables.map((v, i) => [lc(v.name), i]));
  const inherited = new Set(
    ctx.t
      .explodedVariables(existing.id)
      .filter((v) => lc(v.origin) !== lc(existing.id))
      .map((v) => lc(v.item.name)),
  );
  const requestKeys = new Set(entries.map(([k]) => lc(k)));
  const next = existing.variables.map((v) => ({ ...v }));
  const renames = new Map<string, string>();

  for (const [key, value] of entries) {
    const idx = ownIndex.get(lc(key));
    if (idx === undefined) {
      if (inherited.has(lc(key))) {
        throw badRequest(
          `Variable ${key} is inherited; only variables defined on ${existing.id} can be updated`,
        );
      }
      throw notFound(`Variable ${key} not found in asset type ${existing.id}`);
    }
    if (!isObject(value)) {
      throw badRequest(
        `Variable ${key}: this operation cannot add or delete variables; use PUT/PATCH /assettypes/{id}`,
      );
    }
    const cur = existing.variables[idx]!;
    for (const [field, v] of Object.entries(value)) {
      if (VARIABLE_UPDATE_FIELDS.has(field)) continue;
      if (field === 'dataType' || field === 'searchable') {
        if (v !== cur[field])
          throw badRequest(`Variable ${cur.name}: ${field} cannot be changed`);
        continue;
      }
      throw badRequest(`Variable ${cur.name}: ${field} cannot be updated`);
    }
    const upd = next[idx]!;
    if (value.name !== undefined && value.name !== null) {
      const newName = checkVariableName(value.name);
      if (lc(newName) !== lc(cur.name) && requestKeys.has(lc(newName))) {
        throw badRequest(
          `Variable names must not be interchanged in one request ("${cur.name}" → "${newName}")`,
        );
      }
      if (newName !== cur.name) renames.set(lc(cur.name), newName);
      upd.name = newName;
    }
    if ('unit' in value) upd.unit = checkUnit(value.unit);
    if (value.length !== undefined && value.length !== null) {
      if (!supportsLength(cur.dataType)) {
        throw badRequest(
          `Variable ${cur.name}: length is only used for STRING variables`,
        );
      }
      const length = checkLength(cur.dataType, value.length);
      if ((length ?? 0) < (cur.length ?? 0)) {
        throw badRequest(`Variable ${cur.name}: length can only be increased`);
      }
      upd.length = length;
    }
    if ('defaultValue' in value) {
      upd.defaultValue = checkDefault(
        'asset-type',
        upd.name,
        upd.dataType,
        upd.length,
        value.defaultValue,
      );
    } else if (upd.defaultValue !== null) {
      // Re-validate an existing default against a changed length.
      upd.defaultValue = checkDefault(
        'asset-type',
        upd.name,
        upd.dataType,
        upd.length,
        upd.defaultValue,
      );
    }
  }

  assertUniqueNames(
    next.map((v) => v.name),
    'Variable name',
  );
  const family = familyNames(ctx, existing.parentTypeId ?? '', existing.id);
  for (const newName of renames.values()) {
    const owner = family.variables.get(lc(newName));
    if (owner) {
      throw badRequest(
        `Variable "${newName}" is already defined in asset type ${owner}; variable names must be unique in the type family`,
      );
    }
  }

  const rec: AssetTypeRec = {
    ...existing,
    variables: next,
    etag: existing.etag + 1,
  };
  ctx.t.assetTypes.set(lc(existing.id), rec);
  if (renames.size > 0) {
    for (const asset of ctx.t.instancesOf(existing.id)) {
      asset.variables = asset.variables.map((v) => {
        const renamed = renames.get(lc(v.name));
        return renamed ? { ...v, name: renamed } : v;
      });
    }
  }
  return { status: 204, headers: { etag: String(rec.etag) }, mutated: true };
};

export const putAssetTypeFileAssignment: Handler = (ctx, req) => {
  const existing = getExisting(ctx, req.params.id!);
  const body = requireBody(req, 'json');
  assertWritableType(ctx, existing.id, 'asset type');
  checkIfMatch(req, existing.etag, 'asset type');
  const key = req.params.key!;
  const fileId = checkAssignableFile(ctx, body.fileId);
  const fileAssignments = existing.fileAssignments.filter(
    (f) => lc(f.key) !== lc(key),
  );
  fileAssignments.push({ key, fileId });
  const rec: AssetTypeRec = {
    ...existing,
    fileAssignments,
    etag: existing.etag + 1,
  };
  ctx.t.assetTypes.set(lc(existing.id), rec);
  return {
    ...resource(200, ctx.t.renderAssetType(rec, false), rec.etag),
    mutated: true,
  };
};

export const deleteAssetTypeFileAssignment: Handler = (ctx, req) => {
  const existing = getExisting(ctx, req.params.id!);
  assertWritableType(ctx, existing.id, 'asset type');
  checkIfMatch(req, existing.etag, 'asset type');
  const key = req.params.key!;
  if (!existing.fileAssignments.some((f) => lc(f.key) === lc(key))) {
    throw notFound(
      `File assignment ${key} not found on asset type ${existing.id}`,
    );
  }
  const rec: AssetTypeRec = {
    ...existing,
    fileAssignments: existing.fileAssignments.filter(
      (f) => lc(f.key) !== lc(key),
    ),
    etag: existing.etag + 1,
  };
  ctx.t.assetTypes.set(lc(existing.id), rec);
  return {
    ...resource(200, ctx.t.renderAssetType(rec, false), rec.etag),
    mutated: true,
  };
};
