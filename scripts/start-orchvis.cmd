@echo off
rem Starts the orchvis broker and opens the web app. Double-click this file,
rem or run it from cmd or PowerShell. Options are passed to orchvis-start.mjs
rem (try --help). Keep this window open while you use orchvis; Ctrl+C stops it.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo orchvis needs Node.js 20 or later, and node was not found on PATH.
  echo Install it from https://nodejs.org, then run this again.
  pause
  exit /b 1
)
node "%~dp0orchvis-start.mjs" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" pause
exit /b %CODE%
