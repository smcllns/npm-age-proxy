/**
 * npm-age-proxy — a thin local HTTP proxy in front of registry.npmjs.org
 * that filters npm package versions younger than MIN_AGE_DAYS days.
 *
 * Spec + design notes: README.md and the locked plan that produced it.
 *
 * Public surface:
 *   - `startServer(config?)` — boots a Bun.serve listener on PORT.
 *   - `handleRequest(req, deps)` — pure(ish) request handler for tests.
 *   - `filterPackument(doc, opts)` — pure age-filter for packument JSON.
 *   - `parseAllowlist(text)` — pure allowlist parser.
 *   - `loadAllowlist(path)` — IO wrapper around parseAllowlist.
 *   - `createCache(ttlMs)` — small TTL cache used for tarball lookups.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- types ----------

export interface Packument {
  name?: string;
  versions?: Record<string, unknown>;
  time?: Record<string, string>;
  "dist-tags"?: Record<string, string>;
  [k: string]: unknown;
}

export interface FilterOptions {
  /** Versions whose publish time is >= cutoff are removed. */
  cutoff: Date;
}

export interface FilterResult {
  doc: Packument;
  kept: number;
  removed: number;
}

export interface CacheEntry {
  time: Record<string, string>;
  expiresAt: number;
}

export interface TtlCache {
  get(pkg: string): CacheEntry | undefined;
  set(pkg: string, entry: Omit<CacheEntry, "expiresAt">): void;
  delete(pkg: string): void;
  size(): number;
}

export interface HandlerDeps {
  fetchFn: typeof fetch;
  cache: TtlCache;
  allowlist: Set<string>;
  upstream: string;
  minAgeDays: number;
  now: () => Date;
  cacheTtlMs: number;
  log: (entry: LogEntry) => void;
  logLevel: "info" | "debug";
}

export interface LogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  note: string;
  upstreamStatus?: number;
  cache?: "hit" | "miss";
}

// ---------- pure helpers ----------

/**
 * Parses an allowlist file body into a set of scopes.
 * - One scope per line (with or without leading `@`; we normalize to include `@`).
 * - `#` introduces a comment for the remainder of the line.
 * - Blank/whitespace-only lines ignored.
 * - Case-sensitive (npm scopes are lowercase by registry rules; we don't lowercase to keep things explicit).
 */
export function parseAllowlist(text: string): Set<string> {
  const out = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const hashIdx = rawLine.indexOf("#");
    const line = (hashIdx === -1 ? rawLine : rawLine.slice(0, hashIdx)).trim();
    if (!line) continue;
    const scope = line.startsWith("@") ? line : `@${line}`;
    out.add(scope);
  }
  return out;
}

/**
 * Returns the most-recent version (by publish time) whose entry is still present
 * in `versions`. If none qualify, returns undefined.
 */
function pickMostRecentAllowed(
  versions: Record<string, unknown>,
  time: Record<string, string>,
): string | undefined {
  let best: { version: string; ts: number } | undefined;
  for (const v of Object.keys(versions)) {
    const t = time[v];
    if (!t) continue;
    const ts = Date.parse(t);
    if (Number.isNaN(ts)) continue;
    if (!best || ts > best.ts) best = { version: v, ts };
  }
  return best?.version;
}

/**
 * Filters a packument:
 *   - drops `versions[v]` where `time[v]` is >= cutoff (i.e. too fresh)
 *   - rewrites `dist-tags.*` to point at the most-recent surviving version
 *
 * If the packument lacks `.time`, returns the doc unchanged with kept/removed=-1.
 * Caller is responsible for logging a warning in that case.
 */
