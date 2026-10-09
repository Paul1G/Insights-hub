# asset-model-studio-backend

Backend proxy of **Asset Model Studio**. The browser never talks to Insights
Hub directly: this Fastify v5 / TypeScript service holds tenant connections
(encrypted at rest), obtains and caches tokens, forwards an allowlisted subset
of the **Asset Management v3** API with retries, backoff and concurrency
limits, records an audit log, and ships an in-process **AM v3 simulator** for
working without a real tenant.

- Browser ↔ proxy contract: [`../docs/api-contract.md`](../docs/api-contract.md);
  the normative request/response types are in
  [`../apps/web/src/api/client.ts`](../apps/web/src/api/client.ts).
- Upstream source of truth:
  [`../docs/reference/assetmanagement-v3.yaml`](../docs/reference/assetmanagement-v3.yaml)
  (v3.19.0) plus the extracted documentation pages next to it.

---

## Run, test, build

```sh
pnpm install
pnpm dev          # tsx watch, pretty logs, :8080
pnpm test         # vitest (134 tests)
pnpm typecheck    # sources + tests
pnpm lint
pnpm build        # tsc → dist/server.js
pnpm start        # node dist/server.js
```

Preview contract: the platform runs `pnpm install --frozen-lockfile`,
`pnpm run build`, `pnpm prune --prod` and `node dist/server.js` (Node 24;
Node 22.23 works locally — `node:sqlite` needs no flag). nginx routes
`/api/*` from :3000 to this service on :8080; readiness probe `GET /healthz`.

---

## Endpoints

Envelope: success `200 {"data": …}`, failure `{"error": "…"}`. Proxy-level
failures only: `400` invalid request / not allowlisted, `404` unknown
connection or route, `413` body too large, `429` caller rate limit, `502`
token endpoint or network failure. **Upstream statuses are never mapped onto
the outer status**: proxied calls return `200 {"data": AmResponse}` with the
real upstream `status` (e.g. 412) inside.

| Method | Path | Body → data |
|---|---|---|
| GET | `/api/me` | – → `Me` |
| GET | `/api/connections` | – → `ConnectionSummary[]` |
| POST | `/api/connections` | `ConnectionInput` → `ConnectionSummary` |
| PUT | `/api/connections/:id` | `ConnectionInput` (secrets optional = keep) → `ConnectionSummary` |
| DELETE | `/api/connections/:id` | – → `{deleted: true}` |
| POST | `/api/connections/:id/test` | – → `ConnectionTestResult` (`GET /assets/root`) |
| POST | `/api/connections/:id/am` | `AmRequest` → `AmResponse` |
| POST | `/api/connections/:id/list` | `ListRequest` → `ListResult` |
| POST | `/api/connections/:id/files` | `FileUploadInput` → `AmResponse<file metadata>` |
| PUT | `/api/connections/:id/files/:fileId` | `FileUploadInput & {ifMatch}` → `AmResponse` |
| GET | `/api/connections/:id/files/:fileId/content` | – → `AmResponse<{mimeType, contentBase64}>` |
| GET | `/api/audit?connectionId&limit&before` | – → `AuditEntry[]` (newest first, limit ≤ 500, default 100) |
| POST | `/api/audit` | `AuditAppend` → `AuditEntry` |
| GET | `/healthz` | `{"status":"ok"}` (no envelope) |
| GET | `/readyz` | DB ping, 200 / 503 |
| GET | `/metrics` | Prometheus |

### Proxied Asset Management calls (`/am`)

`AmRequest {method, path, query?, ifMatch?, ifNoneMatch?, body?, contentType?}`.
`path` must match the operation allowlist in
[`src/domain/am/allowlist.ts`](src/domain/am/allowlist.ts), derived from the
spec's `paths` (method + template). Path parameters are validated against the
spec patterns (`TypeId`, `uniqueId`, `fileKey`, `fileId`) and the forwarded
path is rebuilt from validated segments; query parameters must be ones the
spec declares for that operation. Not reachable through `/am`: multipart
`POST /files`, `PUT /files/{fileId}` and binary `GET /files/{fileId}/file` —
use the files endpoints. Bodies are sent as `application/json`, or
`application/merge-patch+json` for PATCH unless `contentType` says otherwise.

### Resilience (per upstream call)

- Exponential backoff with full jitter: `random(0, min(20 s, 500 ms · 2^n))`,
  at most 5 retries, on `429`, `502`, `503`, `504` and network errors.
  `Retry-After` (seconds or HTTP date) replaces the jittered delay, capped at
  20 s.
- `POST` is retried only on `429` and on connection failures that provably
  happened before the request reached the server (DNS, refused, connect
  timeout).
- At most 8 concurrent upstream requests per connection; more queue (FIFO).
- Tokens are cached until `expires_in − 60 s`; an upstream `401` drops the
  token and retries once.
- Per-user incoming rate limit: token bucket 50 req/s, burst 100 → `429`.

