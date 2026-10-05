@echo off
rem Launches Claude Code with the orchvis channel armed (push delivery).
rem All arguments pass through to claude, e.g.: orchvis-claude.cmd --resume
rem The marketplace name defaults to orchvis; set ORCHVIS_MARKETPLACE to override.
setlocal
where claude >nul 2>nul
if errorlevel 1 (
  echo Claude Code was not found on PATH. Install it first: https://code.claude.com
  exit /b 1
)
if "%ORCHVIS_MARKETPLACE%"=="" set "ORCHVIS_MARKETPLACE=orchvis"
claude --dangerously-load-development-channels plugin:orchvis@%ORCHVIS_MARKETPLACE% %*
exit /b %ERRORLEVEL%
