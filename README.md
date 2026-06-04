# npm-age-proxy

[![CI](https://github.com/smcllns/npm-age-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/smcllns/npm-age-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)

> A simple guard against supply-chain attacks: a proxy that runs on your machine, handles requests to npm from `npm`, `pnpm`, `bun`, `yarn`, `npx`, `bunx`, `pnpm dlx`, and prevents installing npm package versions published in the last X days (default 7).

## How it works

- You configure your package managers to talk to this proxy (default: `127.0.0.1:8765`) instead of `npm` directly.
- For each request the proxy fetches the real data from npm, **removes any version younger than 7 days** from the response, and passes the rest through unchanged. Your package manager never sees the fresher versions.
- Everything else — search, login, publishing, and anything you allowlist — is forwarded untouched.

## Install

Requires [Bun](https://bun.sh) 1.1.0+.

```bash
git clone https://github.com/smcllns/npm-age-proxy.git
cd npm-age-proxy
bun install
bun run setup
```

`bun run setup` installs the proxy as a background service (starts at login, restarts on crash), points your package managers at it (saving your current registry first), and clears stale caches. Confirm it's running:

```bash
curl -s http://127.0.0.1:8765/__status
# expect JSON beginning with {"ok":true,...}  — else see Troubleshooting
```

That's it. Installs are age-gated now — you won't notice unless something is blocked, which looks like this:

```console
# npm
npm error code ETARGET
npm error notarget No matching version found for some-lib@4.2.1

# pnpm
ERR_PNPM_NO_MATCHING_VERSION  No matching version found for some-lib@4.2.1

# bun
error: No version matching "4.2.1" found for specifier "some-lib" (but package exists)
```

When that happens, either wait for the version to age past the cutoff or [allowlist it](#allowlist-trusted-releases).

## Update

```bash
cd npm-age-proxy
git pull
bun install
bun run restart      # reloads the new code — a git pull alone won't
```

Confirm the new code is live — these should print the same commit:

```bash
curl -s http://127.0.0.1:8765/__status | grep -o '"commit":"[^"]*"'   # running
git rev-parse --short HEAD                                            # on disk
```

## Uninstall

```bash
bun run teardown
```

Removes the background service and restores your package managers to the registry they used before setup. Your checkout is left untouched — delete it whenever you like.

## Allowlist trusted releases

The main tradeoff is that the proxy blocks fresh packages you may actually want:

1. Hotfixes, including urgent security updates
2. The latest releases of your own packages

Add trusted packages to an allowlist to bypass the age check:

```bash
mkdir -p ~/.config/npm-age-proxy
echo "@scope/package-name" >> ~/.config/npm-age-proxy/allowlist.txt
```

One entry per line:
- `package-name` — an unscoped package
- `@scope/package-name` — a scoped package
- `@your-scope` — any package in that namespace

No restart needed; the allowlist is checked fresh on each request. Example: [`examples/allowlist.txt`](./examples/allowlist.txt).

## Troubleshooting

- **`Connection refused` on the status check** — the service didn't start. Logs: `~/Library/Logs/npm-age-proxy.err` (macOS) or `journalctl --user -u npm-age-proxy` (Linux).
- **Updated but behaving like the old version** — the service is still running old code. Run `bun run restart`.
- **Can I point `http_proxy`/`https_proxy` at it?** — No. It only understands npm registry traffic, not general web downloads.

---

# Reference

## What it does

This is **npm age-gating only**: it prevents installing new package versions for X days, so hijacked releases can be caught before you install them. It is a lightweight mitigation for the most common and accidental cases, not a defense against every supply-chain attack vector.

| Request | Behavior |
|---------|----------|
| Package metadata (`GET /<pkg>`, `GET /@scope/<pkg>`, encoded `GET /@scope%2fpkg`) | Drops any version published within `MIN_AGE_DAYS` (or with missing/malformed publish time), repoints `dist-tags` to the newest surviving version, and rewrites tarball URLs back through the proxy. |
| Tarball download (`GET /<pkg>/-/<file>.tgz`) | Allowed if old enough; `403` if too fresh; `502` if its publish time can't be verified. |
| Anything else (search, audit, login, publish) | Forwarded unchanged. |
| A path matching an allowlist entry | Forwarded unchanged — no filtering, no age check. |

**Fail-closed by design:** if npm returns a server error, the response is malformed or oversized, or a publish time is missing, the proxy returns `502` instead of passing it through. It would rather interrupt an install than serve something it couldn't verify.

## What it does NOT do

It does not protect against other supply-chain attack vectors:

- **Postinstall scripts** — a 30-day-old package can still run malicious `postinstall` code. Different defense (sandboxing).
- **Other ecosystems** — PyPI, crates.io, RubyGems, Go modules need their own proxies.
- **`curl | sh` installers** (`bun`, `uv`, `rustup`) — they don't use the npm registry.
- **Lockfile auditing** — this gates resolution-time fetches, not lockfiles already on disk.
- **Typosquatting, known-CVE blocking, signature verification** — age-gating only.
- **CI** — GitHub Actions and the like won't see this proxy. Gate in CI separately if your threat model needs it.

## Settings

Set in the service's environment block (`EnvironmentVariables` in the plist, `Environment=` in the systemd unit), then `bun run restart`.

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

The service files (`examples/com.npm-age-proxy.plist`, `examples/npm-age-proxy.service`) are where `MIN_AGE_DAYS`, `PORT`, and `HOST` live.

## Status endpoint

`GET /__status` returns JSON diagnostics:

```json
{ "ok": true, "version": "0.1.0", "commit": "1c514b7", "uptimeSeconds": 83886,
  "upstream": "https://registry.npmjs.org", "minAgeDays": 7, "cacheTtlMs": 60000,
  "cacheSize": 2, "maxPackumentBytes": 52428800,
  "allowlistPath": "/home/you/.config/npm-age-proxy/allowlist.txt",
  "allowlistEntries": ["@smcllns"], "lastUpstreamError": null }
```

`commit` is the code the running process booted from (`null` from a non-git checkout) — the [update](#update) check compares it against `git rev-parse --short HEAD`.

## Logs

One line per request. Logs to `~/Library/Logs/npm-age-proxy.log` (macOS) or `journalctl --user -u npm-age-proxy` (Linux).

```
2026-05-14T23:49:21.467Z GET /next 200 76ms filtered:3766→3762
2026-05-14T23:50:02.114Z GET /next/-/next-16.3.0-canary.19.tgz 403 2ms block:fresh
```

The last column is the decision: `filtered:N→M`, `allow:<entry>`, `block:fresh`, `pass`, `status`, `error:upstream`.

## Manual setup (no `bun run setup`)

`bun run setup` does three things you can do by hand: install the service, point your clients at the proxy, and clear caches.

- **Service** — copy `examples/com.npm-age-proxy.plist` (macOS) or `examples/npm-age-proxy.service` (Linux), replace `__REPO__` (and `__HOME__` on macOS) with absolute paths, drop it in `~/Library/LaunchAgents/` or `~/.config/systemd/user/`, and load it (`launchctl bootstrap gui/$(id -u) <plist>` / `systemctl --user enable --now npm-age-proxy`).
- **Clients** — add `registry=http://127.0.0.1:8765/` to `~/.npmrc`, and `[install]`/`registry = "http://127.0.0.1:8765/"` to `~/.bunfig.toml` (Bun keeps its own registry setting). Templates: `examples/npmrc`, `examples/bunfig.toml`.
- **Caches** — `npm cache clean --force`, `pnpm store prune`, `rm -rf ~/.bun/install/cache`.

For one configurable URL in managed dotfiles, set `NPM_AGE_PROXY_URL` in a shell env file (e.g. `~/.zshenv`) and use `registry=${NPM_AGE_PROXY_URL}` in `.npmrc`. `http_proxy`/`https_proxy`/`all_proxy` are unrelated — see `examples/shell-env.sh`.

## Development

```bash
bun install
bun test           # unit tests, mocked fetch
bun run typecheck  # tsc --noEmit
bun run dev        # hot-reload server, for editing the code
```

## License

MIT — see [LICENSE](./LICENSE).
