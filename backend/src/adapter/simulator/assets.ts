// adapter/simulator/assets implements the /assets endpoints:
//
//   POST   /assets                              create (instantiable type, parent)
//   GET    /assets, /assets/{id}, /assets/root
//   PUT    /assets/{id}                         replace values
//   PATCH  /assets/{id}                         RFC 7396 merge patch of values
//   DELETE /assets/{id}                         not the root, not with children
//   POST   /assets/{id}/move                    new parent (not into own subtree)
//   GET    /assets/{id}/variables | /aspects    structure, paginated
//   PUT    /assets/{id}/location, DELETE        own location
//   PUT    /assets/{id}/fileAssignments/{key}, DELETE
//
// "Only values can be modified, asset's structure have to be modified in
// asset's type": variables and static aspect values must exist on the type;
// typeId and timezone cannot change; the parent changes only via move.

import {
  boolParam,
  checkAssignableFile,
  checkIfMatch,
  isObject,
  notModified,
  optArray,
  optString,
  parseFileAssignments,
  reqString,
  requireBody,
  resource,
  type Handler,
  type SimContext,
  type SimRequest,
} from './handler-util.js';
import type {
  AspectValuesRec,
  AssetRec,
  FileAssignmentRec,
  LocationRec,
  ValueRec,
} from './model.js';
import {
  applyFilter,
  applySort,
  fieldCondition,
  halPage,
  pageParams,
  type QuerySpec,
} from './query.js';
import {
  LIMITS,
  PATTERNS,
  checkTimezone,
  checkValue,
  mergePatch,
} from './rules.js';
import { SimError, badRequest, notFound } from './sim-error.js';
import { DEFAULT_TIMEZONE, type SimTenant } from './tenant.js';

const lc = (s: string): string => s.toLowerCase();

function listSpec(t: SimTenant): QuerySpec<AssetRec> {
  return {
    fields: [
      'assetId',
      'tenantId',
      'name',
      'externalId',
      't2Tenant',
      'subTenant',
      'timezone',
      'twinType',
      'deleted',
      'parentId',
      'typeId',
    ],
    get: (a, f) => {
      if (f === 't2Tenant' || f === 'subTenant' || f === 'deleted') return null;
      return (a as unknown as Record<string, unknown>)[f];
    },
    special: {
      hasType: (cond) => {
        const typeId =
          isObject(cond) && typeof cond.eq === 'string' ? cond.eq : cond;
        if (typeof typeId !== 'string')
          throw badRequest('Invalid filter: hasType expects a type id');
        return (a) => t.descendsFrom(a.typeId, typeId);
      },
      fileId: (cond) => {
        const match = fieldCondition(cond);
        return (a) =>
          [
            ...a.fileAssignments,
            ...t.typeFileAssignments(a.typeId).map((f) => f.item),
          ].some((fa) => match(fa.fileId));
      },
    },
  };
}

function getExisting(ctx: SimContext, id: string): AssetRec {
  const a = ctx.t.asset(id);
  if (!a) throw notFound(`Asset ${id} not found`);
  return a;
}

function parseLocation(raw: unknown): LocationRec {
  if (!isObject(raw)) throw badRequest('location must be an object');
  const str = (key: string, pattern?: RegExp): string | null =>
    optString(raw, key, LIMITS.locationFieldMax, pattern) ?? null;
  const num = (key: string, min: number, max: number): number | null => {
    const v = raw[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw badRequest(
        `location.${key} must be a number between ${min} and ${max}`,
      );
    }
    return v;
  };
  return {
    country: str('country'),
    region: str('region'),
    locality: str('locality', PATTERNS.locality),
    streetAddress: str('streetAddress'),
    postalCode: str('postalCode'),
    longitude: num('longitude', -180, 180),
    latitude: num('latitude', -90, 90),
  };
}