export function filterPackument(
  doc: Packument,
  opts: FilterOptions,
): FilterResult {
  if (!doc || typeof doc !== "object" || !doc.versions || !doc.time) {
    return { doc, kept: -1, removed: -1 };
  }
  const cutoffMs = opts.cutoff.getTime();
  const versions = doc.versions;
  const time = doc.time;

  const newVersions: Record<string, unknown> = {};
  const newTime: Record<string, string> = {};
  // `time` may include the meta keys `created` and `modified` plus per-version entries.
  // We preserve `created`/`modified` and only filter per-version entries.
  for (const [k, v] of Object.entries(time)) {
    if (k === "created" || k === "modified") {
      newTime[k] = v;
    }
  }
  let removed = 0;
  let kept = 0;
  for (const v of Object.keys(versions)) {
    const t = time[v];
    const versionData = versions[v];
    if (!t) {
      // No time entry for this version — fail-open (keep it).
      newVersions[v] = versionData;
      kept++;
      continue;
    }
    const ts = Date.parse(t);
    if (Number.isNaN(ts) || ts < cutoffMs) {
      newVersions[v] = versionData;
      newTime[v] = t;
      kept++;
    } else {
      removed++;
    }
  }

  const newDoc: Packument = { ...doc, versions: newVersions, time: newTime };

  const tags = doc["dist-tags"];
  if (tags && typeof tags === "object") {
    const newTags: Record<string, string> = {};
    const fallback = pickMostRecentAllowed(newVersions, newTime);
    for (const [tag, version] of Object.entries(tags)) {
      if (typeof version !== "string") continue;
      if (newVersions[version]) {
        newTags[tag] = version;
      } else if (fallback) {
        newTags[tag] = fallback;
      }
      // else: drop the tag entirely — no allowed version to point at.
    }
    newDoc["dist-tags"] = newTags;
  }

  return { doc: newDoc, kept, removed };
}

// ---------- cache ----------

export function createCache(ttlMs: number, now: () => Date = () => new Date()): TtlCache {
  const map = new Map<string, CacheEntry>();
  return {
    get(pkg) {
      const entry = map.get(pkg);
      if (!entry) return undefined;
      if (now().getTime() > entry.expiresAt) {
        map.delete(pkg);
        return undefined;
      }
      return entry;
    },
    set(pkg, entry) {
      map.set(pkg, { ...entry, expiresAt: now().getTime() + ttlMs });
    },
    delete(pkg) {
      map.delete(pkg);
    },
    size() {
      return map.size;
    },
  };
}

// ---------- URL parsing ----------

export interface ParsedPath {
  kind: "packument" | "tarball" | "other";
  /** The package name. For scoped, includes `@scope/`. */
  pkg?: string;
  /** Scope incl. `@` if scoped. Undefined for unscoped packages. */
  scope?: string;
  /** Version, only present for tarball requests. */
  version?: string;
  /** The tarball filename for tarball requests. */
  tarballFile?: string;
}

/**
 * Categorizes the request path. We accept paths like:
 *   /typescript
 *   /typescript/-/typescript-5.4.0.tgz
 *   /@scope/pkg
 *   /@scope/pkg/-/pkg-1.0.0.tgz
 *
 * Anything else (including `/-/all`, `/-/v1/security/audits/...`) maps to `other`.
 */
export function parsePath(pathname: string): ParsedPath {
  // Strip leading slash, ignore query string (caller passes pathname only).
  const segments = pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return { kind: "other" };

  // The registry uses `/-/` as a special segment for non-packument routes.
  // We only recognize it inside a package's tarball URL.
  const first = segments[0]!;
  if (first === "-") {
    return { kind: "other" };
  }

  let scope: string | undefined;
  let nameIdx = 0;
  if (first.startsWith("@")) {
    if (segments.length < 2) return { kind: "other" };
    scope = first;
    nameIdx = 1;
  }
  const name = segments[nameIdx];
  if (!name) return { kind: "other" };
  const pkg = scope ? `${scope}/${name}` : name;

  const rest = segments.slice(nameIdx + 1);

  if (rest.length === 0) {
    return { kind: "packument", pkg, scope };
  }

  // Tarball: /<pkg>/-/<file>
  if (rest[0] === "-" && rest.length === 2) {
    const tarballFile = rest[1]!;
    if (!tarballFile.endsWith(".tgz")) {
      return { kind: "other", pkg, scope };
    }
    // The basename used in the tarball URL is the unscoped package name.
    const expectedBase = name;
    if (!tarballFile.startsWith(`${expectedBase}-`)) {
      return { kind: "other", pkg, scope };
    }
    const version = tarballFile.slice(expectedBase.length + 1, tarballFile.length - ".tgz".length);
    if (!version) {
      return { kind: "other", pkg, scope };
    }
    return { kind: "tarball", pkg, scope, version, tarballFile };
  }

  return { kind: "other", pkg, scope };
}

// ---------- IO ----------

export function defaultAllowlistPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "npm-age-proxy", "allowlist.txt");
}

export async function loadAllowlist(path: string): Promise<{
  scopes: Set<string>;
  loaded: boolean;
  error?: string;
}> {
  try {
    const text = await readFile(path, "utf8");
    return { scopes: parseAllowlist(text), loaded: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { scopes: new Set(), loaded: false, error: "missing" };
    }
    return { scopes: new Set(), loaded: false, error: e.message };
  }
}

// ---------- handler ----------

