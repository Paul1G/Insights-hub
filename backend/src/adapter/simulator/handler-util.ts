// adapter/simulator/handler-util holds request/response types and the
// validation helpers shared by the simulator's resource handlers.

import type { HttpMethod } from '../../domain/upstream/transport.js';

import {
  DATA_TYPES,
  type DataType,
  type FileAssignmentRec,
  type VariableDef,
} from './model.js';
import {
  DEFAULT_BIG_STRING_LENGTH,
  DEFAULT_STRING_LENGTH,
  LIMITS,
  PATTERNS,
  checkValue,
  isReserved,
  parseEtagHeader,
  supportsLength,
} from './rules.js';
import {
  SimError,
  badRequest,
  notFound,
  preconditionFailed,
} from './sim-error.js';
import { isCoreId, type SimTenant } from './tenant.js';

export interface SimRequest {
  method: HttpMethod;
  params: Record<string, string>;
  query: Record<string, string>;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Media type without parameters, lower-cased. */
  contentType?: string;
  /** Parsed JSON body (undefined when there is none). */
  json?: unknown;
  form?: FormData;
}

export interface SimResult {
  status: number;
  body?: unknown;
  /** Raw bytes response (file download). */
  bytes?: { data: Uint8Array; contentType: string };
  headers?: Record<string, string>;
  /** True when tenant state changed and must be persisted. */
  mutated?: boolean;
}

export interface BlobStore {
  write(fileId: string, data: Uint8Array): Promise<void>;
  read(fileId: string): Promise<Uint8Array>;
  remove(fileId: string): Promise<void>;
}

export interface SimContext {
  t: SimTenant;
  now(): string;
  newId(): string;
  blobs: BlobStore;
}

export type Handler = (
  ctx: SimContext,
  req: SimRequest,
) => SimResult | Promise<SimResult>;

export function resource(
  status: number,
  body: Record<string, unknown>,
  etag: number,
  extra: Partial<SimResult> = {},
): SimResult {
  return {
    status,
    body,
    ...extra,
    headers: { etag: String(etag), ...(extra.headers ?? {}) },
  };
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function requireBody(
  req: SimRequest,
  mediaType: 'json' | 'merge-patch',
): Record<string, unknown> {
  const expected =
    mediaType === 'json' ? 'application/json' : 'application/merge-patch+json';
  if (req.json === undefined) throw badRequest('Request body is required');
  if (req.contentType !== expected) {
    throw new SimError(415, `Content-Type must be ${expected}`);
  }
  if (!isObject(req.json))
    throw badRequest('Request body must be a JSON object');
  return req.json;
}

/**
 * checkIfMatch enforces optimistic locking. `mandatory` mirrors the spec's
 * ifMatchMandatory/ifMatchVariable parameters; the optional ifMatch of the
 * PUT create-or-update operations is "*Required for modification*".
 */
export function checkIfMatch(
  req: SimRequest,
  current: number,
  what: string,
): void {
  const raw = req.headers['if-match'];
  if (raw === undefined)
    throw badRequest(`If-Match header is required to modify the ${what}`);
  const v = parseEtagHeader(raw);
  if (v === '*') return;
  if (v !== String(current)) {
    throw preconditionFailed(
      `The ${what} has been changed in the background (current etag ${current})`,
    );
  }
}

/** 304 handling for GETs with If-None-Match equal to the current etag. */
export function notModified(
  req: SimRequest,
  etag: number,
): SimResult | undefined {
  const v = parseEtagHeader(req.headers['if-none-match']);
  if (v !== undefined && (v === String(etag) || v === '*')) {
    return { status: 304, headers: { etag: String(etag) } };
  }
  return undefined;
}

export function boolParam(
  req: SimRequest,
  name: string,
  def: boolean,
): boolean {
  const v = req.query[name];
  if (v === undefined || v === '') return def;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw badRequest(`Parameter ${name} must be true or false`);
}

export function assertWritableType(
  ctx: SimContext,
  id: string,
  kind: string,
): void {
  if (isCoreId(id))
    throw badRequest(
      `Core ${kind} ${id} is read-only and cannot be modified or deleted`,
    );
  if (ctx.t.modelLock) {
    throw badRequest(
      `The asset model is locked; ${kind} ${id} cannot be updated or deleted`,
    );
  }
}

export function assertTenantId(
  ctx: SimContext,
  id: string,
  kind: string,
): void {
  if (id.length > LIMITS.typeIdMax || !PATTERNS.typeId.test(id)) {
    throw badRequest(`Invalid ${kind} id ${id}`);
  }
  if (isCoreId(id))
    throw badRequest(`${kind} ids starting with "core." are reserved`);
  const prefix = id.slice(0, id.indexOf('.'));
  if (prefix.toLowerCase() !== ctx.t.tenant.toLowerCase()) {
    throw badRequest(
      `The ${kind} id must start with the tenant name "${ctx.t.tenant}."`,
    );
  }
}

export function optString(
  body: Record<string, unknown>,
  key: string,
  max: number,
  pattern?: RegExp,
): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw badRequest(`${key} must be a string`);
  if (v.length > max)
    throw badRequest(`${key} must be at most ${max} characters`);
  if (pattern && !pattern.test(v))
    throw badRequest(`${key} contains invalid characters`);
  return v;
}

export function reqString(
  body: Record<string, unknown>,
  key: string,
  max: number,
  pattern?: RegExp,
): string {
  const v = optString(body, key, max, pattern);
  if (v === undefined || v.length === 0) throw badRequest(`${key} is required`);
  return v;
}

