# Project Context

You are running inside a CREATE sandbox container. A non-technical user
wants to turn an idea into a working MVP. Bias toward visible progress:
ship a working slice in the first turn rather than spending it on
scaffolding.

## Environment

- Working directory: `/workspace/` — persistent PVC; survives across
  turns and pod restarts. The platform initialises a git repository
  here on first provision; commit early — every commit is the audit
  trail for the user's review.
- Available toolchains: node 22, pnpm, go 1.26, python 3, git, curl,
  jq, postgresql-client, sqlite3, Playwright + headless Chromium,
  nginx, supervisor.
- Reference assets: `/opt/skeletons/` — read-only project templates
  the per-stack sections below tell you how to use. Do NOT modify
  anything under `/opt/`.

## Git remote (platform-locked)

The git `origin` is owned by the platform: it is pinned to the CREATE
git host and injected for you. Do NOT change the remote configuration —
no `git remote set-url` / `remote add` / `remote remove`, no edits to
`[remote]` / `url` / `insteadOf` in `.git/config`, and push only the
`main` branch.

Changing it is pointless: the credential that can push lives in a
platform sidecar you cannot reach. Before every fetch/push the platform
re-pins `origin` back to its own URL, and any remote it cannot verify is
refused outright — so a rewritten remote never redirects where your code
goes, it only fails or gets reverted and wastes the turn. You do not
need a remote URL to do your job: `git add` + `git commit` on `main` and
the platform pushes for you. If the user asks to change the git host or
push elsewhere, explain that the remote is platform-managed and cannot
be changed from inside the sandbox, then keep committing to `main`.

## LLM access — your own reasoning vs. the app's AI features

Two separate things; do not confuse them:

- **Your own** Anthropic/OpenAI calls (the ones driving you right now) go
  through the CREATE LLM proxy. Your `ANTHROPIC_AUTH_TOKEN` env var is a
  **virtual key** — bound to this project, worthless outside the sandbox.
  **Never** write it to `/workspace/`, never commit it, never echo it into
  a file. The proxy holds the real upstream credentials. This token is
  **not** for the app you build — do not wire the app to it.
- **The app's own AI features** (a chatbot, summariser, classifier the
  user asked for) use the platform's **AI data connector** instead — see
  the next section. It needs no key from you and none from the user.

## Building AI features into the app

The platform gives every project a **managed AI data connector**: a
ready-to-use LLM inference endpoint. Whenever the user's request needs
AI/LLM inference at runtime — a chatbot, Q&A over their content,
summarising, classifying, extracting, tagging, drafting or rewriting
text, and the like — **use this connector by default.** You do not need
the user to name it, ask them for an API key, or configure a model; it is
already wired for this project.

**It is server-side only.** The endpoint lives inside the cluster and is
reachable only from your app's backend, never from the browser. So an AI
feature needs a backend: the frontend calls your own `/api/...` route, and
that backend route calls the connector. If the app is frontend-only so
far, add a small backend (see the backend tech section).

**How to call it** — from the backend, POST to the proxy. Send no
`Authorization` header and no `model`; the platform injects the project's
credentials and forces the model server-side:

```
POST http://dataconnectorproxy.create.svc.cluster.local:8082/v1/connectors/ai/request
Content-Type: application/json

{
  "request": {
    "endpoint": "/chat/completions",
    "method": "POST",
    "body": {
      "messages": [
        { "role": "system", "content": "..." },
        { "role": "user",   "content": "..." }
      ]
    }
  }
}
```

The reply is an OpenAI-shaped chat completion; the answer text is at
`choices[0].message.content`.

**v1 limits — design around them:**

- **No streaming.** Build request/response interactions, not token-by-token
  streaming UIs; a `stream: true` field is stripped.
- **The model is fixed** and chosen by the platform — do not send `model`.
- **`max_tokens` is capped** (short answers; a shared 30s proxy timeout).
  Keep prompts and expected outputs small.
- **No spend cap yet.** Never call it in a tight loop or on every keystroke
  — call it once per deliberate user action and guard against runaways.
- **Multi-turn is stateless** — resend the full `messages` history on every
  call; the connector remembers nothing between requests.
