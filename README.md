# Asset Model Studio

Offline-first studio to **design, validate, document and deploy** Siemens
Insights Hub (MindSphere) **Asset Management v3** models: aspect types, asset
types, asset hierarchies, locations and files. Modelling works completely
offline in the browser. A lightweight Node/TypeScript proxy holds the tenant
credentials and talks to real tenants for online CRUD, backups, cross-tenant
copies and deployments.

All API behaviour follows the official specification, kept under
[`docs/reference/`](docs/reference/): the OpenAPI spec `assetmanagement-v3.yaml`
(v3.19.0) and extracts of the documentation pages (modelling guidelines and
limits, basic types, filtering, pagination, rate limits, samples).

## Quick start

**Windows:** see [`WINDOWS.md`](WINDOWS.md) — `windows\install.cmd`, then
`windows\start.cmd`, then open http://localhost:8080.

```bash
# backend proxy (Node 22+/24, port 8080)
cd backend && pnpm install && pnpm build && node dist/server.js

# frontend (Vite dev server on :5173, proxies /api → :8080)
cd apps/web && pnpm install && pnpm dev
```

Open the app, click **Sample project** (the official Wind Farm modelling
example), then go to **Tenants → New connection → Simulated tenant** and
**Deploy** the sample to the simulator. To use a real tenant, create a
connection with service credentials (client credentials) or application
credentials (Token Management Service).

## Features

| Area | What you get |
|---|---|
| **Projects** (offline) | Create, open, clone, rename, delete; autosave to IndexedDB (Dexie); undo/redo (Ctrl+Z / Ctrl+Shift+Z); version snapshots with diff and restore; change log; works without network (service worker for the built app). |
| **Type editors** | Aspect and asset type editors with inline validation; inheritance chain with read-only inherited variables and aspects; immutable fields locked once deployed (`dataType`, `searchable`, ids, category, …) with **Delete and recreate**; string length can only grow; blast-radius warnings before deleting variables, aspects or types. |
| **Hierarchy editor** | Virtualized tree (tested with 10,000+ assets), drag and drop re-parenting, keyboard "Move to…", clone and delete subtree, breadcrumbs (`hierarchyPath`), bulk creation from name templates (`Pump-{n:3}`) or CSV; asset editor for values, location, timezone (Java zone ids, 15/45-minute offsets rejected, create-only), twin type and file assignments. The root asset cannot be deleted. |
| **Guardrails** | Live validation of naming rules (case-insensitive uniqueness, reserved words), references, cycles and limits. Profiles: *Recommended only* (adjustable thresholds) or *Recommended + technical limits* (Capability Package / P&P limits as deploy-blocking errors). |
| **Estimator & health** | Asset attribute estimator (core types and core aspect types not billed, minimum 1 per asset, what-if instance counts) and a Model Health panel with split / flatten / merge / cleanup suggestions. |
| **Core library** | Built-in OOTB types transcribed from the documentation (incl. `core.basicasset`, the recommended no-cost parent); **Sync library from tenant**; read-only, searchable, extend by inheritance. **User libraries**: reusable type collections with checksummed import/export. |
| **Portability** | Self-describing project JSON with SHA-256 checksum, optional embedded files and schema migration; CSV/XLSX round trip for bulk editing in Excel with a preview of every change; documentation generator for **Markdown, HTML and PDF** (hierarchy tree, variable tables, inheritance/usage diagram, change log). |
| **Existing tenant model** | Link a project to a tenant and read **all** its existing aspect types, asset types and assets (paged reads, `size=200`, concurrent; stored locally, available offline). Existing types appear in the editors' pickers (parents, aspects, types of new assets) and are validated and estimated with their real definitions. The **Tenant model** page shows which objects the project already contains and imports any selection (with parent types, aspect types, ancestors and optional subtrees) as editable definitions that keep their tenant ids. The Library's **Tenant types** tab browses any tenant. |
| **Tenants** (online) | Connection management per environment (secrets encrypted at rest, write-only); tenant explorer with full CRUD on aspect types, asset types, assets (lazy tree), locations and files; ETag / `If-Match` on every change with a diff dialog on `412`; impact analysis before deletes; batch operations with preview; audit log. |
| **Deployment** | Dependency-ordered planner (aspect types → parent → child asset types → parent → child assets → locations → files → file assignments), **dry run** with request previews and target diff, sync mode with typed confirmation for physical deletes, idempotent redeploys via uid → tenant-id mappings, resume after reload, conflict handling, best-effort rollback, timed JSON/Markdown reports. |
| **Copy & backup** | Backup a whole tenant into a project (paged reads with `size=200`, concurrently); cross-tenant copy wizard (source → selection → target & mapping → dry run → deploy) with conflict renaming and core-type checks. |

## Architecture

```
apps/web/      React 19 + TypeScript + Vite + iX v5, Zod, Dexie, Immer, Zustand
  src/domain/     model (Zod), rules, core library, validator, estimator, health, ops, diff, migrate
  src/storage/    IndexedDB schema + repositories
  src/state/      project store (undo/redo, autosave), settings, signed-in user
  src/api/        typed client for the proxy + AM v3 resource types
  src/deploy/     planner, executor, rollback, reports
  src/tenant/     tenant reader, converters, copy helpers
  src/catalog/    tenant catalog (cached read of existing types/assets), import into projects
  src/online/     ETag-aware online CRUD, impact analysis, batch runner
  src/portability/ project JSON, CSV/XLSX, documentation generator
backend/       Node + Fastify proxy (hexagonal): auth/tokens, allowlisted AM proxy,
               retries with backoff, concurrency/rate limits, paging, files, audit, simulator
docs/          architecture, API contract, official reference material
```

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), browser↔proxy
contract: [`docs/api-contract.md`](docs/api-contract.md), backend:
[`backend/README.md`](backend/README.md).

## Security

- Credentials never reach the browser. The proxy stores each connection
  encrypted with AES-256-GCM (`APP_ENCRYPTION_KEY`, or a generated key file in
  the data directory), never logs or returns secrets, and never writes them to
  the audit log or exports.
- Only allowlisted Asset Management v3 operations (derived from the OpenAPI
  spec) are proxied; URLs must be HTTPS hosts on the allowed suffixes (SSRF
  guard).
- Identity comes from the platform's trusted `X-Forwarded-User` headers;
  connections and audit entries are scoped per user.
- Project exports contain no mappings, connection ids, tokens or user ids.

## Testing

```bash
cd apps/web && pnpm test        # Vitest in browser mode (real Chromium): domain, editors, portability, deploy, online
cd apps/web && pnpm e2e         # Playwright smoke tests (needs `pnpm --dir ../../backend build`)
cd backend  && pnpm test        # Vitest: proxy, retries, tokens, encryption, paging, SSRF, simulator
```

## Interpretations where the documentation is silent

- **Inheritance depth** (technical limit 5) counts inheritance steps below
  `core.basicasset`. **Hierarchy depth** (limit 20) counts levels including the
  tenant root. The UI states both rules.
- **Sibling asset names** must be unique (case-insensitive) in a project,
  because deployments match existing assets by parent and name.
- The **parent type** of a deployed asset type is treated as fixed (the
  documentation lists only name, description, variables and aspects as
  updatable).
- **Content type ↔ extension** checks use the standard IANA types per
  extension; the platform does not publish its exact table.
- The **simulator** is a test double of the documented behaviour, not a
  substitute for verifying against a real tenant.
