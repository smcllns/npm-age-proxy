# npm-age-proxy

A tiny local HTTP proxy that sits in front of `registry.npmjs.org` and refuses to serve npm package versions younger than `MIN_AGE_DAYS` days. It filters fresh versions out of packument JSON responses, rewrites `dist-tags` to point at the most-recent allowed version, rewrites upstream tarball URLs back through the proxy, and returns 403 for tarball requests targeting fresh versions. One proxy can cover npm-registry traffic from tools on the machine — `npm`, `pnpm`, `bun`, `yarn`, `npx`, `bunx`, `pnpm dlx` — as long as those tools are configured to use it as their registry.

## Why

npm supply-chain attacks often rely on getting malicious code into a published version and then having you install it before the ecosystem catches up. A 7-day age gate closes the fast-detection window for compromised-maintainer attacks. It does not help against typosquats, long-dwell backdoors, compromised old versions, or anything that has aged past the cutoff.

Native age-gate flags exist in some tools (pnpm `minimumReleaseAge`, bun `minimumReleaseAge`) but coverage is uneven, syntax differs per tool, and `bunx`/`npx` bypass package.json settings entirely. A single registry proxy fixes that for npm-registry resolution.

Tradeoffs:
- Fresh hotfix releases are blocked until they age past the cutoff unless their scope is allowlisted.
- Local dev and CI can drift if CI is not configured to use the same proxy.
- Peer-dependency resolution can fail when one package version is old enough and its required peer is still too fresh.

## Quick start

```bash
git clone https://github.com/smcllns/npm-age-proxy.git
cd npm-age-proxy
bun install

# Create an allowlist (scopes you publish or trust unconditionally)
mkdir -p ~/.config/npm-age-proxy
cp examples/allowlist.txt ~/.config/npm-age-proxy/allowlist.txt
# Edit to taste — one scope per line.

# Run it
bun run start
# → [npm-age-proxy] listening on http://127.0.0.1:8765/ (min-age=7d, ...)
```

Point npm and pnpm at the proxy by adding to `~/.npmrc`:

```
registry=http://127.0.0.1:8765/
```

Point Bun at the proxy by adding to `~/.bunfig.toml`:

```toml
[install]
registry = "http://127.0.0.1:8765/"
```

Wipe pre-existing caches so already-resolved fresh versions aren't reused:

```bash
npm cache clean --force
pnpm store prune 2>/dev/null || true
rm -rf ~/.bun/install/cache
```

That's the install. From now on npm-registry installs from those clients go through the proxy.

## Machine-wide client config

For a machine or agent host, the durable config is:

| File | Covers | Contents |
|------|--------|----------|
| `~/.npmrc` | npm, pnpm, and npm-compatible registry clients | `examples/npmrc` |
| `~/.bunfig.toml` | Bun package installs and Bun auto-installs | `examples/bunfig.toml` |

Merge these examples into existing files rather than blindly replacing private-registry credentials or project-specific settings. On a fresh profile, copying them is enough:

```bash
cp examples/npmrc ~/.npmrc
cp examples/bunfig.toml ~/.bunfig.toml
```

If you want one configurable URL in managed dotfiles, set `NPM_AGE_PROXY_URL` in a shell env file such as `~/.zshenv`, then use `registry=${NPM_AGE_PROXY_URL}` in `.npmrc`. Bun's global `bunfig.toml` should use a literal URL unless you have verified your Bun version expands env vars for `[install].registry`.

`http_proxy`, `https_proxy`, and `all_proxy` are a different mechanism. They are useful for routing `curl`, `wget`, `rustup`, or `uv` installer downloads through a generic forward proxy, but `npm-age-proxy` is not that proxy. Do not set those variables to `http://127.0.0.1:8765/`; HTTPS installers expect a CONNECT-capable forward proxy, while this service only understands npm registry paths. See `examples/shell-env.sh` for the safe boundary.

## Configuration

| Env var | Default | Effect |
|---------|---------|--------|
| `PORT` | `8765` | Listen port |
| `HOST` | `127.0.0.1` | Listen host. Set `0.0.0.0` only if you intentionally want LAN access. |
| `MIN_AGE_DAYS` | `7` | Versions younger than this are blocked. `0` disables filtering. |
| `UPSTREAM` | `https://registry.npmjs.org` | Upstream registry URL |
| `ALLOWLIST_PATH` | `${XDG_CONFIG_HOME:-$HOME/.config}/npm-age-proxy/allowlist.txt` | Path to allowlist file |
| `MAX_PACKUMENT_BYTES` | `52428800` | Maximum packument JSON body size before failing closed. |
| `LOG_LEVEL` | `info` | `info` or `debug`. Debug adds upstream status + cache hit/miss. |

## Allowlist format

One scope per line. `@` prefix is optional (auto-added). Lines starting with `#` are comments; blank lines ignored. Inline comments after `#` are stripped.

