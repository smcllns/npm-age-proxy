# npm-age-proxy

[![CI](https://github.com/smcllns/npm-age-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/smcllns/npm-age-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)

> A simple guard against supply-chain attacks: a simple proxy that runs on your machine, handles requests to npm from `npm`, `pnpm`, `bun`, `yarn`, `npx`, `bunx`, `pnpm dlx` and prevents installing npm package versions published in the last X days (default 7 days). — 

## How it works

- You configure package managers talk to this proxy (default: `127.0.0.1:8765`) instead of `npm` directly.
- For each request the proxy fetches the real data from npm, **removes any version younger than 7 days** from the response, and passes the rest through unchanged. This way your local package manager is unaware of fresher versions.
- Everything else — search, login, publishing, and anything you allowlist — is forwarded untouched.


## Install

Install the proxy server

```bash
git clone https://github.com/smcllns/npm-age-proxy.git
cd npm-age-proxy
bun install
```

Run it as a background service on your machine so it starts at login and restarts itself if it crashes.

```bash
# macOS - uses launchd
bash examples/install-service.sh

# linux - uses systemd
cp examples/npm-age-proxy.service ~/.config/systemd/user/
sed -i "s|__REPO__|$PWD|g" ~/.config/systemd/user/npm-age-proxy.service
systemctl --user daemon-reload && systemctl --user enable --now npm-age-proxy
```

Confirm it's running

```bash
curl -s http://127.0.0.1:8765/__status
# you should see JSON beginning with `{"ok":true,...}`
# else check the Troubleshooting section below
```

Point your package managers at it

```bash
# npm, pnpm, yarn
echo 'registry=http://127.0.0.1:8765/' >> ~/.npmrc          

# bun
printf '\n[install]\nregistry = "http://127.0.0.1:8765/"\n' >> ~/.bunfig.toml
```

Clear caches so anything already downloaded gets re-downloaded and checked through the proxy.

```bash
npm cache clean --force
pnpm store prune 2>/dev/null || true
rm -rf ~/.bun/install/cache
```

Done. Your installs are age-gated automatically now — you won't notice it unless it blocks something.

```bash
# npm
"Version not found"

#pnpm
"No matching version"
```

> [@sam] are those the actual error messages? Let's be good about showing people what to expect for npm, pnpm, and bun? Just the terminal output, no prose needed.

## Uninstall

Remove the background service

```bash
# macOS
bash examples/uninstall-service.sh

# Linux
systemctl --user disable --now npm-age-proxy
```

> [@sam] that linux command just disables, mac reads like it uninstalls. Is Linux equivalent to the mac outcome?

Then revert step 2, so `~/.npmrc` points at your previous registry and remove `[install]` block from `~/.bunfig.toml`. 

> [@sam] this isn't great. Can the install script that overwrites registry= first move the original registry to registry-previous= and then the uninstall step can revert registry= and clean up registry-previous?

## Update

To install a new version of npm-age-proxy 

```bash
cd npm-age-proxy        
git pull
bun install             
bash examples/restart-service.sh      # macOS  (Linux: systemctl --user restart npm-age-proxy)
```

## Development

```bash
bun install
bun test           # unit tests, mocked fetch
bun run typecheck  # tsc --noEmit
bun run dev        # hot-reload server, for editing the code
```

## Allowlist trusted releases

The main tradeoff is this proxy can prevent installing fresh packages you do want:

1. Hotfixes including urgent security updates
2. The latest updates to your own packages

You can explicitly add trusted packages to an allowlist:

```bash
mkdir -p ~/.config/npm-age-proxy
echo "@scope/package-name" >> ~/.config/npm-age-proxy/allowlist.txt
```

One entry per line, either:
- `package-name` (unscoped package)
- `@scope/package-name` (scoped package)
- `@your-scope` (any package from that namespace)

No server restart required. Changes apply immediately because the allowlist is checked fresh on each request. 

Example allow list here: `examples/allowlist.txt`

> @sam: make that a link to the example allow list?

---

### What this does

This is **NPM age-gating only**: it prevents installing new packages for X days so hijacked releases can be caught before you install them. 

It is intended to be a lightweight solution that mitigates the most common and accidental scenarios. It does not block every attack vector that leads to supply chain attacks. 

| Request | Behavior |
|---------|----------|
| Package metadata (`GET /<pkg>`, `GET /@scope/<pkg>`, encoded `GET /@scope%2fpkg`) | Drops any version published within `MIN_AGE_DAYS` (or with missing/malformed publish time), repoints `dist-tags` to the newest surviving version, and rewrites tarball URLs back through the proxy. |
| Tarball download (`GET /<pkg>/-/<file>.tgz`) | Allowed if old enough; `403` if too fresh; `502` if its publish time can't be verified. |
| Anything else (search, audit, login, publish) | Forwarded unchanged. |
| A path matching an allowlist entry | Forwarded unchanged — no filtering, no age check. |

**Fail-closed by design:** if npm returns a server error, the response is malformed or oversized, or a publish time is missing, the proxy returns `502` instead of passing it through. It would rather interrupt an install than serve something it couldn't verify.

### What this does NOT do

This does not protect against other sources of supply chain attack:

- **Postinstall scripts** — a 30-day-old package can still run malicious `postinstall` code. Different defense (sandboxing).
- **Other ecosystems** — PyPI, crates.io, RubyGems, Go modules need their own proxies.
- **`curl | sh` installers** (`bun`, `uv`, `rustup`) — they don't use the npm registry.
- **Lockfile auditing** — this gates resolution-time fetches, not lockfiles already on disk.
- **Typosquatting, known-CVE blocking, signature verification** — age-gating only.
- **CI** — GitHub Actions and the like won't see this proxy. Gate in CI separately if your threat model needs it.


### Settings

| Env var | Default | Effect |
|---------|---------|--------|
| `PORT` | `8765` | Listen port |
| `HOST` | `127.0.0.1` | Listen host. Use `0.0.0.0` only if you intentionally want LAN access. |
| `MIN_AGE_DAYS` | `7` | Versions younger than this are blocked. `0` disables filtering. |
| `UPSTREAM` | `https://registry.npmjs.org` | Upstream registry URL |
| `NPM_AGE_PROXY_FORCE_IPV4` | enabled | Use IPv4 for upstream HTTPS requests, avoiding Bun fetch stalls where IPv6 is advertised but unreachable. Set `0` to use native `fetch`. |
| `ALLOWLIST_PATH` | `${XDG_CONFIG_HOME:-$HOME/.config}/npm-age-proxy/allowlist.txt` | Path to the allowlist file |
| `MAX_PACKUMENT_BYTES` | `52428800` | Max metadata body size before failing closed |
| `LOG_LEVEL` | `info` | `info`, or `debug` for upstream status + cache hit/miss |

Set these in the service file's environment block (`EnvironmentVariables` in the plist, `Environment=` lines in the systemd unit) and restart.

### Configurable URL in managed dotfiles

Set `NPM_AGE_PROXY_URL` in a shell env file (e.g. `~/.zshenv`) and use `registry=${NPM_AGE_PROXY_URL}` in `.npmrc`. Use a literal URL in `bunfig.toml` unless you've verified your Bun version expands env vars there. `http_proxy`/`https_proxy`/`all_proxy` are unrelated — see `examples/shell-env.sh`.

### Status endpoint

`GET /__status` returns JSON diagnostics. Full field set:

```json
{ "ok": true, "version": "0.1.0", "commit": "1c514b7", "uptimeSeconds": 83886,
  "upstream": "https://registry.npmjs.org", "minAgeDays": 7, "cacheTtlMs": 60000,
  "cacheSize": 2, "maxPackumentBytes": 52428800,
  "allowlistPath": "/home/you/.config/npm-age-proxy/allowlist.txt",
  "allowlistEntries": ["@smcllns"], "lastUpstreamError": null }
```

`commit` is the exact code the running process booted from — it's `null` when run from a non-git checkout. This is how the update check works: compare what's running against what's on disk, and they should match:

```bash
curl -s http://127.0.0.1:8765/__status | grep -o '"commit":"[^"]*"'   # running
git rev-parse --short HEAD                                            # on disk
```

If they differ, the restart didn't take and you're still on the old code.

> @sam: this commit check seems like it should be a confirmation step back in Update section?

### Request log format

Logs write to `~/Library/Logs/npm-age-proxy.log` (macOS) or `journalctl --user -u npm-age-proxy` (Linux).

One line per request:

```
2026-05-14T23:49:21.467Z GET /next 200 76ms filtered:3766→3762
2026-05-14T23:50:02.114Z GET /next/-/next-16.3.0-canary.19.tgz 403 2ms block:fresh
```

### Manual service setup (no installer)

The installers just fill placeholders and load the service. To do it by hand: copy `examples/com.npm-age-proxy.plist` (macOS) or `examples/npm-age-proxy.service` (Linux), replace `__REPO__` (and `__HOME__` on macOS) with absolute paths, drop it in `~/Library/LaunchAgents/` or `~/.config/systemd/user/`, and load it (`launchctl bootstrap gui/$(id -u) <plist>` / `systemctl --user enable --now npm-age-proxy`).


## License

MIT