// adapter/simulator/files implements the /files endpoints and the model
// lock / billboard resources:
//
//   POST   /files                multipart (file, name, scope, description)
//   PUT    /files/{fileId}       multipart, If-Match; file, name, scope required
//   GET    /files, /files/{fileId}, /files/{fileId}/file
//   DELETE /files/{fileId}       blocked while the file is assigned
//   GET|PUT /model/lock          lock state (PUT ?enabled=true|false)
//   GET /                        billboard links
//
// Uploads are limited to 5 MB and the content type must match the file name
// extension (the API validates this "to ensure no malicious file is being
// uploaded"; the table is shared with the studio).

import { checkContentType } from '../../domain/files/mime.js';

import {
  boolParam,
  checkIfMatch,
  notModified,
  resource,
  type Handler,
  type SimContext,
  type SimRequest,
} from './handler-util.js';
import type { FileRec } from './model.js';
import {
  applyFilter,
  applySort,
  halPage,
  pageParams,
  type QuerySpec,
} from './query.js';
import { LIMITS, PATTERNS } from './rules.js';
import { SimError, badRequest, notFound } from './sim-error.js';

const lc = (s: string): string => s.toLowerCase();

function listSpec(ctx: SimContext): QuerySpec<FileRec> {
  return {
    fields: [
      'id',
      'name',
      'originalFileName',
      'description',
      'tenantId',
      'subTenant',
      'scope',
      'uploaded',
      'lastModified',
      'isAssigned',
    ],
    get: (f, field) => {
      if (field === 'subTenant') return null;
      if (field === 'isAssigned') return ctx.t.isFileAssigned(f.id);
      return (f as unknown as Record<string, unknown>)[field];
    },
  };
}

function getExisting(ctx: SimContext, id: string): FileRec {
  const f = ctx.t.file(id);
  if (!f) throw notFound(`File ${id} not found`);
  return f;
}

interface Upload {
  bytes: Uint8Array;
  mimeType: string;
  originalFileName: string;
  name: string;
  scope: 'private' | 'public' | undefined;
  description: string | undefined;
}

async function readUpload(
  req: SimRequest,
  requireScope: boolean,
): Promise<Upload> {
  if (!req.form)
    throw new SimError(415, 'Content-Type must be multipart/form-data');
  const form = req.form;
  const file = form.get('file');
  if (file === null || typeof file === 'string')
    throw badRequest('Part "file" is required');
  const name = form.get('name');
  if (typeof name !== 'string' || name === '')
    throw badRequest('Part "name" is required');
  if (name.length > LIMITS.fileNameMax || !PATTERNS.fileName.test(name)) {
    throw badRequest(
      'name must not contain whitespace, "*", "&", "%", "/" or "\\" and be at most 255 characters',
    );
  }
  const scopeRaw = form.get('scope');
  if (scopeRaw !== null && scopeRaw !== 'private' && scopeRaw !== 'public') {
    throw badRequest('scope must be "public" or "private"');
  }
  if (requireScope && scopeRaw === null)
    throw badRequest('Part "scope" is required');
  const descriptionRaw = form.get('description');
  if (
    descriptionRaw !== null &&
    (typeof descriptionRaw !== 'string' ||
      descriptionRaw.length > LIMITS.fileDescriptionMax)
  ) {
    throw badRequest('description must be at most 255 characters');
  }
  if (file.size > LIMITS.fileSizeMaxBytes)
    throw badRequest('The file size cannot be more than 5 MB');
  const originalFileName = file.name || name;
  const mimeType = (file.type || 'application/octet-stream')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  const check = checkContentType(originalFileName, mimeType);
  if (!check.ok) {
    throw badRequest(
      check.reason === 'mismatch'
        ? `Content type ${mimeType} does not match the extension of ${originalFileName}`
        : `File type of ${originalFileName} is not supported`,
    );
  }
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    mimeType,
    originalFileName,
    name,
    scope: scopeRaw === null ? undefined : scopeRaw,
    description:
      typeof descriptionRaw === 'string' && descriptionRaw !== ''
        ? descriptionRaw
        : undefined,
  };
}

