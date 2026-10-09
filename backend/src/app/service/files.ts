// app/service/files moves files between the studio (base64 inside JSON) and
// the Asset Management Files API (multipart). Before uploading it enforces
// the API's 5 MB limit, the file-name pattern, and that the content type is
// consistent with the file extension (same table as the frontend).

import { PayloadTooLargeError, ValidationError } from '../../domain/errors.js';
import { checkContentType } from '../../domain/files/mime.js';
import type { Identity } from '../../domain/identity.js';
import type { UpstreamRequest } from '../../domain/upstream/transport.js';

import {
  ACCEPT_HEADER,
  headerValue,
  toAmResponse,
  type AmProxyService,
  type AmResponse,
} from './am-proxy.js';
import type { ConnectionService } from './connections.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_NAME = /^[^*&%\s/\\]+$/;
const FILE_ID = /^[0-9A-Fa-f]{32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface FileUploadInput {
  name: string;
  description?: string;
  scope?: 'private' | 'public';
  fileName: string;
  mimeType: string;
  contentBase64: string;
}

export interface FileContent {
  mimeType: string;
  contentBase64: string;
}

function decodeBase64(b64: string): Buffer {
  const compact = b64.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) {
    throw new ValidationError('contentBase64 is not valid base64');
  }
  return Buffer.from(compact, 'base64');
}

function checkFileId(fileId: string): string {
  if (!FILE_ID.test(fileId))
    throw new ValidationError('fileId must be 32 hex characters');
  return fileId;
}

/** Validates an upload and returns a multipart form factory. */
export function prepareUpload(
  input: FileUploadInput,
  defaultScope: 'private' | 'public' | undefined,
): () => FormData {
  if (
    input.name.length < 1 ||
    input.name.length > 255 ||
    !FILE_NAME.test(input.name)
  ) {
    throw new ValidationError(
      'name must be 1..255 characters without whitespace, "*", "&", "%", "/" or "\\"',
    );
  }
  if (input.description !== undefined && input.description.length > 255) {
    throw new ValidationError('description must be at most 255 characters');
  }
  if (
    input.fileName.length < 1 ||
    input.fileName.length > 255 ||
    /[\r\n"\\/]/.test(input.fileName)
  ) {
    throw new ValidationError(
      'fileName must be 1..255 characters without quotes, slashes or line breaks',
    );
  }
  const mimeType = input.mimeType.trim();
  const check = checkContentType(input.fileName, mimeType);
  if (!check.ok) {
    const reason =
      check.reason === 'no-extension'
        ? `file name "${input.fileName}" has no extension`
        : check.reason === 'unknown-extension'
          ? `file extension of "${input.fileName}" is not supported`
          : `content type ${mimeType} does not match the file extension (expected ${(
              check.expected ?? []
            ).join(' or ')})`;
    throw new ValidationError(reason);
  }
  // Size check before decoding: base64 inflates by 4/3.
  if (input.contentBase64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 1024) {
    throw new PayloadTooLargeError(
      'File exceeds the 5 MB limit of the Asset Management API',
    );
  }
  const bytes = decodeBase64(input.contentBase64);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new PayloadTooLargeError(
      'File exceeds the 5 MB limit of the Asset Management API',
    );
  }
  const scope = input.scope ?? defaultScope;
  const name = input.name;
  const description = input.description;
  const fileName = input.fileName;
  return () => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType }), fileName);
    form.append('name', name);
    if (scope !== undefined) form.append('scope', scope);
    if (description !== undefined && description !== '')
      form.append('description', description);
    return form;
  };
}

export class FilesService {
  private readonly connections: ConnectionService;
  private readonly proxy: AmProxyService;

  constructor(o: { connections: ConnectionService; proxy: AmProxyService }) {
    this.connections = o.connections;
    this.proxy = o.proxy;
  }

  async upload(
    identity: Identity,
    connectionId: string,
    input: FileUploadInput,
  ): Promise<AmResponse> {
    const rec = await this.connections.getRecord(identity, connectionId);
    const form = prepareUpload(input, undefined);
    const req: UpstreamRequest = {
      method: 'POST',
      path: '/files',
      headers: { accept: ACCEPT_HEADER },
      body: { kind: 'multipart', form },
    };
    return this.proxy.executeAudited(identity, rec, req);
  }

  async replace(
    identity: Identity,
    connectionId: string,
    fileId: string,
    input: FileUploadInput & { ifMatch: string },
  ): Promise<AmResponse> {
    const rec = await this.connections.getRecord(identity, connectionId);
    const id = checkFileId(fileId);
    // PUT /files/{fileId} requires `scope`; default as the API does for POST.
    const form = prepareUpload(input, 'private');
    const req: UpstreamRequest = {
      method: 'PUT',
      path: `/files/${id}`,
      headers: {
        accept: ACCEPT_HEADER,
        'if-match': headerValue('ifMatch', input.ifMatch),
      },
      body: { kind: 'multipart', form },
    };
    return this.proxy.executeAudited(identity, rec, req);
  }

  async download(
    identity: Identity,
    connectionId: string,
    fileId: string,
  ): Promise<AmResponse> {
    const rec = await this.connections.getRecord(identity, connectionId);
    const id = checkFileId(fileId);
    const out = await this.proxy.executeRaw(identity, rec, {
      method: 'GET',
      path: `/files/${id}/file`,
      headers: { accept: '*/*' },
    });
    const base = toAmResponse(out);
    if (out.response.status !== 200) return base;
    const mimeType =
      (out.response.headers['content-type'] ?? '').split(';')[0]!.trim() ||
      'application/octet-stream';
    return {
      ...base,
      body: {
        mimeType,
        contentBase64: Buffer.from(out.response.body).toString('base64'),
      },
    };
  }
}
