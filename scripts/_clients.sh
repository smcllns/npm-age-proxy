#!/usr/bin/env bash
# Shared helpers for pointing package managers at the proxy and reverting cleanly.
# Sourced by setup.sh and teardown.sh. Not meant to be run directly.
#
# sed -i.bak + rm is the portable in-place edit (works on both BSD/macOS and GNU/Linux).

PROXY_URL="http://127.0.0.1:${PORT:-8765}/"
NPMRC="$HOME/.npmrc"
BUNFIG="$HOME/.bunfig.toml"

# --- npm / pnpm / yarn (~/.npmrc, ini) ----------------------------------------
# Backs up an existing registry to `registry-previous=` so teardown can restore it.
point_npmrc() {
  touch "$NPMRC"
  if grep -qxF "registry=$PROXY_URL" "$NPMRC"; then return; fi
  if grep -qE '^registry=' "$NPMRC" && ! grep -qE '^registry-previous=' "$NPMRC"; then
    sed -i.bak -E 's|^registry=|registry-previous=|' "$NPMRC" && rm -f "$NPMRC.bak"
  fi
  printf 'registry=%s\n' "$PROXY_URL" >> "$NPMRC"
  echo "  ~/.npmrc      → registry now points at the proxy"
}

restore_npmrc() {
  [ -f "$NPMRC" ] || return
  # fixed-string exact-line match — no regex, so dots in the URL stay literal
  grep -vxF "registry=$PROXY_URL" "$NPMRC" > "$NPMRC.tmp" || true
  mv "$NPMRC.tmp" "$NPMRC"
  if grep -qE '^registry-previous=' "$NPMRC"; then
    sed -i.bak -E 's|^registry-previous=|registry=|' "$NPMRC" && rm -f "$NPMRC.bak"
  fi
  echo "  ~/.npmrc      → registry restored"
}

# --- bun (~/.bunfig.toml, TOML) -----------------------------------------------
# TOML can't have duplicate [install] tables, so we back up the whole file (or note
# that we created it) and restore it wholesale — safest for a structured format.
point_bunfig() {
  if [ -f "$BUNFIG" ] && grep -qF "$PROXY_URL" "$BUNFIG"; then return; fi
  if [ -f "$BUNFIG" ]; then
    [ -f "$BUNFIG.npm-age-proxy.bak" ] || cp "$BUNFIG" "$BUNFIG.npm-age-proxy.bak"
    if grep -qE '^\[install\]' "$BUNFIG"; then
      awk -v url="$PROXY_URL" '
        /^\[install\]/ && !done { print; print "registry = \"" url "\""; done=1; next }
        /^[[:space:]]*registry[[:space:]]*=/ { print "# npm-age-proxy backup: " $0; next }
        { print }
      ' "$BUNFIG" > "$BUNFIG.tmp" && mv "$BUNFIG.tmp" "$BUNFIG"
    else
      printf '\n[install]\nregistry = "%s"\n' "$PROXY_URL" >> "$BUNFIG"
    fi
  else
    printf '[install]\nregistry = "%s"\n' "$PROXY_URL" > "$BUNFIG"
    touch "$BUNFIG.npm-age-proxy.created"
  fi
  echo "  ~/.bunfig.toml → registry now points at the proxy"
}

restore_bunfig() {
  if [ -f "$BUNFIG.npm-age-proxy.created" ]; then
    rm -f "$BUNFIG" "$BUNFIG.npm-age-proxy.created"
    echo "  ~/.bunfig.toml → removed (created by setup)"
  elif [ -f "$BUNFIG.npm-age-proxy.bak" ]; then
    mv "$BUNFIG.npm-age-proxy.bak" "$BUNFIG"
    echo "  ~/.bunfig.toml → restored"
  fi
}

clear_caches() {
  npm cache clean --force >/dev/null 2>&1 || true
  pnpm store prune >/dev/null 2>&1 || true
  rm -rf "$HOME/.bun/install/cache" 2>/dev/null || true
  echo "  caches cleared"
}
