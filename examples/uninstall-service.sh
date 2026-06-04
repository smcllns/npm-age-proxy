#!/usr/bin/env bash
# Removes the npm-age-proxy launchd agent (macOS). Stops the service and deletes
# the plist that install-service.sh created. Leaves your checkout untouched.
set -euo pipefail

LABEL="com.npm-age-proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[[ "$(uname)" == "Darwin" ]] || { echo "This uninstaller is macOS-only. On Linux: systemctl --user disable --now npm-age-proxy" >&2; exit 1; }

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "Stopped and removed $LABEL."
echo
echo "⚠️  Your package managers may still point at the (now-stopped) proxy, which"
echo "    will make installs fail. Remove these lines if present:"
echo "      ~/.npmrc        →  registry=http://127.0.0.1:8765/"
echo "      ~/.bunfig.toml  →  [install] registry = \"http://127.0.0.1:8765/\""
