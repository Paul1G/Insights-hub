# Asset Model Studio — Backend proxy API contract

The browser never talks to Insights Hub directly. The Node/TypeScript proxy in
`backend/` holds credentials (encrypted at rest), obtains tokens, applies
retries / backoff / concurrency limits and records an audit log. The frontend
client lives in `apps/web/src/api/client.ts`; **its TypeScript types are the
normative request/response shapes** — this document explains the semantics.

Base path: `/api` (nginx routes `/api/*` from :3000 to the backend on :8080).
Health: `GET /healthz` → `200 {"status":"ok"}`, `GET /readyz`.

## Envelope

Every `/api` response is JSON:

- success: `200 {"data": <payload>}`
- failure: `4xx/5xx {"error": "<human readable message>"}`

Proxy-level failures only: `400` invalid request / path not allowed,
`404` unknown connection, `413` body too large, `429` caller rate limit,
`502` token endpoint or network failure towards Insights Hub.

**Upstream Insights Hub responses are NOT mapped to the outer status.** A
proxied call returns `200 {"data": AmResponse}` where `AmResponse.status` is the
real upstream status (e.g. 412). The client turns `status >= 400` into
`UpstreamError` itself. This keeps ETag conflicts (412), 404s and validation
errors (400) inspectable.

## Identity

The platform's OAuth proxy sets `X-Forwarded-User` (stable id),
`X-Forwarded-Email`, `X-Forwarded-Preferred-Username`. These headers are
trusted. Connections and audit entries are **scoped per user id**. Requests
without `X-Forwarded-User` use the scope `anonymous` (local development).

- `GET /api/me` → `Me` (`anonymous: true` when the header is missing).

## Connections (tenant / environment management)

Stored per user in SQLite (`$APPLICATION_DATA_DIR/app.db`). The complete
connection configuration including URLs and secrets is encrypted with
AES-256-GCM. Key: `APP_ENCRYPTION_KEY` (base64, 32 bytes) or, if unset, a key
generated on first start and stored in `$APPLICATION_DATA_DIR/secret.key`
(mode 0600). Secrets are never returned, logged or written to the audit log.

| Method | Path | Body | Data |
|---|---|---|---|
| GET | `/api/connections` | – | `ConnectionSummary[]` |
| POST | `/api/connections` | `ConnectionInput` | `ConnectionSummary` |
| PUT | `/api/connections/:id` | `ConnectionInput` (secret fields optional → keep stored) | `ConnectionSummary` |
| DELETE | `/api/connections/:id` | – | `{deleted:true}` |
| POST | `/api/connections/:id/test` | – | `ConnectionTestResult` (calls `GET /assets/root`) |

Auth modes:

- `client_credentials` — OAuth 2.0 client credentials (Insights Hub *service
  credentials*): `POST tokenUrl` with `Authorization: Basic base64(id:secret)`
  and form body `grant_type=client_credentials`. Typical token URL:
  `https://<tenant>.piam.<region>.mindsphere.io/oauth/token`.
- `app_credentials` — Token Management Service (application credentials):
  `POST tokenUrl` (typically
  `https://gateway.<region>.mindsphere.io/api/technicaltokenmanager/v3/oauth/token`)
  with header `X-SPACE-AUTH-KEY: Basic base64(id:secret)` and JSON body
  `{"appName","appVersion","hostTenant","userTenant"}`.
- `bearer` — a pasted access token (no refresh; for short-lived testing).
- `simulator` — an in-process Asset Management v3 simulator (see below); no
  network, no credentials. Clearly labelled in the UI as *not a real tenant*.

Tokens are cached per connection until `expires_in - 60s`; an upstream `401`
triggers one token refresh and one retry.

URL safety (SSRF): `apiBaseUrl` and `tokenUrl` must be `https:` and their host
must end with one of `APP_ALLOWED_HOST_SUFFIXES` (default
`.mindsphere.io,.siemens.app,.siemens.com,.mindsphere-in.cn`); IP literals and
`localhost` are rejected.

## Proxied Asset Management calls

