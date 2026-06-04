#!/usr/bin/env bash
# Installs npm-age-proxy as a launchd agent (macOS). Fills the plist placeholders
# from the current checkout, copies it into ~/Library/LaunchAgents, and boots it.
# Re-run anytime to reinstall; it reloads cleanly.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.npm-age-proxy"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

[[ "$(uname)" == "Darwin" ]] || { echo "This installer is macOS-only. On Linux use examples/npm-age-proxy.service." >&2; exit 1; }

chmod +x "$REPO_DIR/examples/run-npm-age-proxy.sh"

sed -e "s|__REPO__|$REPO_DIR|g" -e "s|__HOME__|$HOME|g" \
  "$REPO_DIR/examples/com.npm-age-proxy.plist" > "$DEST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"

echo "Installed $DEST and started $LABEL."
echo "Verify:  curl -s http://127.0.0.1:8765/__status"
echo "Restart after a git pull:  launchctl kickstart -k gui/\$(id -u)/$LABEL"