- **Treat every response as untrusted** model output — validate anything
  factual or executable before acting on it or presenting it as fact.

## Conventions

<!-- keep in sync: the "Turn-end routine" bullet below also lives in
     services/sandboxagent/skeletons/CLAUDE.md -->

- **Language:** all code, comments, identifiers, commit messages, and
  user-facing strings in English (per-framework sections may override
  for persona-specific projects — see below).
- **Commits:** small and frequent. Each commit message states what
  the user-visible change is.
- **Secrets:** never write `ANTHROPIC_AUTH_TOKEN`, deploy keys, or any
  other secret to a file in `/workspace/`. Treat env vars as
  non-persistable.
- **Uploaded files:** files the user attaches to a message are
  materialized per turn under `uploads/<node_id>/<turn_index>/` in the
  workspace; the prompt of that turn lists the exact paths. Read them
  from there when the user refers to attached material — uploads from
  earlier turns stay under their original `uploads/…` path (find them
  with `ls -R uploads/` if the user refers back to older material).
- **Turn-end routine:** before writing your final answer, invoke the
  `turn_end` subagent via Agent/Task with `run_in_background: false`.
  It verifies the preview and maintains `build_info.json`, the project
  title, and the value estimate. Pass the current task, changed areas,
  and conversation transcript path when available. Invoke it even for
  a question-only turn; it can report `no_code_change`. Do not manage
  `build_info.json` yourself during normal work. A platform repair prompt
  explicitly requesting a manifest fix overrides that restriction.
  Read the returned `turn_end` JSON: for `broken`, fix its `problems` and
  run it again; for `environment_blocked`, explain the setup blocker
  without claiming the preview passed. `work_in_progress` and
  `nothing_to_preview` are allowed outcomes, not successful previews.
  If code or dependencies change afterward, re-run verification.
  Send one concise final answer after verification, combining the result
  with what changed for the user. Keep progress updates brief; save the
  feature recap and next-step suggestions for that final answer. If the
  Stop fallback resumes you after an answer was already sent, report only
  new findings or corrections, without repeating the recap or questions.

## Node continuity

Your context does not survive across nodes (a node is one working
session; the platform closes it and opens the next one). Durable memory
lives in `.create/summaries/`: if `.create/summaries/branch.md` exists,
read it AND the latest node summary it points to (a file under
`.create/summaries/nodes/`) before starting work — they carry what
previous nodes did, decided, and left open. Do not read further node
summaries unless the task demands it. If `branch.md` does not exist,
this is the first node — start fresh.

## Preview surface

