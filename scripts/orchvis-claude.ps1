# Launches Claude Code with the orchvis channel armed (push delivery).
# All arguments pass through to claude, e.g.: .\scripts\orchvis-claude.ps1 --resume
# The marketplace name defaults to orchvis; set $env:ORCHVIS_MARKETPLACE to override.
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host 'Claude Code was not found on PATH. Install it first: https://code.claude.com'
    exit 1
}
$marketplace = 'orchvis'
if ($env:ORCHVIS_MARKETPLACE) { $marketplace = $env:ORCHVIS_MARKETPLACE }
& claude --dangerously-load-development-channels "plugin:orchvis@$marketplace" @args
exit $LASTEXITCODE
