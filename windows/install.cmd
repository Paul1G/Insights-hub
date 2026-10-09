@echo off
rem Asset Model Studio - install / update on Windows.
rem Installs the dependencies and builds the web app and the backend.
rem Requires Node.js 24 LTS (https://nodejs.org). Run from any folder.
setlocal
set "ROOT=%~dp0.."
cd /d "%ROOT%" || goto :fail

where node >nul 2>nul || (
  echo Node.js was not found. Install Node.js 24 LTS from https://nodejs.org and open a new terminal.
  goto :fail
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 22 (
  echo Node.js %NODE_MAJOR% is too old. Install Node.js 24 LTS from https://nodejs.org.
  goto :fail
)
echo Using Node.js
node --version

where pnpm >nul 2>nul || (
  echo Installing pnpm...
  call npm install -g pnpm@11 || goto :fail
)
echo Using pnpm
call pnpm --version

echo.
echo === Installing and building the web app (apps\web) ===
pushd "%ROOT%\apps\web" || goto :fail
call pnpm install --frozen-lockfile || goto :failpop
call pnpm run build || goto :failpop
popd

echo.
echo === Installing and building the backend (backend) ===
pushd "%ROOT%\backend" || goto :fail
call pnpm install --frozen-lockfile || goto :failpop
call pnpm run build || goto :failpop
popd

echo.
echo Installation complete. Start the app with windows\start.cmd
exit /b 0

:failpop
popd
:fail
echo.
echo Installation failed - see the messages above.
exit /b 1