function parseValueList(
  raw: unknown[],
  defs: {
    name: string;
    dataType: Parameters<typeof checkValue>[0];
    length: number | null;
  }[],
  where: string,
): ValueRec[] {
  const byName = new Map(defs.map((d) => [lc(d.name), d]));
  const out: ValueRec[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isObject(item))
      throw badRequest(`${where}: each variable must be an object`);
    const { name, value } = item;
    if (typeof name !== 'string' || !PATTERNS.valueName.test(name)) {
      throw badRequest(`${where}: variable name is invalid`);
    }
    const def = byName.get(lc(name));
    if (!def) throw badRequest(`${where}: variable "${name}" is not defined`);
    if (seen.has(lc(name)))
      throw badRequest(`${where}: variable "${name}" is set twice`);
    seen.add(lc(name));
    if (typeof value !== 'string')
      throw badRequest(`${where}: value of "${name}" must be a string`);
    const problem = checkValue(def.dataType, value, def.length);
    if (problem)
      throw badRequest(
        `${where}: value of "${def.name}" is invalid (${problem})`,
      );
    out.push({ name: def.name, value });
  }
  return out;
}

interface AssetValues {
  name: string;
  externalId: string | null;
  description: string | null;
  location: LocationRec | null;
  variables: ValueRec[];
  aspects: AspectValuesRec[];
  fileAssignments: FileAssignmentRec[];
}

/** Parses the value fields of Asset / AssetUpdate against the asset type. */
function parseValues(
  ctx: SimContext,
  typeId: string,
  body: Record<string, unknown>,
): AssetValues {
  const name = reqString(body, 'name', LIMITS.assetNameMax, PATTERNS.assetName);
  const externalId =
    optString(body, 'externalId', LIMITS.externalIdMax) ?? null;
  const description =
    optString(
      body,
      'description',
      LIMITS.descriptionMax,
      PATTERNS.noSingleQuote,
    ) ?? null;
  const location =
    body.location === undefined || body.location === null
      ? null
      : parseLocation(body.location);

  const typeVars = ctx.t.explodedVariables(typeId).map((v) => v.item);
  const variables = parseValueList(
    optArray(body, 'variables') ?? [],
    typeVars,
    'variables',
  );

  const typeAspects = new Map(
    ctx.t.explodedAspects(typeId).map((a) => [lc(a.item.name), a.item]),
  );
  const aspects: AspectValuesRec[] = [];
  const seenAspects = new Set<string>();
  for (const raw of optArray(body, 'aspects') ?? []) {
    if (!isObject(raw) || typeof raw.name !== 'string') {
      throw badRequest('Each aspect must be an object with a name');
    }
    const ta = typeAspects.get(lc(raw.name));
    if (!ta)
      throw badRequest(
        `Aspect "${raw.name}" is not defined by asset type ${typeId}`,
      );
    if (seenAspects.has(lc(ta.name)))
      throw badRequest(`Aspect "${ta.name}" is listed twice`);
    seenAspects.add(lc(ta.name));
    const at = ctx.t.aspectType(ta.aspectTypeId);
    if (!at)
      throw badRequest(
        `Aspect "${ta.name}": aspect type ${ta.aspectTypeId} does not exist`,
      );
    if (at.category !== 'static') {
      throw badRequest(
        `Aspect "${ta.name}" is dynamic; values can only be set for static aspects`,
      );
    }
    const vars = parseValueList(
      optArray(raw, 'variables') ?? [],
      at.variables,
      `aspect "${ta.name}"`,
    );
    if (vars.length > 0) aspects.push({ name: ta.name, variables: vars });
  }

  return {
    name,
    externalId,
    description,
    location,
    variables,
    aspects,
    fileAssignments: parseFileAssignments(
      ctx,
      optArray(body, 'fileAssignments'),
    ),
  };
}

function render(
  ctx: SimContext,
  a: AssetRec,
  status = 200,
): ReturnType<typeof resource> {
  return resource(status, ctx.t.renderAsset(a), a.etag);
}

