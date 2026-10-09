// app/http/schemas validates request shapes with Zod. The shapes match the
// normative types in apps/web/src/api/client.ts; semantic rules (URL guard,
// allowlist, required secrets, file checks) live in the services.

import { z } from 'zod';

const str = (max: number) => z.string().max(max);

const authSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('client_credentials'),
    tokenUrl: str(2048),
    clientId: str(255),
    clientSecret: str(8192).optional(),
  }),
  z.object({
    mode: z.literal('app_credentials'),
    tokenUrl: str(2048),
    clientId: str(255),
    clientSecret: str(8192).optional(),
    appName: str(255),
    appVersion: str(255),
    hostTenant: str(255),
    userTenant: str(255),
  }),
  z.object({ mode: z.literal('bearer'), token: str(8192).optional() }),
  z.object({ mode: z.literal('simulator') }),
]);

export const connectionInputSchema = z.object({
  name: str(200),
  environment: str(200).default(''),
  tenant: str(64),
  apiBaseUrl: str(2048)
    .optional()
    .nullable()
    .transform((v) => v ?? undefined),
  auth: authSchema,
});

const queryValue = z.union([
  z.string().max(8192),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const amRequestSchema = z.object({
  method: z.enum(['GET', 'PUT', 'POST', 'PATCH', 'DELETE']),
  path: str(2048),
  query: z
    .record(queryValue.optional())
    .optional()
    .transform((q) => {
      if (!q) return undefined;
      const out: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(q))
        if (v !== undefined && v !== null) out[k] = v;
      return out;
    }),
  ifMatch: z.union([str(256), z.number()]).optional(),
  ifNoneMatch: str(256).optional(),
  body: z.unknown().optional(),
  contentType: z
    .enum(['application/json', 'application/merge-patch+json'])
    .optional(),
});

export const listRequestSchema = z.object({
  resource: z.enum([
    'assets',
    'assettypes',
    'aspecttypes',
    'files',
    'asset-variables',
    'asset-aspects',
  ]),
  assetId: str(64).optional(),
  filter: str(8192).optional(),
  sort: str(256).optional(),
  exploded: z.boolean().optional(),
  basicFieldsOnly: z.boolean().optional(),
  includeShared: z.boolean().optional(),
  maxItems: z.number().int().positive().optional(),
});

export const fileUploadSchema = z.object({
  name: str(255),
  description: str(255).optional(),
  scope: z.enum(['private', 'public']).optional(),
  fileName: str(255),
  mimeType: str(255),
  contentBase64: z.string(),
});

export const fileReplaceSchema = fileUploadSchema.extend({
  ifMatch: z.union([str(256), z.number()]).transform((v) => String(v)),
});

export const auditAppendSchema = z.object({
  connectionId: str(128).optional(),
  action: z.string().min(1).max(100),
  summary: z.string().min(1).max(1000),
  details: z.record(z.unknown()).optional(),
});

export const auditQuerySchema = z.object({
  connectionId: str(128).optional(),
  limit: z.coerce.number().int().optional(),
  before: str(64).optional(),
});

export const idParamsSchema = z.object({ id: z.string().min(1).max(128) });
export const fileParamsSchema = z.object({
  id: z.string().min(1).max(128),
  fileId: z.string().min(1).max(64),
});