const BLOCK_BODY = (pkg: string, version: string, ageDays: number, minAgeDays: number) =>
  `npm-age-proxy: refusing to serve ${pkg}@${version} — ` +
  `published ${ageDays.toFixed(1)} days ago (minimum age is ${minAgeDays} days).\n` +
  `Use an older version, wait, or add the scope to allowlist.txt to bypass.\n`;

const UPSTREAM_ERROR_BODY = (path: string, detail: string) =>
  `npm-age-proxy: upstream error for ${path}: ${detail}\n` +
  `Proxy is fail-closed; aborting to avoid installing unverified packages.\n`;

export async function handleRequest(req: Request, deps: HandlerDeps): Promise<Response> {
  const started = performance.now();
  const url = new URL(req.url);
  const path = url.pathname;
  const upstreamUrl = `${deps.upstream.replace(/\/$/, "")}${path}${url.search}`;

  const finish = (status: number, note: string, body: Bun.BodyInit | null, headers?: Bun.HeadersInit, extra?: Partial<LogEntry>): Response => {
    const durationMs = Math.round(performance.now() - started);
    deps.log({ method: req.method, path, status, durationMs, note, ...extra });
    return new Response(body as BodyInit | null, { status, headers: headers as HeadersInit | undefined });
  };

  const parsed = parsePath(path);
  const isRead = req.method === "GET" || req.method === "HEAD";

  // Allowlist short-circuit: any path whose scope is allowlisted passes through.
  if (parsed.scope && deps.allowlist.has(parsed.scope)) {
    try {
      const upstreamRes = await forwardUpstream(req, deps.fetchFn, upstreamUrl);
      return finish(
        upstreamRes.status,
        `allow:${parsed.scope}`,
        upstreamRes.body,
        upstreamRes.headers,
        { upstreamStatus: upstreamRes.status },
      );
    } catch (err) {
      return finish(
        502,
        "error:upstream",
        UPSTREAM_ERROR_BODY(path, (err as Error).message),
        { "content-type": "text/plain" },
      );
    }
  }

  // Non-read methods (PUT/POST/PATCH/DELETE) on packument/tarball paths are
  // publishes/unpublishes; they must not be filtered. Fall through to passthrough.
  if (isRead && parsed.kind === "tarball") {
    return handleTarball(req, deps, parsed, upstreamUrl, finish);
  }

  if (isRead && parsed.kind === "packument") {
    return handlePackument(req, deps, parsed, upstreamUrl, finish);
  }

  // `other` (or non-read on packument/tarball) — proxy through untouched.
  try {
    const upstreamRes = await forwardUpstream(req, deps.fetchFn, upstreamUrl);
    return finish(
      upstreamRes.status,
      "pass",
      upstreamRes.body,
      upstreamRes.headers,
      { upstreamStatus: upstreamRes.status },
    );
  } catch (err) {
    return finish(
      502,
      "error:upstream",
      UPSTREAM_ERROR_BODY(path, (err as Error).message),
      { "content-type": "text/plain" },
    );
  }
}

// Forwards a request to upstream with method, hop-by-hop-filtered headers, and
// body (for non-GET/HEAD). Bun's fetch requires `duplex: "half"` to stream a
// ReadableStream body.
function forwardUpstream(req: Request, fetchFn: typeof fetch, upstreamUrl: string): Promise<Response> {
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: stripHopByHop(req.headers),
  };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    init.body = req.body;
    init.duplex = "half";
  }
  return fetchFn(upstreamUrl, init);
}

function stripHopByHop(h: Headers): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "accept-encoding") return;
    out.set(k, v);
  });
  // Ask upstream for identity encoding so we don't have to re-encode JSON bodies.
  out.set("accept-encoding", "identity");
  return out;
}

