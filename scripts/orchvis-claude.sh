#!/usr/bin/env bash
# Launches Claude Code with the orchvis channel armed (push delivery).
# All arguments pass through to claude, e.g.: scripts/orchvis-claude.sh --resume
# The marketplace name defaults to orchvis; set ORCHVIS_MARKETPLACE to override.
if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code was not found on PATH. Install it first: https://code.claude.com"
  exit 1
fi
exec claude --dangerously-load-development-channels "plugin:orchvis@${ORCHVIS_MARKETPLACE:-orchvis}" "$@"
