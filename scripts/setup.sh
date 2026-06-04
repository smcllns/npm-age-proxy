#!/usr/bin/env bash
# Sets up npm-age-proxy end to end: installs the background service (launchd on
# macOS, systemd on Linux), points your package managers at the proxy (backing up
# your current registry so `teardown` can restore it), and clears stale caches.
# Run via `bun run setup`. Safe to re-run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.npm-age-proxy"
PORT="${PORT:-8765}"
# shellcheck source=_clients.sh
source "$REPO_DIR/scripts/_clients.sh"

chmod +x "$REPO_DIR/scripts/run-proxy.sh"

echo "1. Installing the background service…"
case "$(uname)" in
  Darwin)
    DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
    sed -e "s|__REPO__|$REPO_DIR|g" -e "s|__HOME__|$HOME|g" \
      "$REPO_DIR/examples/com.npm-age-proxy.plist" > "$DEST"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$DEST"
    ;;
  Linux)
    DEST="$HOME/.config/systemd/user/npm-age-proxy.service"
    mkdir -p "$(dirname "$DEST")"
    sed "s|__REPO__|$REPO_DIR|g" "$REPO_DIR/examples/npm-age-proxy.service" > "$DEST"
    systemctl --user daemon-reload
    systemctl --user enable --now npm-age-proxy
    ;;
  *) echo "Unsupported OS: $(uname). See examples/ for manual setup." >&2; exit 1 ;;
esac

echo "2. Pointing your package managers at the proxy…"
point_npmrc
point_bunfig

echo "3. Clearing caches…"
clear_caches

echo
echo "Done. Confirm it's running:"
echo "  curl -s http://127.0.0.1:$PORT/__status      # expect {\"ok\":true,...}"