async function handlePackument(
  _req: Request,
  deps: HandlerDeps,
  parsed: ParsedPath,
  upstreamUrl: string,
  finish: (status: number, note: string, body: Bun.BodyInit | null, headers?: Bun.HeadersInit, extra?: Partial<LogEntry>) => Response,
): Promise<Response> {
  let upstreamRes: Response;
  try {
    upstreamRes = await deps.fetchFn(upstreamUrl, {
      headers: { accept: "application/json", "accept-encoding": "identity" },
    });
  } catch (err) {
    return finish(
      502,
      "error:upstream",
      UPSTREAM_ERROR_BODY(upstreamUrl, (err as Error).message),
      { "content-type": "text/plain" },
    );
  }

  if (upstreamRes.status >= 500) {
    return finish(
      502,
      "error:upstream",
      UPSTREAM_ERROR_BODY(upstreamUrl, `status ${upstreamRes.status}`),
      { "content-type": "text/plain" },
      { upstreamStatus: upstreamRes.status },
    );
  }

  // Pass non-2xx (e.g. 404) straight through; nothing to filter.
  if (!upstreamRes.ok) {
    return finish(
      upstreamRes.status,
      "pass",
      upstreamRes.body,
      upstreamRes.headers,
      { upstreamStatus: upstreamRes.status },
    );
  }

  const ct = upstreamRes.headers.get("content-type") || "";
  if (!ct.includes("json")) {
    return finish(
      upstreamRes.status,
      "pass",
      upstreamRes.body,
      upstreamRes.headers,
      { upstreamStatus: upstreamRes.status },
    );
  }

  const rawText = await upstreamRes.text();
  let doc: Packument;
  try {
    doc = JSON.parse(rawText) as Packument;
  } catch (err) {
    return finish(
      502,
      "error:upstream",
      UPSTREAM_ERROR_BODY(upstreamUrl, `malformed JSON: ${(err as Error).message}`),
      { "content-type": "text/plain" },
      { upstreamStatus: upstreamRes.status },
    );
  }

  if (!doc.time) {
    // Pass through unfiltered + log warning.
    return finish(
      upstreamRes.status,
      "pass:no-time",
      rawText,
      { "content-type": "application/json" },
      { upstreamStatus: upstreamRes.status },
    );
  }

  const cutoff = new Date(deps.now().getTime() - deps.minAgeDays * 86_400_000);
  const result = filterPackument(doc, { cutoff });

  // Cache the filtered time map so tarball checks for this package don't re-fetch.
  if (parsed.pkg && result.doc.time) {
    // We deliberately cache the *original* time map (pre-filter) so tarball
    // requests for a specific version can be evaluated against publish time.
    deps.cache.set(parsed.pkg, { time: doc.time });
  }

  const body = JSON.stringify(result.doc);
  const headers = new Headers(upstreamRes.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("content-encoding");

  return finish(
    200,
    `filtered:${result.kept + result.removed}→${result.kept}`,
    body,
    headers,
    { upstreamStatus: upstreamRes.status },
  );
}

async function handleTarball(
  req: Request,
  deps: HandlerDeps,
  parsed: ParsedPath,
  upstreamUrl: string,
  finish: (status: number, note: string, body: Bun.BodyInit | null, headers?: Bun.HeadersInit, extra?: Partial<LogEntry>) => Response,
): Promise<Response> {
  const pkg = parsed.pkg!;
  const version = parsed.version!;

  let timeMap = deps.cache.get(pkg)?.time;
  let cacheNote: "hit" | "miss" = "hit";
  if (!timeMap) {
    cacheNote = "miss";
    const packumentUrl = `${deps.upstream.replace(/\/$/, "")}/${pkg}`;
    let pkRes: Response;
    try {
      pkRes = await deps.fetchFn(packumentUrl, {
        headers: { accept: "application/json", "accept-encoding": "identity" },
      });
    } catch (err) {
      return finish(
        502,
        "error:upstream",
        UPSTREAM_ERROR_BODY(packumentUrl, (err as Error).message),
        { "content-type": "text/plain" },
      );
    }
    if (!pkRes.ok) {
      return finish(
        502,
        "error:upstream",
        UPSTREAM_ERROR_BODY(packumentUrl, `status ${pkRes.status}`),
        { "content-type": "text/plain" },
        { upstreamStatus: pkRes.status },
      );
    }
    let pkDoc: Packument;
    try {
      pkDoc = (await pkRes.json()) as Packument;
    } catch (err) {
      return finish(
        502,
        "error:upstream",
        UPSTREAM_ERROR_BODY(packumentUrl, `malformed JSON: ${(err as Error).message}`),
        { "content-type": "text/plain" },
      );
    }
    if (!pkDoc.time) {
      // No publish data — fail-open by passing the tarball through.
      return streamTarball(req, deps, upstreamUrl, finish, cacheNote);
    }
    timeMap = pkDoc.time;
    deps.cache.set(pkg, { time: timeMap });
  }

  const publishedAt = timeMap[version];
  if (!publishedAt) {
    return finish(
      502,
      "error:upstream",
      UPSTREAM_ERROR_BODY(upstreamUrl, `version ${version} not in packument`),
      { "content-type": "text/plain" },
      { cache: cacheNote },
    );
  }

  const publishedMs = Date.parse(publishedAt);
  if (Number.isNaN(publishedMs)) {
    return streamTarball(req, deps, upstreamUrl, finish, cacheNote);
  }

  const ageMs = deps.now().getTime() - publishedMs;
  const ageDays = ageMs / 86_400_000;
  const minMs = deps.minAgeDays * 86_400_000;

  if (ageMs < minMs) {
    return finish(
      403,
      "block:fresh",
      BLOCK_BODY(pkg, version, ageDays, deps.minAgeDays),
      { "content-type": "text/plain" },
      { cache: cacheNote },
    );
  }

  return streamTarball(req, deps, upstreamUrl, finish, cacheNote);
}

async function streamTarball(
  req: Request,
  deps: HandlerDeps,
  upstreamUrl: string,
  finish: (status: number, note: string, body: Bun.BodyInit | null, headers?: Bun.HeadersInit, extra?: Partial<LogEntry>) => Response,
  cacheNote: "hit" | "miss",
): Promise<Response> {
  try {
    const upstreamRes = await forwardUpstream(req, deps.fetchFn, upstreamUrl);
    return finish(
      upstreamRes.status,
      "pass",
      upstreamRes.body,
      upstreamRes.headers,
      { upstreamStatus: upstreamRes.status, cache: cacheNote },
    );
  } catch (err) {
    return finish(
      502,
      "error:upstream",
      UPSTREAM_ERROR_BODY(upstreamUrl, (err as Error).message),
      { "content-type": "text/plain" },
    );
  }
}

// ---------- entrypoint ----------

export interface ServerConfig {
  port?: number;
  upstream?: string;
  allowlistPath?: string;
  minAgeDays?: number;
  cacheTtlMs?: number;
  logLevel?: "info" | "debug";
}

function parseNonNegativeNumber(name: string, raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`[npm-age-proxy] ${name} must be a non-negative finite number, got: ${String(raw)}`);
  }
  return n;
}

