#!/usr/bin/env bash
# Fully removes npm-age-proxy: stops and deletes the background service, and
# restores your package managers to the registry they used before setup.
# Run via `bun run teardown`. Leaves your checkout untouched.
set -euo pipefail

[[ "$(uname)" == "Darwin" ]] || { echo "npm-age-proxy currently supports macOS only." >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.npm-age-proxy"
# shellcheck source=_clients.sh
source "$REPO_DIR/scripts/_clients.sh"

echo "1. Removing the background service…"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"

echo "2. Restoring your package managers…"
restore_npmrc
restore_bunfig

echo
echo "Done. npm-age-proxy is fully removed."
