#!/usr/bin/env bash
# Starts the orchvis broker and opens the web app.
# Usage: scripts/start-orchvis.sh [options]   (try --help)
# Keep this terminal open while you use orchvis; Ctrl+C stops the broker.
set -u
here="$(cd "$(dirname "$0")" && pwd)"

# Terminal windows opened from Finder may miss Homebrew's PATH.
for d in /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$PATH:$d" ;; esac
done
export PATH

if ! command -v node >/dev/null 2>&1; then
  echo "orchvis needs Node.js 20 or later, and node was not found on PATH."
  echo "Install it from https://nodejs.org (or: brew install node), then run this again."
  exit 1
fi
exec node "$here/orchvis-start.mjs" "$@"