function writableValues(a: AssetRec): Record<string, unknown> {
  const location = a.location
    ? Object.fromEntries(
        Object.entries(a.location).filter(([, v]) => v !== null),
      )
    : undefined;
  return {
    name: a.name,
    ...(a.externalId !== null ? { externalId: a.externalId } : {}),
    ...(a.description !== null ? { description: a.description } : {}),
    ...(location ? { location } : {}),
    variables: a.variables.map((v) => ({ ...v })),
    aspects: a.aspects.map((asp) => ({
      name: asp.name,
      variables: asp.variables.map((v) => ({ ...v })),
    })),
    fileAssignments: a.fileAssignments.map((f) => ({ ...f })),
  };
}

function assertStructureUnchanged(
  a: AssetRec,
  body: Record<string, unknown>,
): void {
  if (
    body.typeId !== undefined &&
    (typeof body.typeId !== 'string' || lc(body.typeId) !== lc(a.typeId))
  ) {
    throw badRequest(
      "The typeId of an asset cannot be changed; the structure is defined by the asset's type",
    );
  }
  if (body.timezone !== undefined && body.timezone !== a.timezone) {
    throw badRequest('The timezone of an asset can only be set at creation');
  }
  if (body.parentId !== undefined && body.parentId !== a.parentId) {
    throw badRequest(
      'Use POST /assets/{id}/move to change the parent of an asset',
    );
  }
}

function replaceValues(
  ctx: SimContext,
  a: AssetRec,
  body: Record<string, unknown>,
): AssetRec {
  assertStructureUnchanged(a, body);
  const v = parseValues(ctx, a.typeId, body);
  const next: AssetRec = { ...a, ...v, etag: a.etag + 1 };
  ctx.t.assets.set(lc(a.assetId), next);
  return next;
}

export const listAssets: Handler = (ctx, req) => {
  const p = pageParams(req.query);
  const basicFieldsOnly = boolParam(req, 'basicFieldsOnly', false);
  boolParam(req, 'includeShared', false);
  const spec = listSpec(ctx.t);
  const items = applySort(
    applyFilter([...ctx.t.assets.values()], req.query.filter, spec),
    req.query.sort,
    spec,
    (a) => a.assetId,
  );
  return {
    status: 200,
    body: halPage(items, 'assets', p, ctx.t.link('/assets').href, (a) =>
      ctx.t.renderAsset(a, { basicFieldsOnly }),
    ),
  };
};

export const getRootAsset: Handler = (ctx, req) => {
  const root = getExisting(ctx, ctx.t.rootAssetId);
  return notModified(req, root.etag) ?? render(ctx, root);
};

export const getAsset: Handler = (ctx, req) => {
  const a = getExisting(ctx, req.params.id!);
  return notModified(req, a.etag) ?? render(ctx, a);
};

export const createAsset: Handler = (ctx, req) => {
  const body = requireBody(req, 'json');
  const typeId = reqString(body, 'typeId', LIMITS.typeIdMax, PATTERNS.typeId);
  const type = ctx.t.assetType(typeId);
  if (!type) throw badRequest(`Asset type ${typeId} does not exist`);
  if (!type.instantiable)
    throw badRequest(`Asset type ${type.id} is not instantiable`);
  if (ctx.t.isRootHierarchyType(type.id)) {
    throw badRequest(
      `Assets of root hierarchy type ${type.id} cannot be created`,
    );
  }
  const parentId = reqString(body, 'parentId', 32, PATTERNS.uniqueId);
  const parent = ctx.t.asset(parentId);
  if (!parent) throw badRequest(`Parent asset ${parentId} does not exist`);

  let timezone = DEFAULT_TIMEZONE;
  if (body.timezone !== undefined && body.timezone !== null) {
    if (typeof body.timezone !== 'string')
      throw badRequest('timezone must be a string');
    const problem = checkTimezone(body.timezone);
    if (problem) throw badRequest(problem);
    timezone = body.timezone;
  }
  const twinType = body.twinType ?? 'performance';
  if (twinType !== 'performance' && twinType !== 'simulation') {
    throw badRequest('twinType must be "performance" or "simulation"');
  }

  const values = parseValues(ctx, type.id, body);
  const asset: AssetRec = {
    assetId: ctx.newId(),
    tenantId: ctx.t.tenant,
    ...values,
    typeId: type.id,
    parentId: parent.assetId,
    timezone,
    twinType,
    etag: 0,
  };
  ctx.t.assets.set(lc(asset.assetId), asset);
  return {
    ...render(ctx, asset, 201),
    headers: {
      etag: String(asset.etag),
      location: ctx.t.link(`/assets/${asset.assetId}`).href,
    },
    mutated: true,
  };
};

