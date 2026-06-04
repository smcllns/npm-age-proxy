#!/usr/bin/env bash
# Restarts the npm-age-proxy service so it picks up freshly-pulled code (macOS).
# Run this after `git pull`.
set -euo pipefail

LABEL="com.npm-age-proxy"

[[ "$(uname)" == "Darwin" ]] || { echo "This script is macOS-only. On Linux: systemctl --user restart npm-age-proxy" >&2; exit 1; }

launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Restarted $LABEL."
echo "Confirm it's on the new code (these should match):"
echo "  curl -s http://127.0.0.1:8765/__status | grep -o '\"commit\":\"[^\"]*\"'"
echo "  git rev-parse --short HEAD"