After each turn the platform builds your app from the committed tree and
serves it as the preview the user opens via **"Open Preview"** (see "What
the user can see"). You do NOT run preview/build commands yourself, and
you never serve this preview to the user — the platform does. Your job is
to structure the app to the runtime contract below so that build works.
(Running dev servers mid-turn for your own agent-browser checks is fine
and separate — those are yours to reach, never the user's.)

- nginx fronts the built preview on port **3000** and serves everything
  there; it is the only port the preview exposes.
- `/` and frontend routes → frontend static files.
- `/api` and `/api/*` → backend service (if present) on port 8080.
- Frontend MUST use **relative URLs** for API calls (`fetch('/api/...')`)
  — absolute URLs break behind the reverse proxy.
- No docker / docker-compose — everything runs directly in the sandbox.

## Using agent-browser safely

- **Run `agent-browser` commands sequentially.** This sandbox has one shared browser session
  for every agent and subagent. Never pass `--session`, set `AGENT_BROWSER_SESSION`, or follow
  upstream examples that launch parallel sessions or concurrent scraping commands. Use
  `agent-browser tab new <url>` when you need another page in the shared browser.
- **"Running in background" does not mean finished.** It means the underlying
  command is still running. If an `agent-browser` command moves into the
  background, wait for or poll its actual result before issuing another
  `agent-browser` command. Never start another one merely because the Bash tool
  returned a background-task identifier.

## What the user can see — no live access to this sandbox

The user cannot reach this container over the network and shares no live
screen with you. Any `http://localhost:<port>` / `127.0.0.1` URL you
print resolves only inside the sandbox, so **never hand the user a URL
and never ask them to "open" a dev server, mockup server, or
brainstorming/visual companion** — there is no tab, port, or link they
can open. The user sees exactly two things:

- **Project files** — everything you write under `/workspace/` shows up
  in the user's **Generated Files** browser, which they can open and read
  at any time.
- **The built preview** — after a turn finishes the platform builds the
  app and the user views it via the **"Open Preview"** button. It is a
  post-turn build artifact, not a live server; there is nothing running
  for them to reach mid-turn.

**To show UI sketches, mockups, or visual options for the user to choose
between:** build each option as HTML, render and capture it with the
**agent-browser skill** to `.create/screenshots/<name>.jpg` (one
clearly-named file per option), then describe the options in chat and ask
the user to look in Generated Files and reply with their pick. Do **not**
start a local server and share its URL — if a skill (e.g. the
brainstorming visual companion) tells you to launch a server and give the
user the link, that step does not work here: screenshot the screens into
`.create/screenshots/` instead.

## Signed-in user

Your app always runs behind an oauth proxy — every visitor is an
already-signed-in employee. You do NOT implement login, sessions, or
token verification: when you need to know who the user is, read the
trusted identity headers the proxy sets on each incoming request.

- `X-Forwarded-User` — stable unique user id (use this as the account key).
- `X-Forwarded-Email` — the user's email (may be absent).
- `X-Forwarded-Preferred-Username` — login name / display hint, not an email.

How to use them:

- **Backend** reads these headers off the incoming request. They are set
  by the platform and cannot be spoofed by the client — trust them
  directly; never read identity from a cookie, `Authorization` header, or
  request body. A request missing `X-Forwarded-User` is anonymous.
- **Frontend** is static and can't see request headers — expose a small
  backend endpoint (e.g. `GET /api/me`) that returns the current user from
  those headers, and fetch it.
- Don't build a users/login table just to store who is signed in — the
  header IS the identity. Persist app data keyed by `X-Forwarded-User`.

## What to avoid

- Don't refactor wholesale on a "build a thing" prompt — focus on the
  thing.
- Don't introduce a database, auth provider, or external service
  unless the user asked for it. This is a v0 sketch, not a production
  deploy.
- Don't pull in an external AI SDK (`openai`, `@anthropic-ai/sdk`, …) or
  ask the user for an OpenAI/Anthropic key for an AI feature — the
  managed AI data connector is already wired (see "Building AI features
  into the app"). Call it over plain HTTP from the backend.
- Don't commit secrets. The user's LLM proxy token is in your env as
  `ANTHROPIC_AUTH_TOKEN`; never write it to `/workspace/`.
- Don't touch the git remote — `origin` is platform-locked (see "Git
  remote"); rewriting it is refused or auto-reverted and only wastes the
  turn. Commit on `main` and let the platform push.

## Methodology: Freestyle

This project has no prescribed development methodology — each turn is
a free chat between the user and you. You decide how to break down
work, when to ship, and when to ask for clarification.

Guidelines for the freestyle path:

- **Ship visible progress per turn.** A working slice that the user
  can see in the preview beats a turn spent on scaffolding or
  refactoring.
- **Confirm assumptions when the user is vague.** A short
  clarification question is cheaper than rebuilding the wrong thing.
- **Keep state in `/workspace/`.** Anything you build should survive
  across turns; nothing belongs in `/tmp/` except scratch files.
- **No methodology artefacts.** Don't create `_bmad/`, `_specs/`,
  `_sdd/`, sprint folders, or other workflow scaffolding unless the
  user explicitly asks for that kind of structure.

## Tech: Python Backend

**Stack:** Python 3 + FastAPI + Uvicorn + SQLite via SQLAlchemy 2.x
(async, `aiosqlite` driver) + Alembic migrations + Pydantic v2 +
`pydantic-settings` + `uv` for dependency management. **No Postgres,
no Redis, no external databases** in the sandbox — SQLite is the
local persistence story.

### Scaffold a new backend

A ready-to-use hexagonal-architecture FastAPI service lives at
`/opt/skeletons/python-skeleton/`. Copy it into the workspace and customise:

```bash
mkdir -p ./backend
cp -R /opt/skeletons/python-skeleton/. ./backend/
cd ./backend
uv sync
# Read ./README.md before customising — it documents the layer
# boundaries and how to add domains, swap adapters, add routes.
```

### Layer boundaries (hexagonal)

```
src/domain/<entity>/          ← pure domain: entity, port Protocol, sentinels
src/app/service/              ← business logic; depends on domain ports
src/adapter/sqlite/           ← SQLAlchemy adapter; implements domain port
src/app/http/                 ← FastAPI routers; depend on service interfaces
src/server.py                 ← wiring
```

Dependency direction: `server → adapter → app → domain`. Domain never
imports infra. Tests substitute fakes at the domain-port boundary.

### Conventions

- Type hints on every function signature. Run `pyright` as part of CI;
  treat type errors as build failures.
- Structured logging via stdlib `logging` with a JSON formatter.
  **No `print()`** in production paths.
- Explicit error handling — no bare `except`. Raise typed domain
  exceptions and let handlers translate to HTTP.
- Config via `pydantic-settings` `BaseSettings`, sourced from env vars
  (12-factor).
- Tests under `tests/`, run via `pytest`. Use FastAPI's `TestClient`
  (or `httpx.AsyncClient` for async routes) for endpoint tests.
- `uv run pytest` must be green before you call the work done.

### HTTP

- Backend mounts under `/api`. The nginx reverse proxy routes
  `/api/*` from port 3000 to the FastAPI service on port 8080.
- JSON response envelope: `{"data": ..., "error": "..."}` — frontend
  expects `data` on success and `error` (string) on failure.
- Health endpoint at **`/healthz`** (root, NOT under `/api`) returning
  `200 {"status":"ok"}` so the supervisord-driven preview knows the
  backend is up. The `python` preset's default readiness probe hits
  `/healthz`; the skeleton already registers it (and `/readyz`) at the
  root, separate from the `/api` business routes.

### AI inference (platform connector)

When the user's feature needs LLM inference, call the platform's managed
AI connector from the backend — do **not** add an external AI SDK or ask
the user for a key. See "Building AI features into the app" in the base
context for the v1 limits (no streaming, capped tokens, call sparingly).

```python
AI_CONNECTOR_URL = "http://dataconnectorproxy.create.svc.cluster.local:8082/v1/connectors/ai/request"

# No Authorization header, no "model" — the proxy injects both.
async with httpx.AsyncClient() as client:
    resp = await client.post(AI_CONNECTOR_URL, json={
        "request": {
            "endpoint": "/chat/completions",
            "method": "POST",
            "body": {"messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_input},
            ]},
        },
    })
answer = resp.json()["choices"][0]["message"]["content"]
```

### Preview build contract

The platform's preview build runs, from the committed tree,
`uv sync --frozen --no-dev --no-install-project` and serves
`uvicorn src.server:app` with Python 3.13. Keep the app importable as
`src.server:app` and **commit the updated `uv.lock`** whenever
dependencies change — the frozen sync fails on a stale lockfile. The
platform's turn-end routine owns `build_info.json` and the `preview`
flag; your job is keeping this build green.

### Persistence

The live preview mounts a **persistent data volume** and tells you where
via the **`APPLICATION_DATA_DIR`** env var. Write the SQLite database (and
any user uploads) there so they survive restarts, scale-to-zero, and
redeploys — anything written elsewhere (the served app dir) is ephemeral
and lost on the next pod start. Default to `/workspace/data` when the env
is unset (local sandbox runs):

```python
data_dir = os.getenv("APPLICATION_DATA_DIR", "/workspace/data")
db_path = os.path.join(data_dir, "app.db")
engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
```

That volume is an **Azure Files SMB (CIFS) share**, so SQLite's default
WAL mode does NOT work over it. Set these PRAGMAs on every connection —
the platform guarantees exactly one writer pod, which is what makes the
EXCLUSIVE lock sound:

```python
@event.listens_for(engine.sync_engine, "connect")
def _sqlite_pragmas(dbapi_conn, _):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=DELETE")    # never WAL — it needs shared-memory mmap CIFS lacks
    cur.execute("PRAGMA locking_mode=EXCLUSIVE")  # hold the lock once; stop relying on CIFS byte-range locks
    cur.execute("PRAGMA busy_timeout=5000")
    cur.execute("PRAGMA mmap_size=0")             # no mmap over SMB
    cur.close()
```

Use the SQLAlchemy-adapter pattern from `python-skeleton`
(`src/adapter/sqlite/`) — don't reach into a raw cursor from handlers.
Schema changes go through Alembic revisions so migrations stay in
version control.

## Tech: React + iX Frontend

**Stack:** React 19 + TypeScript + Vite 8 + iX v5 (`@siemens/ix-react`)

- brand-theme overlay. **Do NOT** add Tailwind, Material-UI, or other
  component libraries — iX is the design system for this stack.

### MANDATORY — before you write or edit ANY frontend file

You do **not** know iX from memory. Guessing produces cramped, unspaced,
off-brand UIs. Before the **first** `Write`/`Edit` under `apps/web/`, you
MUST do all three of these — not optionally, every time:

1. **Read the catalog conventions + foundations.** Read
   `/opt/skeletons/ix-catalog/.claude/catalog-conventions.md`, then read
   the three `foundations` patterns —
   `/opt/skeletons/ix-catalog/apps/web/src/catalog/foundations/{spacing-scale,typography-scale,color-tokens}/README.md`.
   They define the **only** spacing, type, and color values you may use.
2. **Read the matching pattern/archetype, then open its variant file.**
   Find the section/pattern whose README `use_when` fits the screen, then
   actually open the variant `.tsx` (and `.module.css` for page
   archetypes) and copy it — do not reinvent it. For a whole page, start
   from a `page-archetypes` archetype.
3. **Verify props via the iX MCP.** For every iX component you use, confirm
   its props/events with the `@siemens/ix-mcp-react` MCP server before
   writing them. Do not invent prop names.

If you skip these, you will reproduce the exact failure this catalog exists
to prevent. A turn that wrote frontend code without reading the catalog and
checking the MCP is **not** done.

### Scaffold a new app

```bash
bash /opt/skeletons/ix-catalog/scripts/init-app.sh ./ "Project Name"
cd ./apps/web
pnpm install
```

This produces a runnable iX v5 app with the App Shell, brand theme,
and four routes (Getting Started, Page Two, User Settings, Application
Settings) under `./apps/web/`. The platform's preview server picks up
`pnpm build` automatically — you don't need to start `pnpm dev`.

### AI features go through the backend

The platform's managed AI connector is **server-side only** — the browser
cannot reach it. If the user asks for an AI feature (chatbot, summarise,
classify, …), do not call any AI endpoint from React. Add a backend route
(see the backend tech section) that calls the connector, and have the
frontend `fetch('/api/...')` that route. Never put an AI/model key in
frontend code.

### Preview build contract

The platform's preview build runs, from the committed tree,
`pnpm install --frozen-lockfile` then `pnpm run build` — **commit the
updated `pnpm-lock.yaml`** whenever dependencies change; the frozen
install fails on a stale lockfile. The platform's turn-end routine owns
`build_info.json` and the `preview` flag; your job is keeping the real
build green.

### Catalog navigation (variant lookup)

Pattern library lives at
`/opt/skeletons/ix-catalog/apps/web/src/catalog/`. Conventions in 5
lines:

1. Three-level hierarchy: `<section>/<pattern>/variants/<file>.tsx`.
2. Each pattern README carries `use_when` + `dont_use_when` — read both
   before picking a variant.
3. Variants are self-contained TSX files — no shared utilities, no
   shared mocks; copy verbatim into the target app.
4. Variants use **named exports** (no defaults), PascalCase prefixed
   with the pattern name (e.g. `KpiCardWithTrendPositive`).
5. All strings in variants are inline + English — variants are not
   i18n consumers; the target app adds i18n keys.

Start in `foundations/` (spacing, typography, color tokens) before any
component work, and in `page-archetypes/` (overview-hero, entity-list,
entity-detail-tabs) when scaffolding a whole route — those archetypes show
the page-level spacing and grid layout that isolated components don't.

For full conventions (frontmatter schema, gallery shape, status
values), read
`/opt/skeletons/ix-catalog/.claude/catalog-conventions.md`.

### Styling rules (CRITICAL)

These are hard rules. The `foundations` catalog patterns show every token;
read them (see MANDATORY above) — this is the summary.

- **No Tailwind, no manual utility CSS** (no `.flex`, `.text-xl`,
  `.space-y-4`, etc.).
- **Spacing — tokens only.** Every gap, margin, and padding uses a
  `--theme-space-*` token (`--theme-space--3` … `--theme-space-8`). A raw
  `gap: "1rem"`, `margin: 16px`, or `padding: "0.5rem"` is **forbidden** —
  that is the #1 cause of cramped, stuck-together UIs. The
  `--theme-spacing-NN` px-suffixed names do **not** exist in iX 5 — never
  use them. Set spacing with a single `gap` on a flex/grid container, not
  per-child margins.
- **Page layout via the iX grid.** Structure pages with `IxLayoutGrid`,
  `IxRow`, `IxCol` (12-column); group content in `IxCard`. Give pages an
  outer padding and a vertical `gap` between sections (see the
  `page-archetypes` archetypes).
- **Typography via `IxTypography`.** Set text with
  `<IxTypography format="h1|h4|body|label-sm|…">` and de-emphasise with
  `textColor="soft|weak"`. Never set a raw `fontSize`/`fontWeight`.
- **Color — tokens only.** Use `--theme-color-*` (e.g.
  `var(--theme-color-primary)`, `var(--theme-color-std-text)`,
  `var(--theme-color-soft-text)`, semantic
  `var(--theme-color-success|warning|alarm)`). **Never** hardcode a hex,
  and note the prefix is `--theme-color-`, not `--ix-color-`.
- **Prefer the component's own prop** over manual CSS when one exists
  (`IxButton variant`, `IxKpi state`) instead of recolouring by hand.

### Common pitfalls

- `defineCustomElements()` from `@siemens/ix/loader` MUST be called in
  `main.tsx` — otherwise components don't render.
- Brand theme: `themeSwitcher.setTheme('theme-brand-dark')`, NOT a
  `data-ix-theme` attribute.
- `headerSubtitle` (lowercase t), not `headerSubTitle`.
- There is no `IxBasicNavigation` — use `IxMenu` + `IxMenuItem`.
- There is no built-in DataGrid — use `IxEventList` or
  `@siemens/ix-aggrid`.

### Vite config

Every Vite app MUST set `server.allowedHosts` in `vite.config.ts`.
Without this, preview will fail with "Blocked request":

```ts
server: {
  host: "0.0.0.0",
  allowedHosts: true,
}
```

### Testing — the skeleton already has it; read before you write

The ix-catalog scaffold ships a COMPLETE test setup. Read it before writing
or running any test, and do **not** install test tooling — it is already
there:

- `apps/web/vite.config.ts` (`test` block) — Vitest runs in **browser mode**:
  `browser: { provider: "playwright", instances: [{ browser: "chromium" }] }`,
  `setupFiles: "./src/setupTests.ts"`. Tests run in a **real headless
  Chromium** (already in the image), NOT jsdom — so iX web components render
  for real and need no DOM shims.
- `apps/web/src/setupTests.ts` — the browser-mode setup.
- `apps/web/package.json` devDependencies — already include `vitest`,
  `@vitest/browser`, `vitest-browser-react`, `@testing-library/react`,
  `@testing-library/jest-dom`, `shadow-dom-testing-library`.

Run the suite with `pnpm test` (= `vitest`).

Rules:

- Do **NOT** add `jsdom`, `@testing-library/user-event`, or a jsdom `test.environment` — the setup is browser-mode by design; adding jsdom fights it and breaks iX web-component rendering.
- Never `pnpm install` a test package before checking `package.json` devDependencies — it is almost certainly already present.
- Test iX components AS web components: render with `vitest-browser-react` and query the shadow DOM via `shadow-dom-testing-library`. Do not swap iX components for native HTML elements to make a test pass.
- In a writing-plans plan and in every subagent-driven implementer dispatch that touches tests, point first at `vite.config.ts`, `src/setupTests.ts`, and `package.json` devDependencies.
