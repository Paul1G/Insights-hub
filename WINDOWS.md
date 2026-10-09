# Installing Asset Model Studio on Windows

Asset Model Studio runs locally as one small Node.js server that serves both
the app and its API at **http://localhost:8080**. Only your own computer can
reach it.

## 1. Prerequisites (once)

1. **Node.js 24 LTS**: download the Windows installer (`.msi`) from
   <https://nodejs.org> and install it with the default options (keep
   "Add to PATH" checked). Node.js 22.13 or newer also works.
2. Open a **new** Command Prompt or PowerShell window and check:
   ```
   node --version
   ```
   It should print `v24.x.x` (or `v22.13` or later).

`pnpm`, the package manager the project uses, is installed automatically by
the install script if it is missing.

## 2. Unpack the source

1. Download `downloads/asset-model-studio-source.zip`.
2. Right-click the file → **Extract All…** and pick a short folder, for example
   `C:\AssetModelStudio`. Short paths avoid Windows' path-length limit inside
   `node_modules`.

You now have `C:\AssetModelStudio\asset-model-studio\` with the folders
`apps`, `backend`, `docs` and `windows`.

## 3. Install (once, and after every update)

Double-click `windows\install.cmd`, or run it from a terminal:

```
cd C:\AssetModelStudio\asset-model-studio
windows\install.cmd
```

The script checks Node.js, installs pnpm if needed, downloads the dependencies
of the web app and the backend, and builds both. The first run needs internet
access and takes a few minutes. It ends with **"Installation complete."**

## 4. Start

Double-click `windows\start.cmd`, or run:

```
windows\start.cmd
```

A window shows the server log and your browser opens
**http://localhost:8080** after a few seconds. Keep the window open while you
work. Close it, or press `Ctrl+C`, to stop the app.

To use another port, run `set PORT=8090` before `windows\start.cmd`.

## 5. First steps

- **Projects → Sample project** creates the official Wind Farm example.
- **Tenants → New connection** adds a tenant:
  - **Simulated tenant** to try deployments without credentials, or
  - **Service credentials**: client id/secret plus the token URL
    `https://<tenant>.piam.<region>.mindsphere.io/oauth/token` and the API URL
    `https://gateway.<region>.mindsphere.io/api/assetmanagement/v3`.
- In a project, **Tenant model** links the project to a tenant and reads all of
  its existing types and assets.

## Where your data is stored

| What | Where |
|---|---|
| Projects, versions, file contents, tenant catalogs | Your browser's local storage for `http://localhost:8080` (IndexedDB). Use **Projects → Export** for backups; clearing the browser's site data deletes them. |
| Tenant connections (encrypted), encryption key, audit log, simulator tenants | `%LOCALAPPDATA%\AssetModelStudio` (e.g. `C:\Users\<you>\AppData\Local\AssetModelStudio`) |

The file `secret.key` in that folder encrypts your stored connection
credentials. Keep it private, and back it up together with `app.db` if you want
to keep your connections. To use your own key instead, set
`APP_ENCRYPTION_KEY` (base64 of 32 random bytes) before starting.

## Updating

Replace the folder with the contents of a newer ZIP (your data is not stored in
it), then run `windows\install.cmd` again and start as usual.

## Uninstalling

Delete the program folder and `%LOCALAPPDATA%\AssetModelStudio`. Projects stay
in the browser until you clear its site data for `localhost:8080`.

## Troubleshooting

- **"Node.js was not found"**: install Node.js and open a *new* terminal so
  the updated PATH is used.
- **Install fails while downloading packages behind a company proxy**: configure
  npm/pnpm for the proxy, then rerun the install script:
  ```
  npm config set proxy http://proxy.example.com:8080
  npm config set https-proxy http://proxy.example.com:8080
  ```
- **The app cannot reach Insights Hub behind a company proxy** (connection test
  fails with a network error): Node.js only uses a proxy when told to. With
  Node.js 24.5 or newer, set these before `windows\start.cmd`:
  ```
  set NODE_USE_ENV_PROXY=1
  set HTTPS_PROXY=http://proxy.example.com:8080
  ```
- **Port 8080 is already in use**: start with another port (`set PORT=8090`).
- **Blank page after an update**: reload with `Ctrl+F5`. The app caches itself
  for offline use.

## For developers

Run the backend and the Vite dev server with hot reload in two terminals:

```
cd backend
copy .env.example .env
pnpm dev

cd apps\web
pnpm dev
```

Then open http://localhost:5173 (Vite forwards `/api` to the backend on :8080).
Tests: `pnpm test` in each folder. The browser tests need Playwright's
Chromium: `npx playwright install chromium`. `pnpm lint:ix` needs a Bash
shell (e.g. Git Bash).
