@echo off
rem Writes this machine's orchvis config (broker URL and shim token).
rem Double-click, or run with options (try --help). The token prompt does not echo.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo orchvis needs Node.js 20 or later, and node was not found on PATH.
  echo Install it from https://nodejs.org, then run this again.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set "CODE=%ERRORLEVEL%"
pause
exit /b %CODE%
