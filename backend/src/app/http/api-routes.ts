// app/http/api-routes binds the services to the /api routes of
// docs/api-contract.md. Every handler resolves the caller's identity from the
// proxy headers, validates the request shape and answers with the
// {"data": ...} envelope; errors are translated by the shared error handler.

import type { FastifyInstance } from 'fastify';

import type { ConnectionInput } from '../../domain/connection/connection.js';
import { toMe } from '../../domain/identity.js';
import type { AmProxyService } from '../service/am-proxy.js';
import type { AuditService } from '../service/audit.js';
import type { ConnectionService } from '../service/connections.js';
import type { FilesService } from '../service/files.js';
import type { ListerService } from '../service/lister.js';

import { parse, sendData } from './envelope.js';
import { identityOf } from './identity.js';
import {
  amRequestSchema,
  auditAppendSchema,
  auditQuerySchema,
  connectionInputSchema,
  fileParamsSchema,
  fileReplaceSchema,
  fileUploadSchema,
  idParamsSchema,
  listRequestSchema,
} from './schemas.js';

export interface ApiServices {
  connections: ConnectionService;
  proxy: AmProxyService;
  lister: ListerService;
  files: FilesService;
  audit: AuditService;
}

export function registerApiRoutes(app: FastifyInstance, s: ApiServices): void {
  app.get('/api/me', async (req, reply) =>
    sendData(reply, toMe(identityOf(req))),
  );

  // --- connections -------------------------------------------------------------

  app.get('/api/connections', async (req, reply) =>
    sendData(reply, await s.connections.list(identityOf(req))),
  );

  app.post('/api/connections', async (req, reply) => {
    const input: ConnectionInput = parse(
      connectionInputSchema,
      req.body,
      'connection',
    );
    return sendData(reply, await s.connections.create(identityOf(req), input));
  });

  app.put('/api/connections/:id', async (req, reply) => {
    const { id } = parse(idParamsSchema, req.params, 'path');
    const input: ConnectionInput = parse(
      connectionInputSchema,
      req.body,
      'connection',
    );
    return sendData(
      reply,
      await s.connections.update(identityOf(req), id, input),
    );
  });

  app.delete('/api/connections/:id', async (req, reply) => {
    const { id } = parse(idParamsSchema, req.params, 'path');
    await s.connections.delete(identityOf(req), id);
    return sendData(reply, { deleted: true });
  });

  app.post('/api/connections/:id/test', async (req, reply) => {
    const { id } = parse(idParamsSchema, req.params, 'path');
    return sendData(reply, await s.connections.test(identityOf(req), id));
  });

  // --- proxied Asset Management calls -------------------------------------------

  app.post('/api/connections/:id/am', async (req, reply) => {
    const { id } = parse(idParamsSchema, req.params, 'path');
    const am = parse(amRequestSchema, req.body, 'AmRequest');
    return sendData(reply, await s.proxy.call(identityOf(req), id, am));
  });

  app.post('/api/connections/:id/list', async (req, reply) => {
    const { id } = parse(idParamsSchema, req.params, 'path');
    const list = parse(listRequestSchema, req.body, 'ListRequest');
    return sendData(reply, await s.lister.listAll(identityOf(req), id, list));
  });

  // --- files ------------------------------------------------------------------------

  app.post('/api/connections/:id/files', async (req, reply) => {
    const { id } = parse(idParamsSchema, req.params, 'path');
    const input = parse(fileUploadSchema, req.body, 'FileUploadInput');
    return sendData(reply, await s.files.upload(identityOf(req), id, input));
  });

  app.put('/api/connections/:id/files/:fileId', async (req, reply) => {
    const { id, fileId } = parse(fileParamsSchema, req.params, 'path');
    const input = parse(fileReplaceSchema, req.body, 'FileUploadInput');
    return sendData(
      reply,
      await s.files.replace(identityOf(req), id, fileId, input),
    );
  });

  app.get('/api/connections/:id/files/:fileId/content', async (req, reply) => {
    const { id, fileId } = parse(fileParamsSchema, req.params, 'path');
    return sendData(reply, await s.files.download(identityOf(req), id, fileId));
  });

  // --- audit --------------------------------------------------------------------------

  app.get('/api/audit', async (req, reply) => {
    const q = parse(auditQuerySchema, req.query, 'query');
    return sendData(
      reply,
      await s.audit.list(identityOf(req), {
        ...(q.connectionId !== undefined
          ? { connectionId: q.connectionId }
          : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.before !== undefined ? { before: q.before } : {}),
      }),
    );
  });

  app.post('/api/audit', async (req, reply) => {
    const input = parse(auditAppendSchema, req.body, 'AuditAppend');
    return sendData(reply, await s.audit.append(identityOf(req), input));
  });
}
