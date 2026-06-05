#!/usr/bin/env bash
# Sets up npm-age-proxy end to end: installs the background service (launchd),
# points your package managers at the proxy (backing up your current registry so
# `teardown` can restore it), and clears stale caches. Run via `bun run setup`.
# Safe to re-run. macOS only for now.
set -euo pipefail

[[ "$(uname)" == "Darwin" ]] || { echo "npm-age-proxy currently supports macOS only. Linux support is planned." >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.npm-age-proxy"
PORT="${PORT:-8765}"
# shellcheck source=_clients.sh
source "$REPO_DIR/scripts/_clients.sh"

chmod +x "$REPO_DIR/scripts/run-proxy.sh"

echo "1. Installing the background service…"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
sed -e "s|__REPO__|$REPO_DIR|g" -e "s|__HOME__|$HOME|g" \
  "$REPO_DIR/examples/com.npm-age-proxy.plist" > "$DEST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"

echo "2. Pointing your package managers at the proxy…"
point_npmrc
point_bunfig

echo "3. Clearing caches…"
clear_caches

echo
echo "Done. Confirm it's running:"
echo "  curl -s http://127.0.0.1:$PORT/__status      # expect {\"ok\":true,...}"