export function optArray(
  body: Record<string, unknown>,
  key: string,
): unknown[] | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw badRequest(`${key} must be an array`);
  return v as unknown[];
}

export type VariableContext = 'static-aspect' | 'dynamic-aspect' | 'asset-type';

export function checkVariableName(
  name: unknown,
  label = 'variable name',
): string {
  if (
    typeof name !== 'string' ||
    name.length < 1 ||
    name.length > LIMITS.variableNameMax
  ) {
    throw badRequest(
      `${label} must be 1..${LIMITS.variableNameMax} characters`,
    );
  }
  if (!PATTERNS.variableName.test(name))
    throw badRequest(`${label} "${name}" contains invalid characters`);
  if (isReserved(name))
    throw badRequest(`${label} "${name}" is a reserved word`);
  return name;
}

export function checkUnit(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (
    typeof v !== 'string' ||
    v.length > LIMITS.unitMax ||
    !PATTERNS.noSingleQuote.test(v)
  ) {
    throw badRequest(
      `unit must be a string of at most ${LIMITS.unitMax} characters without single quotes`,
    );
  }
  return v;
}

export function checkLength(dataType: DataType, v: unknown): number | null {
  if (!supportsLength(dataType)) return null; // only used for STRING / BIG_STRING
  const max =
    dataType === 'STRING' ? LIMITS.stringLengthMax : LIMITS.bigStringLengthMax;
  if (v === undefined || v === null) {
    return dataType === 'STRING'
      ? DEFAULT_STRING_LENGTH
      : DEFAULT_BIG_STRING_LENGTH;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
    throw badRequest(
      `length of a ${dataType} variable must be an integer between 1 and ${max}`,
    );
  }
  return v;
}

export function checkDefault(
  ctx: VariableContext,
  name: string,
  dataType: DataType,
  length: number | null,
  v: unknown,
): string | null {
  if (v === undefined || v === null) return null;
  if (ctx === 'dynamic-aspect') {
    throw badRequest(
      `Variable "${name}": default values are only available for static aspect variables`,
    );
  }
  if (
    typeof v !== 'string' ||
    v.length < 1 ||
    v.length > LIMITS.defaultValueMax
  ) {
    throw badRequest(
      `Variable "${name}": defaultValue must be a string of 1..${LIMITS.defaultValueMax} characters`,
    );
  }
  const problem = checkValue(dataType, v, length);
  if (problem)
    throw badRequest(
      `Variable "${name}": defaultValue is invalid (${problem})`,
    );
  return v;
}

/** Parses a VariableDefinition / AspectVariable from a request body. */
export function parseVariableDef(
  raw: unknown,
  ctx: VariableContext,
): VariableDef {
  if (!isObject(raw)) throw badRequest('Each variable must be an object');
  const name = checkVariableName(raw.name);
  const dataType = raw.dataType;
  if (
    typeof dataType !== 'string' ||
    !DATA_TYPES.includes(dataType as DataType)
  ) {
    throw badRequest(
      `Variable "${name}": dataType must be one of ${DATA_TYPES.join(', ')}`,
    );
  }
  const dt = dataType as DataType;
  if (dt === 'BIG_STRING' && ctx !== 'dynamic-aspect') {
    throw badRequest(
      `Variable "${name}": BIG_STRING can only be used in dynamic aspect types`,
    );
  }
  if (raw.searchable !== undefined && typeof raw.searchable !== 'boolean') {
    throw badRequest(`Variable "${name}": searchable must be a boolean`);
  }
  const length = checkLength(dt, raw.length);
  const def: VariableDef = {
    name,
    dataType: dt,
    unit: checkUnit(raw.unit),
    searchable: raw.searchable === true,
    length,
    defaultValue: checkDefault(ctx, name, dt, length, raw.defaultValue),
  };
  if (ctx !== 'asset-type') {
    if (raw.qualityCode !== undefined && typeof raw.qualityCode !== 'boolean') {
      throw badRequest(`Variable "${name}": qualityCode must be a boolean`);
    }
    def.qualityCode = raw.qualityCode === true;
  }
  return def;
}

export function assertUniqueNames(names: string[], what: string): void {
  const seen = new Set<string>();
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k))
      throw badRequest(
        `${what} "${n}" is not unique (names are case-insensitive)`,
      );
    seen.add(k);
  }
}

export function parseFileAssignments(
  ctx: SimContext,
  raw: unknown[] | undefined,
): FileAssignmentRec[] {
  if (raw === undefined) return [];
  const out: FileAssignmentRec[] = [];
  for (const item of raw) {
    if (!isObject(item))
      throw badRequest('Each file assignment must be an object');
    const key = item.key;
    if (typeof key !== 'string' || !PATTERNS.fileKey.test(key)) {
      throw badRequest('File assignment key must match [\\w]+');
    }
    out.push({ key, fileId: checkAssignableFile(ctx, item.fileId) });
  }
  assertUniqueNames(
    out.map((f) => f.key),
    'File assignment key',
  );
  return out;
}

export function checkAssignableFile(ctx: SimContext, fileId: unknown): string {
  if (typeof fileId !== 'string' || fileId === '')
    throw badRequest('fileId is required');
  const f = ctx.t.file(fileId);
  if (!f) throw notFound(`File ${fileId} not found`);
  return f.id;
}
