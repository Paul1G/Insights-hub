// adapter/simulator/simulator routes Asset Management v3 requests to the
// resource handlers of one simulated tenant. Requests are processed one at a
// time (per tenant) so optimistic-locking checks and the following mutation
// are atomic, exactly like a single-writer service. Responses are encoded
// like the real API: application/hal+json bodies, integer ETag headers, and
// `{"errors": [...]}` bodies for failures.

import type {
  UpstreamRequest,
  UpstreamResponse,
} from '../../domain/upstream/transport.js';
import type { Logger } from '../../log.js';

import * as aspectTypes from './aspect-types.js';
import * as assetTypes from './asset-types.js';
import * as assets from './assets.js';
import * as files from './files.js';
import type {
  Handler,
  SimContext,
  SimRequest,
  SimResult,
} from './handler-util.js';
import { SimError, errorBody } from './sim-error.js';
import type { TenantStore } from './store.js';
import type { SimTenant } from './tenant.js';

type Route = [method: string, template: string, handler: Handler];

const ROUTES: Route[] = [
  ['GET', '/', files.getBillboard],
  ['GET', '/aspecttypes', aspectTypes.listAspectTypes],
  ['GET', '/aspecttypes/{id}', aspectTypes.getAspectType],
  ['PUT', '/aspecttypes/{id}', aspectTypes.putAspectType],
  ['PATCH', '/aspecttypes/{id}', aspectTypes.patchAspectType],
  ['DELETE', '/aspecttypes/{id}', aspectTypes.deleteAspectType],
  [
    'PATCH',
    '/aspecttypes/{id}/variables',
    aspectTypes.patchAspectTypeVariables,
  ],
  ['GET', '/assettypes', assetTypes.listAssetTypes],
  ['GET', '/assettypes/{id}', assetTypes.getAssetType],
  ['PUT', '/assettypes/{id}', assetTypes.putAssetType],
  ['PATCH', '/assettypes/{id}', assetTypes.patchAssetType],
  ['DELETE', '/assettypes/{id}', assetTypes.deleteAssetType],
  ['PATCH', '/assettypes/{id}/variables', assetTypes.patchAssetTypeVariables],
  [
    'PUT',
    '/assettypes/{id}/fileAssignments/{key}',
    assetTypes.putAssetTypeFileAssignment,
  ],
  [
    'DELETE',
    '/assettypes/{id}/fileAssignments/{key}',
    assetTypes.deleteAssetTypeFileAssignment,
  ],
  ['GET', '/assets', assets.listAssets],
  ['POST', '/assets', assets.createAsset],
  ['GET', '/assets/root', assets.getRootAsset],
  ['GET', '/assets/{id}', assets.getAsset],
  ['PUT', '/assets/{id}', assets.putAsset],
  ['PATCH', '/assets/{id}', assets.patchAsset],
  ['DELETE', '/assets/{id}', assets.deleteAsset],
  ['POST', '/assets/{id}/move', assets.moveAsset],
  ['GET', '/assets/{id}/variables', assets.listAssetVariables],
  ['GET', '/assets/{id}/aspects', assets.listAssetAspects],
  ['PUT', '/assets/{id}/location', assets.putAssetLocation],
  ['DELETE', '/assets/{id}/location', assets.deleteAssetLocation],
  ['PUT', '/assets/{id}/fileAssignments/{key}', assets.putAssetFileAssignment],
  [
    'DELETE',
    '/assets/{id}/fileAssignments/{key}',
    assets.deleteAssetFileAssignment,
  ],
  ['GET', '/files', files.listFiles],
  ['POST', '/files', files.uploadFile],
  ['GET', '/files/{fileId}', files.getFile],
  ['PUT', '/files/{fileId}', files.replaceFile],
  ['DELETE', '/files/{fileId}', files.deleteFile],
  ['GET', '/files/{fileId}/file', files.downloadFile],
  ['GET', '/model/lock', files.getModelLock],
  ['PUT', '/model/lock', files.putModelLock],
];

function segments(path: string): string[] | undefined {
  if (path === '/' || path === '') return [];
  try {
    return path
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .map((s) => decodeURIComponent(s));
  } catch {
    return undefined;
  }
}

