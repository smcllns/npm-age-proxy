# npm-age-proxy

A tiny local HTTP proxy that sits in front of `registry.npmjs.org` and refuses to serve npm package versions younger than `MIN_AGE_DAYS` days. It filters fresh versions out of packument JSON responses, rewrites `dist-tags` to point at the most-recent allowed version, and returns 403 for tarball requests targeting fresh versions. One proxy covers every npm-ecosystem tool on the machine — `npm`, `pnpm`, `bun`, `yarn`, `npx`, `bunx`, `pnpm dlx` — through one `~/.npmrc` line.

## Why

npm supply-chain attacks rely on getting malicious code into a published version and then having you install it within hours. A 7-day age gate eliminates almost the entire window of fresh-malware exposure while costing essentially nothing in developer experience. Native age-gate flags exist in some tools (pnpm `minimumReleaseAge`, bun `minimumReleaseAge`) but coverage is uneven, syntax differs per tool, and `bunx`/`npx` bypass package.json settings entirely. A single proxy fixes all of that at the network layer.

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
# → [npm-age-proxy] listening on http://localhost:8765/ (min-age=7d, ...)
```

Point npm at the proxy by adding to `~/.npmrc`:

```
registry=http://localhost:8765/
strict-ssl=false
```

Wipe pre-existing caches so already-resolved fresh versions aren't reused:

```bash
npm cache clean --force
pnpm store prune 2>/dev/null || true
rm -rf ~/.bun/install/cache
```

That's the install. From now on every install goes through the proxy.

## Configuration

| Env var | Default | Effect |
|---------|---------|--------|
| `PORT` | `8765` | Listen port |
| `MIN_AGE_DAYS` | `7` | Versions younger than this are blocked. `0` disables filtering. |
| `UPSTREAM` | `https://registry.npmjs.org` | Upstream registry URL |
| `ALLOWLIST_PATH` | `${XDG_CONFIG_HOME:-$HOME/.config}/npm-age-proxy/allowlist.txt` | Path to allowlist file |
| `LOG_LEVEL` | `info` | `info` or `debug`. Debug adds upstream status + cache hit/miss. |

## Allowlist format

One scope per line. `@` prefix is optional (auto-added). Lines starting with `#` are comments; blank lines ignored. Inline comments after `#` are stripped.

```
# Sam's published scopes — bypass the age filter, pass through unmodified.
@smcllns
@atipicallabs
```

Reloads only at startup. To pick up changes, restart the proxy.

Any request whose path starts with `/<allowlisted-scope>/` passes through to the upstream registry without filtering or age-gating. Useful for your own scopes (publish + immediately install on the same machine) and for trusted internal scopes.

## What it does to each request

| Request | Behavior |
|---------|----------|
| `GET /<pkg>` or `GET /@scope/<pkg>` (packument JSON) | Parse JSON, drop `versions[v]` where `time[v]` is within `MIN_AGE_DAYS` of now, rewrite `dist-tags.*` to point at the most-recent surviving version. |
| `GET /<pkg>/-/<file>.tgz` (tarball) | Look up the version's publish time from cached packument or fetch fresh. 403 with explanation if too fresh; stream the tarball through otherwise. |
| Anything else (`/-/v1/search`, audits, etc.) | Forward unmodified. |
| Path under an allowlisted scope | Forward unmodified, no filter, no age-check. |

The proxy is **fail-closed**: if upstream returns 5xx, the network call throws, or the JSON is malformed, the proxy returns 502 rather than passing the response through. Better to interrupt the install than ship a packument we couldn't filter.

## Troubleshooting

### "I just published `@me/pkg` and `npm install` can't find the new version"

Add your scope to `~/.config/npm-age-proxy/allowlist.txt`, then restart the proxy.

### Stale cached packument

The proxy keeps a 60s in-memory cache of packument time maps so tarball requests don't double-fetch. Wait 60s or restart the proxy.

### npm/pnpm/bun complains about an unverified TLS cert

The proxy listens on plain HTTP. Add `strict-ssl=false` to `~/.npmrc` (or the equivalent for your tool). This silences the warning for the localhost route only — when the proxy forwards upstream, it still uses HTTPS.

### Bun has its own registry config

`bunfig.toml` can set `registry` independently of `.npmrc`. If you have one, either remove the explicit registry line or point it at the proxy. `.npmrc` is the standard cross-tool config.

### Logs

Every request logs one line:

```
2026-05-14T23:49:15.730Z GET /@types/node 200 103ms allow:@types
2026-05-14T23:49:21.467Z GET /next 200 76ms filtered:3766→3762
2026-05-14T23:50:02.114Z GET /next/-/next-16.3.0-canary.19.tgz 403 2ms block:fresh
2026-05-14T23:51:11.002Z GET /-/v1/search?text=foo 200 88ms pass
```

The note column tells you what the proxy decided: `filtered:N→M`, `allow:<scope>`, `block:fresh`, `pass`, `pass:no-time`, `error:upstream`.

If you're running under launchd or systemd, the log goes to whatever you've configured for stdout.

## What this DOES NOT protect against

- **Postinstall scripts.** A 30-day-old package can still run malicious code in `postinstall`. Different defense surface (sandboxing). Out of scope.
- **Other ecosystems.** PyPI, crates.io, RubyGems, Go modules — different proxies, not this one.
- **`curl | sh` installers** (`bun`, `uv`, `rustup`, …). They don't go through the npm registry.
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
