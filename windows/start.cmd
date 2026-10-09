@echo off
rem Asset Model Studio - start on Windows.
rem Serves the app and its API on http://localhost:8080 (this computer only).
rem Stop it with Ctrl+C or by closing this window.
setlocal
set "ROOT=%~dp0.."

if not exist "%ROOT%\backend\dist\server.js" (
  echo The app is not built yet. Run windows\install.cmd first.
  exit /b 1
)
if not exist "%ROOT%\apps\web\dist\index.html" (
  echo The web app is not built yet. Run windows\install.cmd first.
  exit /b 1
)

if "%PORT%"=="" set "PORT=8080"
rem Only this computer can reach the app: there is no sign-in on a local install.
set "APP_ADDR=127.0.0.1:%PORT%"
set "APP_STATIC_DIR=%ROOT%\apps\web\dist"
rem Tenant connections (encrypted), the generated key and the audit log live here.
if "%APPLICATION_DATA_DIR%"=="" set "APPLICATION_DATA_DIR=%LOCALAPPDATA%\AssetModelStudio"
if not exist "%APPLICATION_DATA_DIR%" mkdir "%APPLICATION_DATA_DIR%"
set "APP_ENV=prod"

echo Asset Model Studio is starting on http://localhost:%PORT%
echo Data directory: %APPLICATION_DATA_DIR%
rem Open the browser once the server had a moment to start.
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:%PORT%'"
node "%ROOT%\backend\dist\server.js"
