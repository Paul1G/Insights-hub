// domain/am/allowlist is the operation allowlist for proxied Asset Management
// v3 calls, derived from docs/reference/assetmanagement-v3.yaml (v3.19.0):
// every (method, path template) pair below exists in the spec's `paths`, and
// each operation's permitted query parameters are the ones the spec declares
// for it.
//
// Deliberately NOT reachable through the generic proxy:
//   - POST /files and PUT /files/{fileId} (multipart; use the files endpoints)
//   - GET /files/{fileId}/file (binary; use .../files/:fileId/content)
//
// Path parameters are validated against the spec's parameter patterns, which
// also makes traversal ("..", "%2F") and header/URL injection impossible: a
// matched path is rebuilt from validated segments only.

import type { HttpMethod } from '../upstream/transport.js';

type ParamKind = 'typeId' | 'uniqueId' | 'fileKey' | 'fileId';

const PARAM_PATTERNS: Record<ParamKind, RegExp> = {
  // TypeId: [A-Za-z0-9_]{1,8}\.[A-Za-z0-9_]+, length 1..128
  typeId: /^[A-Za-z0-9_]{1,8}\.[A-Za-z0-9_]+$/,
  // uniqueId (path): [0-9A-F]{32}; the resource schema uses lower-case hex.
  uniqueId: /^[0-9A-Fa-f]{32}$/,
  // fileKey: [\w]+
  fileKey: /^\w+$/,
  // fileId: [0-9A-F]{32}
  fileId: /^[0-9A-Fa-f]{32}$/,
};

const MAX_PARAM_LENGTH: Record<ParamKind, number> = {
  typeId: 128,
  uniqueId: 32,
  fileKey: 128,
  fileId: 32,
};

const LIST_QUERY = ['page', 'size', 'sort', 'filter'];

export interface Operation {
  method: HttpMethod;
  /** Spec path template, e.g. "/assettypes/{id}/variables". */
  template: string;
  operationId: string;
  query: readonly string[];
}

const op = (
  method: HttpMethod,
  template: string,
  operationId: string,
  query: readonly string[] = [],
): Operation => ({ method, template, operationId, query });

export const OPERATIONS: readonly Operation[] = [
  op('GET', '/', 'getBillboard'),
  // Asset types
  op('GET', '/assettypes', 'listAssetTypes', [
    ...LIST_QUERY,
    'exploded',
    'includeShared',
  ]),
  op('GET', '/assettypes/{id}', 'getAssetType', ['exploded', 'includeShared']),
  op('PUT', '/assettypes/{id}', 'saveAssetType', ['exploded', 'includeShared']),
  op('DELETE', '/assettypes/{id}', 'deleteAssetType', ['includeShared']),
  op('PATCH', '/assettypes/{id}', 'updateAssetType', [
    'exploded',
    'includeShared',
  ]),
  op(
    'PUT',
    '/assettypes/{id}/fileAssignments/{key}',
    'saveAssetTypeFileAssignment',
    ['includeShared'],
  ),
  op(
    'DELETE',
    '/assettypes/{id}/fileAssignments/{key}',
    'deleteAssetTypeFileAssignment',
    ['includeShared'],
  ),
  op('PATCH', '/assettypes/{id}/variables', 'updateAssetTypeVariable', [
    'includeShared',
  ]),
  // Aspect types
  op('GET', '/aspecttypes', 'listAspectTypes', [
    ...LIST_QUERY,
    'includeShared',
  ]),
  op('GET', '/aspecttypes/{id}', 'getAspectType', ['includeShared']),
  op('PUT', '/aspecttypes/{id}', 'saveAspectType', ['includeShared']),
  op('DELETE', '/aspecttypes/{id}', 'deleteAspectType', ['includeShared']),
  op('PATCH', '/aspecttypes/{id}', 'updateAspectType', ['includeShared']),
  op('PATCH', '/aspecttypes/{id}/variables', 'updateAspectTypeVariable'),
  // Assets
  op('GET', '/assets', 'listAssets', [
    ...LIST_QUERY,
    'includeShared',
    'basicFieldsOnly',
  ]),
  op('POST', '/assets', 'addAsset', ['includeShared']),
  op('GET', '/assets/root', 'getRootAsset'),
  op('GET', '/assets/{id}', 'getAsset', ['includeShared']),
  op('PUT', '/assets/{id}', 'replaceAsset', ['includeShared']),
  op('DELETE', '/assets/{id}', 'deleteAsset', ['includeShared']),
  op('PATCH', '/assets/{id}', 'updateAsset', ['includeShared']),
  op('POST', '/assets/{id}/move', 'moveAsset', ['includeShared']),
  op('GET', '/assets/{id}/variables', 'listAssetVariables', [
    ...LIST_QUERY,
    'includeShared',
  ]),
  op('GET', '/assets/{id}/aspects', 'listAssetAspects', [
    ...LIST_QUERY,
    'includeShared',
  ]),
  op('PUT', '/assets/{id}/fileAssignments/{key}', 'saveAssetFileAssignment', [
    'includeShared',
  ]),
  op(
    'DELETE',
    '/assets/{id}/fileAssignments/{key}',
    'deleteAssetFileAssigment',
    ['includeShared'],
  ),
  op('PUT', '/assets/{id}/location', 'saveAssetLocation', ['includeShared']),
  op('DELETE', '/assets/{id}/location', 'deleteAssetLocation', [
    'includeShared',
  ]),
  // Files (metadata only; uploads and downloads have dedicated endpoints)
  op('GET', '/files', 'listFiles', LIST_QUERY),
  op('GET', '/files/{fileId}', 'getFile'),
  op('DELETE', '/files/{fileId}', 'deleteFile'),
  // Asset model lock
  op('GET', '/model/lock', 'getAssetModelLock'),
  op('PUT', '/model/lock', 'putAssetModelLock', ['enabled']),
];