`POST /api/connections/:id/am` with body `AmRequest`:

```json
{ "method": "PATCH", "path": "/assettypes/acme.Pump/variables",
  "ifMatch": 3, "body": {"rpm": {"unit": "1/min"}},
  "contentType": "application/merge-patch+json" }
```

- `path` is relative to the Asset Management v3 base URL and must match the
  **operation allowlist** derived from `docs/reference/assetmanagement-v3.yaml`
  (method + path template, e.g. `PUT /assettypes/{id}`,
  `POST /assets/{id}/move`, `PUT /assets/{id}/location`,
  `GET /model/lock`). Anything else → `400`.
- Multipart file endpoints are not reachable here; use the files endpoints.
- `ifMatch` → `If-Match` header, `ifNoneMatch` → `If-None-Match`.
- Response data `AmResponse`: `{status, etag?, body, attempts, durationMs}`.

Resilience (per upstream call):

- retry with exponential backoff + full jitter (base 500 ms, factor 2, max 5
  retries, cap 20 s) on `429`, `502`, `503`, `504` and network errors; honour
  `Retry-After`. `POST` (non-idempotent) is retried only on `429` and on
  connection errors before a response was received.
- at most 8 concurrent upstream requests per connection (queue beyond);
- caller rate limit: 50 requests/s per user (burst 100) → `429`.

## List all pages

`POST /api/connections/:id/list` with `ListRequest`. Fetches page 0 with
`size=200` (never 2000, per the platform's page-size recommendation), reads
`page.totalPages`, then fetches the remaining pages **concurrently** (4 at a
time) and concatenates `_embedded.<key>`. Pages that still fail after retries
are reported in `partialFailures` (the result is then partial, not an error).
Supports `filter`, `sort`, `exploded`, `basicFieldsOnly`, `includeShared`,
`maxItems`. Resources: `assets`, `assettypes`, `aspecttypes`, `files`,
`asset-variables` (`/assets/{assetId}/variables`), `asset-aspects`.

## Files

Files are moved as base64 inside JSON (max file size 5 MB per the API).

- `POST /api/connections/:id/files` `FileUploadInput` → multipart
  `POST /files` (fields `file`, `name`, `scope`, `description`).
- `PUT /api/connections/:id/files/:fileId` `FileUploadInput & {ifMatch}` →
  multipart `PUT /files/{fileId}` with `If-Match`.
- `GET /api/connections/:id/files/:fileId/content` →
  `AmResponse<{mimeType, contentBase64}>` from `GET /files/{fileId}/file`.

The proxy verifies the content type matches the file extension before upload
(same table as `apps/web/src/domain/mime.ts`).

## Audit log

Every mutating upstream call (PUT/PATCH/POST/DELETE) and every connection
create/update/delete/test is appended to the audit log (SQLite) with user id,
connection, method, path, status, duration and attempts — never bodies or
secrets. The frontend can append app-level actions (deployment started,
batch delete, …).

- `GET /api/audit?connectionId&limit(<=500, default 100)&before(ISO)` →
  `AuditEntry[]` newest first, scoped to the calling user.
- `POST /api/audit` `AuditAppend` → `AuditEntry`.

## Simulator

`simulator` connections are backed by an in-process implementation of the
Asset Management v3 subset used by the app, persisted per connection in the
data dir. It behaves like the spec: integer ETags with `If-Match` → `412` on
mismatch and `If-None-Match: *` on existing → `412`; HAL list responses with
`page` and `_embedded`; default page size 10; filters `eq`/`in`/`startsWith`/
`endsWith`/`contains` on basic fields and `hasType`; a root asset of type
`core.basicenterprise` that cannot be deleted; core asset/aspect types
pre-seeded and read-only; case-insensitive uniqueness; delete of assets with
children, of asset types with children/instances and of aspect types in use is
rejected with `400`; `dataType`/`searchable` immutable, string length only
grows; aspect type variables via `PATCH /aspecttypes/{id}/variables` (add,
update, delete via `null`), asset type variables via
`PATCH /assettypes/{id}/variables` (update only, no name swaps in one request).