export const putAsset: Handler = (ctx, req) => {
  const a = getExisting(ctx, req.params.id!);
  const body = requireBody(req, 'json');
  checkIfMatch(req, a.etag, 'asset');
  return { ...render(ctx, replaceValues(ctx, a, body)), mutated: true };
};

export const patchAsset: Handler = (ctx, req) => {
  const a = getExisting(ctx, req.params.id!);
  const patch = requireBody(req, 'merge-patch');
  checkIfMatch(req, a.etag, 'asset');
  assertStructureUnchanged(a, patch);
  const merged = mergePatch(writableValues(a), patch);
  if (!isObject(merged))
    throw badRequest('The merge patch must produce an object');
  for (const k of ['typeId', 'timezone', 'parentId', 'twinType'])
    delete merged[k];
  return { ...render(ctx, replaceValues(ctx, a, merged)), mutated: true };
};

export const deleteAsset: Handler = (ctx, req) => {
  const a = getExisting(ctx, req.params.id!);
  checkIfMatch(req, a.etag, 'asset');
  if (lc(a.assetId) === lc(ctx.t.rootAssetId))
    throw badRequest('The root asset cannot be deleted');
  const child = ctx.t.assetChildren(a.assetId)[0];
  if (child)
    throw badRequest(
      `Asset ${a.assetId} has children (e.g. ${child.assetId}) and cannot be deleted`,
    );
  ctx.t.assets.delete(lc(a.assetId));
  return { status: 204, mutated: true };
};

export const moveAsset: Handler = (ctx, req) => {
  const a = getExisting(ctx, req.params.id!);
  const body = requireBody(req, 'json');
  checkIfMatch(req, a.etag, 'asset');
  const newParentId = reqString(body, 'newParentId', 32, PATTERNS.uniqueId);
  if (lc(a.assetId) === lc(ctx.t.rootAssetId))
    throw badRequest('The root asset cannot be moved');
  const parent = ctx.t.asset(newParentId);
  if (!parent)
    throw badRequest(`New parent asset ${newParentId} does not exist`);
  if (ctx.t.isAncestorOrSelf(a.assetId, parent)) {
    throw badRequest(
      'An asset cannot be moved below itself or one of its descendants',
    );
  }
  const next: AssetRec = { ...a, parentId: parent.assetId, etag: a.etag + 1 };
  ctx.t.assets.set(lc(a.assetId), next);
  return { ...render(ctx, next), mutated: true };
};

const VARIABLE_SPEC: QuerySpec<Record<string, unknown>> = {
  fields: ['name', 'dataType', 'unit', 'searchable', 'length', 'defaultValue'],
  get: (v, f) => v[f],
};

export const listAssetVariables: Handler = (ctx, req) => {
  const a = getExisting(ctx, req.params.id!);
  const p = pageParams(req.query);
  const defs = ctx.t.explodedVariables(a.typeId).map(({ item }) => ({
    name: item.name,
    unit: item.unit,
    searchable: item.searchable,
    defaultValue: item.defaultValue,
    dataType: item.dataType,
    length: item.length,
  }));
  const items = applySort(
    applyFilter(defs, req.query.filter, VARIABLE_SPEC),
    req.query.sort,
    VARIABLE_SPEC,
    (v) => String(v.name),
  );
  return {
    status: 200,
    body: halPage(
      items,
      'variables',
      p,
      ctx.t.link(`/assets/${a.assetId}/variables`).href,
    ),
  };
};

