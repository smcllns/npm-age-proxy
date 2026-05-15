# Source from ~/.zshenv, an agent bootstrap file, or a launchd EnvironmentVariables block.
export NPM_AGE_PROXY_URL="${NPM_AGE_PROXY_URL:-http://127.0.0.1:8765/}"

# Optional curl/wget installer capture.
# This must point at a generic HTTP(S) forward proxy that supports CONNECT.
# Do not point these variables at npm-age-proxy; npm-age-proxy only speaks npm registry paths.
#
# export INSTALLER_FORWARD_PROXY_URL="${INSTALLER_FORWARD_PROXY_URL:-http://127.0.0.1:8770}"
# export http_proxy="$INSTALLER_FORWARD_PROXY_URL"
# export https_proxy="$INSTALLER_FORWARD_PROXY_URL"
# export all_proxy="$INSTALLER_FORWARD_PROXY_URL"
# export no_proxy="${no_proxy:-localhost,127.0.0.1,::1,*.local}"