export const listFiles: Handler = (ctx, req) => {
  const p = pageParams(req.query);
  const spec = listSpec(ctx);
  const items = applySort(
    applyFilter([...ctx.t.files.values()], req.query.filter, spec),
    req.query.sort,
    spec,
    (f) => f.id,
  );
  return {
    status: 200,
    body: halPage(items, 'files', p, ctx.t.link('/files').href, (f) =>
      ctx.t.renderFile(f),
    ),
  };
};

export const getFile: Handler = (ctx, req) => {
  const f = getExisting(ctx, req.params.fileId!);
  return notModified(req, f.etag) ?? resource(200, ctx.t.renderFile(f), f.etag);
};

export const downloadFile: Handler = async (ctx, req) => {
  const f = getExisting(ctx, req.params.fileId!);
  const data = await ctx.blobs.read(f.id);
  return { status: 200, bytes: { data, contentType: f.mimeType } };
};

export const uploadFile: Handler = async (ctx, req) => {
  const up = await readUpload(req, false);
  const now = ctx.now();
  const rec: FileRec = {
    id: ctx.newId(),
    name: up.name,
    originalFileName: up.originalFileName,
    description: up.description ?? null,
    tenantId: ctx.t.tenant,
    scope: up.scope ?? 'private',
    mimeType: up.mimeType,
    size: up.bytes.byteLength,
    uploaded: now,
    lastModified: now,
    etag: 0,
  };
  await ctx.blobs.write(rec.id, up.bytes);
  ctx.t.files.set(lc(rec.id), rec);
  return {
    ...resource(201, ctx.t.renderFile(rec), rec.etag, {
      headers: { location: ctx.t.link(`/files/${rec.id}`).href },
    }),
    mutated: true,
  };
};

export const replaceFile: Handler = async (ctx, req) => {
  const f = getExisting(ctx, req.params.fileId!);
  checkIfMatch(req, f.etag, 'file');
  const up = await readUpload(req, true);
  const rec: FileRec = {
    ...f,
    name: up.name,
    originalFileName: up.originalFileName,
    description: up.description ?? null,
    scope: up.scope ?? f.scope,
    mimeType: up.mimeType,
    size: up.bytes.byteLength,
    lastModified: ctx.now(),
    etag: f.etag + 1,
  };
  await ctx.blobs.write(rec.id, up.bytes);
  ctx.t.files.set(lc(rec.id), rec);
  return { ...resource(200, ctx.t.renderFile(rec), rec.etag), mutated: true };
};

export const deleteFile: Handler = async (ctx, req) => {
  const f = getExisting(ctx, req.params.fileId!);
  checkIfMatch(req, f.etag, 'file');
  if (ctx.t.isFileAssigned(f.id)) {
    throw badRequest(
      `File ${f.id} is assigned to an asset or asset type and cannot be deleted`,
    );
  }
  ctx.t.files.delete(lc(f.id));
  await ctx.blobs.remove(f.id);
  return { status: 204, mutated: true };
};

export const getModelLock: Handler = (ctx) => ({
  status: 200,
  body: { enabled: ctx.t.modelLock, jobs: [] },
});

export const putModelLock: Handler = (ctx, req) => {
  if (req.query.enabled === undefined)
    throw badRequest('Parameter enabled is required');
  ctx.t.modelLock = boolParam(req, 'enabled', false);
  return { status: 200, body: { enabled: ctx.t.modelLock }, mutated: true };
};

export const getBillboard: Handler = (ctx) => ({
  status: 200,
  body: {
    self: ctx.t.link('/'),
    aspectTypes: ctx.t.link('/aspecttypes'),
    assetTypes: ctx.t.link('/assettypes'),
    assets: ctx.t.link('/assets'),
    files: ctx.t.link('/files'),
  },
});
