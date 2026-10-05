# Starts the orchvis broker and opens the web app.
# Usage: .\scripts\start-orchvis.ps1 [options]   (try --help)
# Keep this window open while you use orchvis; Ctrl+C stops the broker.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'orchvis needs Node.js 20 or later, and node was not found on PATH.'
    Write-Host 'Install it from https://nodejs.org, then run this again.'
    exit 1
}
& node (Join-Path $PSScriptRoot 'orchvis-start.mjs') @args
exit $LASTEXITCODE