export async function startServer(config: ServerConfig = {}) {
  const port = parseNonNegativeNumber("PORT", config.port ?? process.env.PORT, 8765);
  const upstream = config.upstream ?? process.env.UPSTREAM ?? "https://registry.npmjs.org";
  const allowlistPath = config.allowlistPath ?? process.env.ALLOWLIST_PATH ?? defaultAllowlistPath();
  const minAgeDays = parseNonNegativeNumber("MIN_AGE_DAYS", config.minAgeDays ?? process.env.MIN_AGE_DAYS, 7);
  const cacheTtlMs = parseNonNegativeNumber("CACHE_TTL_MS", config.cacheTtlMs ?? process.env.CACHE_TTL_MS, 60_000);
  const logLevel = config.logLevel ?? ((process.env.LOG_LEVEL ?? "info") as "info" | "debug");

  const allowlist = await loadAllowlist(allowlistPath);
  if (!allowlist.loaded) {
    console.warn(`[npm-age-proxy] allowlist not loaded at ${allowlistPath} (${allowlist.error ?? "unknown"}); no scopes will bypass`);
  } else {
    console.log(`[npm-age-proxy] allowlist loaded: ${[...allowlist.scopes].join(", ") || "(empty)"}`);
  }

  const cache = createCache(cacheTtlMs);

  const deps: HandlerDeps = {
    fetchFn: fetch,
    cache,
    allowlist: allowlist.scopes,
    upstream,
    minAgeDays,
    now: () => new Date(),
    cacheTtlMs,
    logLevel,
    log: makeLogger(logLevel),
  };

  const server = Bun.serve({
    port,
    fetch: (req) => handleRequest(req, deps),
  });

  console.log(
    `[npm-age-proxy] listening on http://${server.hostname}:${server.port}/ ` +
    `(min-age=${minAgeDays}d, upstream=${upstream}, ttl=${cacheTtlMs}ms)`,
  );
  return server;
}

export function makeLogger(level: "info" | "debug"): (entry: LogEntry) => void {
  return (entry) => {
    const ts = new Date().toISOString();
    const base = `${ts} ${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms ${entry.note}`;
    if (level === "debug") {
      const extras: string[] = [];
      if (entry.upstreamStatus !== undefined) extras.push(`upstream=${entry.upstreamStatus}`);
      if (entry.cache !== undefined) extras.push(`cache=${entry.cache}`);
      console.log(extras.length ? `${base} ${extras.join(" ")}` : base);
    } else {
      console.log(base);
    }
  };
}

// Only auto-start when invoked directly (not when imported by the test suite).
if (import.meta.main) {
  startServer().catch((err) => {
    console.error("[npm-age-proxy] fatal:", err);
    process.exit(1);
  });
}
