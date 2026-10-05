#!/usr/bin/env bash
# Writes this machine's orchvis config, ~/.orchvis/config.json, with the broker
# URL and the shim token. Options pass through to setup.mjs (try --help):
#   --broker-url URL   --token TOKEN   --from-broker-config [PATH]
# Without them it prompts; the token prompt does not echo. The token is handed
# to Node through an environment variable for that one process, never echoed.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
for d in /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$PATH:$d" ;; esac
done
export PATH
if ! command -v node >/dev/null 2>&1; then
  echo "orchvis needs Node.js 20 or later, and node was not found on PATH."
  echo "Install it from https://nodejs.org (or: brew install node), then run this again."
  exit 1
fi

has_url=0; has_token=0; from_broker=0
for a in "$@"; do
  case "$a" in
    --help|-h) exec node "$here/setup.mjs" --help ;;
    --broker-url) has_url=1 ;;
    --token) has_token=1 ;;
    --from-broker-config) from_broker=1 ;;
  esac
done

extra=()
if [ "$has_url" = 0 ] && [ -z "${ORCHVIS_BROKER_URL:-}" ] && [ "$from_broker" = 0 ]; then
  read -r -p "Broker URL (e.g. ws://broker-host:7801): " url
  [ -n "$url" ] && extra+=(--broker-url "$url")
fi
if [ "$has_token" = 0 ] && [ -z "${ORCHVIS_TOKEN:-}" ] && [ "$from_broker" = 0 ]; then
  read -r -s -p "Shim token (not echoed): " token
  echo
  ORCHVIS_TOKEN="$token" exec node "$here/setup.mjs" --yes "$@" "${extra[@]+"${extra[@]}"}"
fi
exec node "$here/setup.mjs" --yes "$@" "${extra[@]+"${extra[@]}"}"