/** Which pattern a `{param}` uses depends on the resource collection. */
function paramKind(collection: string, name: string): ParamKind | undefined {
  if (name === 'key') return 'fileKey';
  if (name === 'fileId') return 'fileId';
  if (name !== 'id') return undefined;
  if (collection === 'assets') return 'uniqueId';
  if (collection === 'assettypes' || collection === 'aspecttypes')
    return 'typeId';
  return undefined;
}

export interface MatchedOperation {
  operation: Operation;
  /** Canonical, encoded path built from validated segments. */
  path: string;
  params: Record<string, string>;
}

export type MatchResult =
  | { ok: true; match: MatchedOperation }
  | { ok: false; reason: string };

function splitPath(path: string): string[] | undefined {
  if (!path.startsWith('/')) return undefined;
  if (path === '/') return [];
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const raw = trimmed.slice(1).split('/');
  const out: string[] = [];
  for (const seg of raw) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return undefined;
    }
    if (
      decoded === '' ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/')
    ) {
      return undefined;
    }
    out.push(decoded);
  }
  return out;
}

function matchTemplate(
  op: Operation,
  segments: string[],
): Record<string, string> | undefined {
  const tpl = op.template === '/' ? [] : op.template.slice(1).split('/');
  if (tpl.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  const collection = tpl[0] ?? '';
  for (let i = 0; i < tpl.length; i++) {
    const t = tpl[i]!;
    const s = segments[i]!;
    if (t.startsWith('{') && t.endsWith('}')) {
      const name = t.slice(1, -1);
      const kind = paramKind(collection, name);
      if (!kind) return undefined;
      if (s.length > MAX_PARAM_LENGTH[kind] || !PARAM_PATTERNS[kind].test(s)) {
        return undefined;
      }
      params[name] = s;
    } else if (t !== s) {
      return undefined;
    }
  }
  return params;
}

/**
 * matchOperation resolves (method, path) against the allowlist. The path may
 * be percent-encoded; query strings and fragments are not allowed in it.
 */
export function matchOperation(method: string, path: string): MatchResult {
  if (/[?#\s\\]/.test(path)) {
    return {
      ok: false,
      reason:
        'path must not contain a query, fragment, whitespace or backslash',
    };
  }
  const segments = splitPath(path);
  if (!segments) return { ok: false, reason: 'path is malformed' };
  const upper = method.toUpperCase();
  let pathKnown = false;
  for (const candidate of OPERATIONS) {
    const params = matchTemplate(candidate, segments);
    if (!params) continue;
    pathKnown = true;
    if (candidate.method !== upper) continue;
    const canonical =
      segments.length === 0
        ? '/'
        : `/${segments.map(encodeURIComponent).join('/')}`;
    return {
      ok: true,
      match: { operation: candidate, path: canonical, params },
    };
  }
  return {
    ok: false,
    reason: pathKnown
      ? `${upper} is not allowed on ${path}`
      : `${upper} ${path} is not an allowed Asset Management operation`,
  };
}

/** Methods that change upstream state (audited). */
export function isMutating(method: HttpMethod): boolean {
  return method !== 'GET';
}