const ASPECT_SPEC: QuerySpec<Record<string, unknown>> = {
  fields: [
    'name',
    'aspectTypeId',
    'holderAssetId',
    'aspectId',
    'category',
    'description',
  ],
  get: (v, f) => v[f],
};

export const listAssetAspects: Handler = (ctx, req) => {
  const a = getExisting(ctx, req.params.id!);
  const p = pageParams(req.query);
  const aspects = ctx.t.explodedAspects(a.typeId).flatMap(({ item }) => {
    const at = ctx.t.aspectType(item.aspectTypeId);
    if (!at) return [];
    return [
      {
        aspectTypeId: at.id,
        holderAssetId: a.assetId,
        name: item.name,
        aspectId: item.aspectId,
        category: at.category,
        ...(at.description !== undefined
          ? { description: at.description }
          : {}),
        variables: at.variables.map((v) => ctx.t.renderVariable(v, 'aspect')),
        _links: {
          self: ctx.t.link(`/assets/${a.assetId}/aspects`),
          asset: ctx.t.link(`/assets/${a.assetId}`),
          aspectType: ctx.t.link(`/aspecttypes/${at.id}`),
        },
      },
    ];
  });
  const items = applySort(
    applyFilter(aspects, req.query.filter, ASPECT_SPEC),
    req.query.sort,
    ASPECT_SPEC,
    (v) => String(v.name),
  );
  return {
    status: 200,
    body: halPage(
      items,
      'aspects',
      p,
      ctx.t.link(`/assets/${a.assetId}/aspects`).href,
    ),
  };
};

export const putAssetLocation: Handler = (ctx, req) => {
  const a = getExisting(ctx, req.params.id!);
  const body = requireBody(req, 'json');
  checkIfMatch(req, a.etag, 'asset');
  const next: AssetRec = {
    ...a,
    location: parseLocation(body),
    etag: a.etag + 1,
  };
  ctx.t.assets.set(lc(a.assetId), next);
  return { ...render(ctx, next), mutated: true };
};

export const deleteAssetLocation: Handler = (ctx, req) => {
  const a = getExisting(ctx, req.params.id!);
  checkIfMatch(req, a.etag, 'asset');
  if (!a.location)
    throw new SimError(409, `Location not assigned to asset ${a.assetId}`);
  const next: AssetRec = { ...a, location: null, etag: a.etag + 1 };
  ctx.t.assets.set(lc(a.assetId), next);
  return { ...render(ctx, next), mutated: true };
};

function fileKey(req: SimRequest): string {
  return req.params.key!;
}

export const putAssetFileAssignment: Handler = (ctx, req) => {
  const a = getExisting(ctx, req.params.id!);
  const body = requireBody(req, 'json');
  checkIfMatch(req, a.etag, 'asset');
  const key = fileKey(req);
  const fileId = checkAssignableFile(ctx, body.fileId);
  const fileAssignments = a.fileAssignments.filter(
    (f) => lc(f.key) !== lc(key),
  );
  fileAssignments.push({ key, fileId });
  const next: AssetRec = { ...a, fileAssignments, etag: a.etag + 1 };
  ctx.t.assets.set(lc(a.assetId), next);
  return { ...render(ctx, next), mutated: true };
};

export const deleteAssetFileAssignment: Handler = (ctx, req) => {
  const a = getExisting(ctx, req.params.id!);
  checkIfMatch(req, a.etag, 'asset');
  const key = fileKey(req);
  if (!a.fileAssignments.some((f) => lc(f.key) === lc(key))) {
    throw notFound(`File assignment ${key} not found on asset ${a.assetId}`);
  }
  const next: AssetRec = {
    ...a,
    fileAssignments: a.fileAssignments.filter((f) => lc(f.key) !== lc(key)),
    etag: a.etag + 1,
  };
  ctx.t.assets.set(lc(a.assetId), next);
  return { ...render(ctx, next), mutated: true };
};
