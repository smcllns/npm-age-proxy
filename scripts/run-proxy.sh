#!/usr/bin/env bash
# Resolves bun from typical install paths, then runs the proxy.
# Used as the launchd entrypoint so the plist doesn't hardcode bun's path.
set -euo pipefail

for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  if [[ -x "$candidate" ]]; then BUN="$candidate"; break; fi
done
[[ -z "${BUN:-}" ]] && { echo "ERROR: bun not found" >&2; exit 1; }

# REPO_DIR defaults to this script's parent repo; override by exporting it before launch.
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
exec "$BUN" run "$REPO_DIR/proxy.ts"
