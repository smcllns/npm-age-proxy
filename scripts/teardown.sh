#!/usr/bin/env bash
# Fully removes npm-age-proxy: stops and deletes the background service, and
# restores your package managers to the registry they used before setup.
# Run via `bun run teardown`. Leaves your checkout untouched.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.npm-age-proxy"
# shellcheck source=_clients.sh
source "$REPO_DIR/scripts/_clients.sh"

echo "1. Removing the background service…"
case "$(uname)" in
  Darwin)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
    ;;
  Linux)
    systemctl --user disable --now npm-age-proxy 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/npm-age-proxy.service"
    systemctl --user daemon-reload 2>/dev/null || true
    ;;
  *) echo "Unsupported OS: $(uname)." >&2; exit 1 ;;
esac

echo "2. Restoring your package managers…"
restore_npmrc
restore_bunfig

echo
echo "Done. npm-age-proxy is fully removed."
