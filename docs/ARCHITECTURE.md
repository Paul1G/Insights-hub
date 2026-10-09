# Asset Model Studio — Architecture

Offline-first designer, validator, documenter and deployer for Insights Hub
(MindSphere) Asset Management v3 models.

```
apps/web/            React 19 + TypeScript + Vite + iX v5 (the studio, works offline)
  src/domain/        Pure TypeScript domain: Zod model, rules, core library,
                     validator, estimator, health, ops, diff, migrate
  src/storage/       Dexie (IndexedDB) database + repositories
  src/state/         Zustand stores: open project (undo/redo, autosave),
                     settings (guardrails, core library), signed-in user
  src/api/           Typed client for the backend proxy + AM v3 resource types
  src/components/    Shared UI: Page, PageHeader, dialogs, IssueList, DiffView, notify
  src/pages/         Routes (see src/routes.tsx)
  src/portability/   JSON export/import, CSV/XLSX tables, documentation generator
  src/deploy/        Deployment planner, dry run, executor, resume, rollback, reports
  src/tenant/        Reading a tenant into a project (backup / copy source), converters
  src/catalog/       Tenant catalog: cached read of a tenant's existing types and assets,
                     import of existing objects into an existing project
  src/online/        Online CRUD helpers for the tenant explorer
backend/             Node 22/24 + Fastify proxy: auth, tokens, CORS-free same-origin
                     API, retries/backoff, concurrency, audit log, simulator
docs/reference/      Official AM v3 OpenAPI spec + documentation extracts (source of truth)
docs/api-contract.md Browser ↔ proxy contract
```

## Key decisions

- **Source of truth** — every API behaviour is taken from
  `docs/reference/assetmanagement-v3.yaml` (v3.19.0) and the extracted
  documentation pages next to it. Nothing is invented; where the docs are
  silent the app is conservative and says so in the UI.
- **Tenant-independent offline model** — entities have local UUIDs, type ids
  are stored as `idSuffix` and composed as `<tenant>.<idSuffix>` at deploy
  time. A per-target *mapping* (Dexie `mappings`) records uid → tenant id and
  deployed names; redeploys therefore update instead of duplicating.
- **Baselines** — once an entity was deployed or imported, `baseline` locks
  immutable fields (variable `dataType`/`searchable`, string length can only
  grow, asset `timezone`/`twinType`, aspect type name/category, type ids,
  instantiable). The validator reports violations; editors offer
  "Delete and recreate" for variables.
- **One project = one document** — the whole project is one JSON document in
  IndexedDB, edited through Immer drafts (`useProjectStore.apply`), which gives
  patch-based undo/redo, atomic autosave and cheap snapshots.
- **Validation is pure and fast** — `ModelIndex` (memoised lookups, cycle-safe
  inheritance resolution) + `validateProject` run on every revision; 10k+
  assets validate in milliseconds.
- **Guardrail profiles** — "recommended" (warnings, adjustable thresholds) or
  "technical" (recommended + Capability Package/P&P technical limits as
  errors that block deployment).
- **Server-side secrets only** — the browser never sees credentials. The proxy
  encrypts connection configs at rest (AES-256-GCM), caches tokens, applies
  retries with exponential backoff, concurrency limits and an audit log.
- **List reads** use `size=200` with concurrent page fetches (platform
  recommendation; never `size=2000`).

- **Existing tenant objects** — a project can be linked to a connection whose
  tenant catalog (all aspect types, asset types and assets, stored in Dexie
  `tenantCatalogs`) resolves `external` type references with their real
  definitions. Imports convert existing objects with baselines and record
  mapping entries flagged `imported`; sync mode never deletes such objects.

## Deployment order

Aspect types → parent asset types → child asset types (topological) → parent
assets → child assets (by hierarchy level) → locations → files → file
assignments. Sync-mode deletions run in reverse order and need an explicit
second confirmation.

## Data model summary (see `src/domain/model.ts`)

- `AspectTypeDef { uid, idSuffix, name, category, description, variables[], baseline? }`
- `AssetTypeDef { uid, idSuffix, name, parent: TypeRef, instantiable, variables[], aspects[{uid,name,aspectType: TypeRef}], fileAssignments[], baseline? }`
- `AssetDef { uid, name, type: TypeRef, parentUid, timezone?, twinType, location?, variables[{name,value}], aspects[{name, variables[]}], fileAssignments[], baseline? }`
  - exactly one root placeholder `uid === "root"` (`core.basicenterprise`) stands for the tenant root.
- `FileDef { uid, name, mimeType, size, sha256, blobId, scope }` (content in Dexie `fileBlobs`)
- `TypeRef = {kind:"project",uid} | {kind:"core",id} | {kind:"external",id}`
