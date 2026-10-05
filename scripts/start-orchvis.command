#!/usr/bin/env bash
# macOS: double-click in Finder to start the orchvis broker and open the web app.
# Keep the Terminal window open while you use orchvis; Ctrl+C stops the broker.
here="$(cd "$(dirname "$0")" && pwd)"
"$here/start-orchvis.sh" "$@"
code=$?
if [ "$code" -ne 0 ]; then
  echo
  read -r -p "orchvis did not start (exit $code). Press Return to close this window." _
fi
exit "$code"