### Listing (`/list`)

Page 0 with `size=200` (never 2000), then the remaining `page.totalPages`
concurrently, 4 at a time, concatenating `_embedded.<assets|assetTypes|
aspectTypes|files|variables|aspects>` in page order. `maxItems` limits the
pages fetched. Pages that still fail are listed in `partialFailures`
(`status` 0 = network). An HTTP error on page 0 yields an empty result with
that page in `partialFailures`; a network/token failure on page 0 is a `502`.
Flags the spec does not declare for a resource are not forwarded.

---

## Security model

- **Identity**: `X-Forwarded-User` (scope key), `X-Forwarded-Email`,
  `X-Forwarded-Preferred-Username` are set by the platform's OAuth proxy and
  trusted. Without `X-Forwarded-User` the scope is `anonymous`. Connections
  and audit entries are strictly scoped; another user's connection id is a
  `404`.
- **Secrets at rest**: the whole connection config (name, URLs, client id and
  secret, token, last test) is AES-256-GCM encrypted in SQLite, with
  `connection:<id>:<userId>` as additional authenticated data so rows cannot
  be swapped between users. Key: `APP_ENCRYPTION_KEY` (base64, 32 bytes) or a
  key generated once into `$APPLICATION_DATA_DIR/secret.key` (mode 0600).
- **Write-only secrets**: `clientSecret` / `token` are never returned; omitted
  on update means "keep". Summaries show a masked client id (`abcd…wxyz`).
- **No secrets in logs or audit**: request bodies are never logged; the logger
  redacts credential fields; audit entries hold method, path, status,
  duration and attempts only. App-supplied audit `details` are stripped of
  credential-looking keys.
- **SSRF guard** (on save and again before every use): `apiBaseUrl` and
  `tokenUrl` must be `https`, default port, no credentials/query/fragment,
  host ending with one of `APP_ALLOWED_HOST_SUFFIXES`; IP literals and
  `localhost` are rejected; redirects are never followed.
- **Limits**: request bodies ≤ 10 MB (`413`), files ≤ 5 MB with content type
  matching the extension (table shared with
  `apps/web/src/domain/mime.ts`).

---

## Simulator (`auth.mode = "simulator"`)

An in-process implementation of the AM v3 subset the studio uses, persisted
per connection in `$APPLICATION_DATA_DIR/simulator/<connectionId>/`
(`state.json` written atomically and coalesced, file contents in `files/`).
It is deleted with its connection. Behaviour follows the spec and docs:

- HAL lists with `_embedded`, `page {size,totalElements,totalPages,number}`
  and `_links`; default page size 10 (max 2000); `sort=field[,asc|desc]`,
  default name ascending.
- Filters per `filtering.txt`: `eq` (also the plain form), `in`,
  `startsWith`, `endsWith`, `contains`, `before`, `after`, `between`,
  field-level `or`/`and`/`not`, top-level `and`/`or`/`not`, `hasType`
  (type and descendants), `fileId` on assets; unknown fields are ignored.
- Integer etags in bodies and `ETag` headers (0 on creation, +1 per change);
  `If-Match` mismatch → `412`; mandatory `If-Match` missing → `400`;
  `If-None-Match: *` on an existing type → `412`; matching `If-None-Match` on
  GET → `304`.
- Seeded read-only core types (`docs/reference/basic-types.txt`); `core.*`
  cannot be modified or deleted; a root asset of `core.basicenterprise`
  named after the tenant, which cannot be deleted or moved.
- Type ids must start with the connection's tenant; ids and names are
  case-insensitive and unique.
- Aspect types: PUT create/update with restricted updates (no removal, no
  `dataType`/`searchable`/`qualityCode` change, static STRING length only
  grows, dynamic STRING length fixed, name/category fixed), PATCH (merge
  patch), DELETE only if unused, `PATCH …/variables` add/update/rename/delete
  (`null`) with unique names.
- Asset types: PUT/PATCH with variables matched by name and aspects by
  `aspectId` (generated on creation), names unique in the type family,
  `parentTypeId` fixed, instantiable cannot be revoked, BIG_STRING rejected;
  `exploded=true` adds inherited variables/aspects with `_links.origin`;
  `PATCH …/variables` updates name/unit/length/defaultValue only (no
  `dataType`/`searchable` change, no length decrease, no deletes, no name
  interchange within one request, inherited variables rejected) → `204` +
  `ETag`; file assignments PUT/DELETE; DELETE only without child types and
  instances. Removing/renaming variables and aspects is propagated to asset
  values.
- Assets: POST needs an instantiable, non-root-hierarchy type and an existing
  parent; `timezone` defaults to `Europe/Berlin` (15/45-minute zones
  rejected), `twinType` to `performance`; PUT/PATCH modify values only
  (variables and static aspect values must exist on the type and match their
  data type); DELETE rejected with children; move (not into the own subtree);
  location PUT/DELETE (`409` without own location; inherited locations are
  shown); file assignments; `hierarchyPath`; `/variables` and `/aspects`
  lists; `basicFieldsOnly`.