function matchRoute(
  method: string,
  path: string,
):
  | { handler: Handler; params: Record<string, string> }
  | { status: 404 | 405 } {
  const segs = segments(path);
  if (!segs) return { status: 404 };
  let pathMatched = false;
  for (const [m, template, handler] of ROUTES) {
    const tpl = template === '/' ? [] : template.slice(1).split('/');
    if (tpl.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < tpl.length && ok; i++) {
      const t = tpl[i]!;
      const s = segs[i]!;
      if (t.startsWith('{')) params[t.slice(1, -1)] = s;
      else ok = t === s;
    }
    if (!ok) continue;
    // "/assets/root" is a literal route; never treat "root" as an asset id.
    if (template === '/assets/{id}' && params.id === 'root') continue;
    pathMatched = true;
    if (m === method) return { handler, params };
  }
  return { status: pathMatched ? 405 : 404 };
}

const encoder = new TextEncoder();

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string>,
  error = false,
): UpstreamResponse {
  return {
    status,
    headers: {
      'content-type': error ? 'application/json' : 'application/hal+json',
      ...headers,
    },
    body: encoder.encode(JSON.stringify(body)),
  };
}

function encode(result: SimResult): UpstreamResponse {
  const headers = result.headers ?? {};
  if (result.bytes) {
    return {
      status: result.status,
      headers: { ...headers, 'content-type': result.bytes.contentType },
      body: result.bytes.data,
    };
  }
  if (result.body === undefined)
    return { status: result.status, headers, body: new Uint8Array() };
  return jsonResponse(result.status, result.body, headers);
}

export class AmSimulator {
  readonly tenant: SimTenant;
  private readonly store: TenantStore;
  private readonly logger: Logger;
  private readonly now: () => string;
  private readonly newId: () => string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: {
    tenant: SimTenant;
    store: TenantStore;
    logger: Logger;
    now: () => string;
    newId: () => string;
  }) {
    this.tenant = o.tenant;
    this.store = o.store;
    this.logger = o.logger;
    this.now = o.now;
    this.newId = o.newId;
  }

  handle(req: UpstreamRequest): Promise<UpstreamResponse> {
    const run = this.queue.then(() => this.process(req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  /** Waits for in-flight requests, then deletes the tenant from disk. */
  async destroy(): Promise<void> {
    await this.queue;
    await this.store.destroy();
  }

  private async process(req: UpstreamRequest): Promise<UpstreamResponse> {
    const route = matchRoute(req.method, req.path);
    if (!('handler' in route)) {
      const message =
        route.status === 405
          ? `Method ${req.method} is not supported on ${req.path}`
          : `No resource at ${req.path}`;
      return jsonResponse(
        route.status,
        errorBody(route.status, message),
        {},
        true,
      );
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {}))
      headers[k.toLowerCase()] = v;
    const simReq: SimRequest = {
      method: req.method,
      params: route.params,
      query: req.query ?? {},
      headers,
    };
    if (req.body?.kind === 'json') {
      simReq.contentType = req.body.contentType
        .split(';')[0]!
        .trim()
        .toLowerCase();
      try {
        simReq.json = JSON.parse(req.body.text) as unknown;
      } catch {
        return jsonResponse(
          400,
          errorBody(400, 'Request body is not valid JSON'),
          {},
          true,
        );
      }
    } else if (req.body?.kind === 'multipart') {
      simReq.contentType = 'multipart/form-data';
      simReq.form = req.body.form();
    }

    const ctx: SimContext = {
      t: this.tenant,
      now: this.now,
      newId: this.newId,
      blobs: this.store,
    };
    try {
      const result = await route.handler(ctx, simReq);
      if (result.mutated) this.store.scheduleSave(() => this.tenant.toState());
      return encode(result);
    } catch (err) {
      if (err instanceof SimError) {
        return jsonResponse(
          err.status,
          errorBody(err.status, err.message),
          {},
          true,
        );
      }
      this.logger.error(
        { err, method: req.method, path: req.path },
        'simulator: unexpected error',
      );
      return jsonResponse(
        500,
        errorBody(500, 'Internal simulator error'),
        {},
        true,
      );
    }
  }
}
