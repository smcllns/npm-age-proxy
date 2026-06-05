#!/usr/bin/env bash
# Restarts the service so it picks up freshly-pulled code. Run via `bun run restart`
# (the update flow does this for you after `git pull`).
set -euo pipefail

LABEL="com.npm-age-proxy"
PORT="${PORT:-8765}"

[[ "$(uname)" == "Darwin" ]] || { echo "npm-age-proxy currently supports macOS only." >&2; exit 1; }
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Restarted. Confirm it's on the new code (these should match):"
echo "  curl -s http://127.0.0.1:$PORT/__status | grep -o '\"commit\":\"[^\"]*\"'"
echo "  git rev-parse --short HEAD"