- Files: multipart upload/replace (5 MB, extension vs content type), metadata,
  download, delete blocked while assigned.
- `GET/PUT /model/lock`; while enabled, asset/aspect type updates and deletes
  are rejected with `400`.
- Errors use the spec's `{"errors": [{"code","message","logref"}]}` shape.
- `APP_SIMULATOR_LATENCY_MS` adds artificial latency (off by default).

Interpretations where the documentation is silent are listed in
[Simulator interpretations](#simulator-interpretations).

### Simulator interpretations

- Mandatory `If-Match` missing → `400`; core / locked / tenant-prefix
  violations → `400`.
- New resources start at etag 0 (documented for assets, applied to all).
- Asset `variables`/`aspects` show explicitly set values plus type defaults;
  static aspects without any value are omitted (as in the modelling samples).
- Sibling asset names and file names are not forced to be unique (not stated
  in the spec); the studio's own validator enforces sibling uniqueness.
- String filters compare case-sensitively; `hasType` resolves type ids
  case-insensitively.

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `APP_ADDR` | `:8080` | Listen address |
| `APPLICATION_DATA_DIR` | `./data` | Persistent dir (DB, `secret.key`, simulator) — set by the preview runtime |
| `APP_DB_PATH` | `$APPLICATION_DATA_DIR/app.db` | SQLite file (`:memory:` for tests) |
| `APP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `APP_ENV` | `prod` | `dev` = pino-pretty, else JSON |
| `APP_ENCRYPTION_KEY` | – | base64 32-byte AES key; else generated `secret.key` |
| `APP_ALLOWED_HOST_SUFFIXES` | `.mindsphere.io,.siemens.app,.siemens.com,.mindsphere-in.cn` | SSRF allowlist |
| `APP_BODY_LIMIT_BYTES` | `10485760` | Max request body |
| `APP_UPSTREAM_TIMEOUT_MS` | `30000` | Per-attempt upstream timeout |
| `APP_UPSTREAM_CONCURRENCY` | `8` | Concurrent upstream requests per connection |
| `APP_RATE_LIMIT_PER_SEC` / `APP_RATE_LIMIT_BURST` | `50` / `100` | Per-user rate limit |
| `APP_SIMULATOR_LATENCY_MS` | `0` | Simulator latency |
| `APP_STATIC_DIR` | – | Serve the built frontend (`apps/web/dist`) on `/` for local installs without a reverse proxy (see `WINDOWS.md`); unset = API only |

SQLite runs with `journal_mode=DELETE`, `locking_mode=EXCLUSIVE`,
`mmap_size=0` (Azure Files / CIFS safe; one writer pod).

---

## Architecture (hexagonal)

```
src/domain/                     pure domain, no infra imports
  identity.ts errors.ts
  connection/  connection.ts (types, summary, masking) url-guard.ts
               repository.ts (port) endpoint-factory.ts (port)
  upstream/    transport.ts (UpstreamTransport, TokenProvider ports)
  am/          allowlist.ts (operations from the OpenAPI spec)
  audit/       audit.ts (types, AuditRepository port, redaction)
  files/       mime.ts (extension ↔ content type)
src/app/service/                business logic on ports
  connections.ts am-proxy.ts lister.ts files.ts audit.ts
  upstream-client.ts (retry/backoff/limit/401 refresh) connection-runtime.ts
src/app/http/                   Fastify: server, envelope, schemas, routes, ops
src/adapter/
  sqlite/      db.ts connection-repo.ts audit-repo.ts schema.ts
  crypto/      cipher.ts (AES-256-GCM, key loading)
  http/        fetch-transport.ts token-providers.ts
  simulator/   tenant.ts handlers (aspect-types, asset-types, assets, files)
               query.ts rules.ts store.ts simulator.ts registry.ts core-library.ts
  endpoint-factory.ts           connection → transport + tokens
src/platform/                   clock, semaphore, rate limiter, metrics
src/wiring.ts                   composition root (also used by tests)
src/server.ts                   entrypoint, graceful shutdown
```

Dependency direction: `server/wiring → adapter → app → domain`. Tests inject
`fetch`, clock, sleep and random (`WiringOverrides`) and fake transports at
the port boundary.

### Extending

- **New proxied operation**: add it to `OPERATIONS` in
  `src/domain/am/allowlist.ts` only if it exists in the spec; add simulator
  support in `src/adapter/simulator/simulator.ts` (`ROUTES`) and a handler.
- **New table**: idempotent DDL in `drizzle/0001_init.sql` (applied at
  startup), Drizzle view in `src/adapter/sqlite/schema.ts`, a repository
  implementing a domain port.
- **New route**: register it in `src/app/http/api-routes.ts`, validate with a
  Zod schema in `schemas.ts`, answer with `sendData`, throw typed errors.