```
# Sam's published scopes — bypass the age filter, pass through unmodified.
@smcllns
@atipicallabs
```

Reloads automatically while the proxy is running. If reload fails, the proxy keeps the last valid allowlist and logs a warning.

Any request whose path starts with `/<allowlisted-scope>/` passes through to the upstream registry without filtering or age-gating. Useful for your own scopes (publish + immediately install on the same machine) and for trusted internal scopes.

## What it does to each request

| Request | Behavior |
|---------|----------|
| `GET /<pkg>`, `GET /@scope/<pkg>`, or encoded scoped packuments like `GET /@scope%2fpkg` | Parse JSON, drop `versions[v]` where `time[v]` is missing, malformed, or within `MIN_AGE_DAYS` of now, rewrite `dist-tags.*` to point at the most-recent surviving version, and rewrite upstream `dist.tarball` URLs to this proxy. |
| `GET /<pkg>/-/<file>.tgz` (tarball) | Look up the version's publish time from cached packument or fetch fresh. 403 with explanation if too fresh; 502 if publish-time metadata is missing or malformed; stream the tarball through otherwise. |
| Anything else (`/-/v1/search`, audits, etc.) | Forward unmodified. |
| Path under an allowlisted scope | Forward unmodified, no filter, no age-check. |

The proxy is **fail-closed**: if upstream returns 5xx, the network call throws, the JSON is malformed or oversized, or publish-time metadata is missing, the proxy returns 502 rather than passing the response through. Better to interrupt the install than ship a packument we couldn't verify.

## Status endpoint

`GET /__status` returns JSON diagnostics:

```bash
curl http://127.0.0.1:8765/__status
```

It includes uptime, upstream URL, min age, cache size, allowlisted scopes, `MAX_PACKUMENT_BYTES`, and the most recent upstream error.

## Troubleshooting

### "I just published `@me/pkg` and `npm install` can't find the new version"

Add your scope to `~/.config/npm-age-proxy/allowlist.txt`. The proxy reloads the file automatically.

### Stale cached packument

The proxy keeps a 60s in-memory cache of packument time maps so tarball requests don't double-fetch. Wait 60s or restart the proxy.

### npm/pnpm/bun complains about TLS

The proxy listens on plain HTTP at `127.0.0.1`. npm-registry clients should accept the plain HTTP local registry without disabling TLS verification. Do not add `strict-ssl=false` machine-wide; that weakens TLS checks for other registry traffic.

### Bun has its own registry config

`bunfig.toml` can set `registry` independently of `.npmrc`. If you have one, either remove the explicit registry line or point it at the proxy. For global Bun coverage, use `~/.bunfig.toml` with the `[install]` registry shown above.

### Can this be used as `http_proxy` / `https_proxy`?

No. `npm-age-proxy` is a registry reverse proxy, not a generic HTTP(S) forward proxy. A curl installer using `https_proxy=http://127.0.0.1:8765/` will try to send CONNECT proxy traffic here, which this service intentionally does not handle.

### Logs

Every request logs one line:

```
2026-05-14T23:49:15.730Z GET /@types/node 200 103ms allow:@types
2026-05-14T23:49:21.467Z GET /next 200 76ms filtered:3766→3762
2026-05-14T23:50:02.114Z GET /next/-/next-16.3.0-canary.19.tgz 403 2ms block:fresh
2026-05-14T23:51:11.002Z GET /-/v1/search?text=foo 200 88ms pass
```

The note column tells you what the proxy decided: `filtered:N→M`, `allow:<scope>`, `block:fresh`, `status`, `pass`, `error:upstream`.

If you're running under launchd or systemd, the log goes to whatever you've configured for stdout.

## What this DOES NOT protect against

- **Postinstall scripts.** A 30-day-old package can still run malicious code in `postinstall`. Different defense surface (sandboxing). Out of scope.
- **Other ecosystems.** PyPI, crates.io, RubyGems, Go modules — different proxies, not this one.
- **`curl | sh` installers** (`bun`, `uv`, `rustup`, …). They don't go through the npm registry. You can route them through a separate forward proxy with `http_proxy`/`https_proxy`, but that is separate infrastructure and does not make this npm age filter inspect arbitrary HTTPS downloads.
- **Lockfile auditing.** This proxy gates resolution-time fetches; it doesn't audit lockfiles already on disk.
- **Typosquatting / known-CVE blocking / signature verification.** This is age-gating only. Possible future work.
- **CI environments.** GitHub Actions, etc. won't see this proxy. CI is generally ephemeral and re-verifies; consider gating in CI too if your threat model requires it.

## Development

```bash
bun install
bun test           # unit tests, mocked fetch
bun run typecheck  # tsc --noEmit
bun run dev        # hot-reload server
```

## License

MIT — see [LICENSE](./LICENSE).
