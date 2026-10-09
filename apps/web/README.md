# Asset Model Studio — web app

React 19 + TypeScript + Vite + iX v5. See the repository README for features
and architecture.

- `pnpm dev` — dev server on :5173 (proxies `/api` to the backend on :8080)
- `pnpm build` — type-check and production build
- `pnpm test` — Vitest in browser mode (real Chromium)
- `pnpm e2e` — Playwright smoke tests (starts the built backend from `../../backend/dist`)
- `pnpm lint` / `pnpm lint:ix` — ESLint and the iX design-system checks
