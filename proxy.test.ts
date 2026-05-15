import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterPackument,
  rewriteTarballUrls,
  parseAllowlist,
  parsePath,
  createCache,
  handleRequest,
  makeLogger,
  startServer,
  type HandlerDeps,
  type Packument,
  type LogEntry,
} from "./proxy";

// ---------- helpers ----------

const DAY = 86_400_000;

/** Fixed reference clock for deterministic age math. */
const NOW = new Date("2026-05-14T12:00:00.000Z");
const now = () => NOW;

function isoDaysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY).toISOString();
}

function makePackument(versions: Record<string, number>): Packument {
  // `versions` is `version → daysAgo` for ergonomic test setup.
  const versionMap: Record<string, unknown> = {};
  const timeMap: Record<string, string> = {
    created: isoDaysAgo(1000),
    modified: isoDaysAgo(0.01),
  };
  for (const [v, daysAgo] of Object.entries(versions)) {
    versionMap[v] = { name: "demo", version: v, dist: { tarball: `https://example/demo-${v}.tgz` } };
    timeMap[v] = isoDaysAgo(daysAgo);
  }
  return {
    name: "demo",
    versions: versionMap,
    time: timeMap,
    "dist-tags": { latest: Object.keys(versions).pop()! },
  };
}

interface MockResponseSpec {
  status?: number;
  body: string | Uint8Array;
  headers?: Record<string, string>;
}

function mockJson(doc: unknown, status = 200, headers: Record<string, string> = {}): MockResponseSpec {
  return {
    status,
    body: JSON.stringify(doc),
    headers: { "content-type": "application/json", ...headers },
  };
}

function mockBinary(body: Uint8Array, status = 200): MockResponseSpec {
  return {
    status,
    body,
    headers: { "content-type": "application/octet-stream" },
  };
}

function mockError(): "throw" {
  return "throw";
}

interface UpstreamCall {
  url: string;
  method: string;
  body: string | null;
}

function makeFetchMock(routes: Map<string, MockResponseSpec | "throw">): {
  fetch: typeof fetch;
  calls: string[];
  inits: UpstreamCall[];
} {
  const calls: string[] = [];
  const inits: UpstreamCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    let body: string | null = null;
    if (init?.body) {
      if (typeof init.body === "string") body = init.body;
      else if (init.body instanceof ReadableStream) body = await new Response(init.body).text();
      else body = await new Response(init.body as BodyInit).text();
    }
    inits.push({ url, method: init?.method ?? "GET", body });
    const spec = routes.get(url);
    if (!spec) {
      return new Response(`mock: no route for ${url}`, { status: 599 });
    }
    if (spec === "throw") {
      throw new Error(`mock: network error for ${url}`);
    }
    const respBody: BodyInit = typeof spec.body === "string" ? spec.body : (spec.body.buffer as ArrayBuffer);
    return new Response(respBody, {
      status: spec.status ?? 200,
      headers: spec.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls, inits };
}

interface RigOpts {
  routes: Map<string, MockResponseSpec | "throw">;
  allowlist?: Set<string>;
  minAgeDays?: number;
  cacheTtlMs?: number;
  maxPackumentBytes?: number;
  cacheClock?: () => Date;
}

function makeRig(opts: RigOpts): {
  deps: HandlerDeps;
  logs: LogEntry[];
  calls: string[];
  inits: UpstreamCall[];
} {
  const logs: LogEntry[] = [];
  const { fetch: fetchFn, calls, inits } = makeFetchMock(opts.routes);
  const deps: HandlerDeps = {
    fetchFn,
    cache: createCache(opts.cacheTtlMs ?? 60_000, opts.cacheClock ?? now),
    allowlist: opts.allowlist ?? new Set(),
    upstream: "https://registry.npmjs.org",
    minAgeDays: opts.minAgeDays ?? 7,
    maxPackumentBytes: opts.maxPackumentBytes ?? 50 * 1024 * 1024,
    now,
    cacheTtlMs: opts.cacheTtlMs ?? 60_000,
    log: (e) => logs.push(e),
    logLevel: "info",
    status: { startedAt: NOW, allowlistPath: "/tmp/allowlist.txt" },
  };
  return { deps, logs, calls, inits };
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition timed out");
}

const UPSTREAM = "https://registry.npmjs.org";

// ---------- packument filtering ----------

describe("filterPackument", () => {
  test("removes versions published within the cutoff window", () => {
    const doc = makePackument({ "1.0.0": 30, "1.1.0": 14, "1.2.0": 3 });
    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    const result = filterPackument(doc, { cutoff });

    expect(Object.keys(result.doc.versions!).sort()).toEqual(["1.0.0", "1.1.0"]);
    expect(result.doc.time!["1.2.0"]).toBeUndefined();
    expect(result.kept).toBe(2);
    expect(result.removed).toBe(1);
  });

  test("keeps versions older than the cutoff window", () => {
    const doc = makePackument({ "1.0.0": 30, "1.1.0": 14 });
    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    const result = filterPackument(doc, { cutoff });
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(2);
  });

  test("rewrites dist-tags.latest when it points at a filtered version", () => {
    const doc = makePackument({ "1.0.0": 30, "1.1.0": 14, "1.2.0-beta": 3 });
    doc["dist-tags"] = { latest: "1.2.0-beta", next: "1.2.0-beta" };
    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    const result = filterPackument(doc, { cutoff });
    expect(result.doc["dist-tags"]!.latest).toBe("1.1.0");
    expect(result.doc["dist-tags"]!.next).toBe("1.1.0");
  });

  test("preserves dist-tags that already point at allowed versions", () => {
    const doc = makePackument({ "1.0.0": 30, "1.1.0": 14, "1.2.0": 3 });
    doc["dist-tags"] = { latest: "1.2.0", lts: "1.0.0" };
    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    const result = filterPackument(doc, { cutoff });
    expect(result.doc["dist-tags"]!.latest).toBe("1.1.0");
    expect(result.doc["dist-tags"]!.lts).toBe("1.0.0");
  });

  test("prefers stable fallback for latest when an allowed prerelease is newer", () => {
    const doc = makePackument({ "1.0.0": 30, "2.0.0-beta.1": 14, "2.0.0": 3 });
    doc["dist-tags"] = { latest: "2.0.0", next: "2.0.0" };
    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    const result = filterPackument(doc, { cutoff });
    expect(result.doc["dist-tags"]!.latest).toBe("1.0.0");
    expect(result.doc["dist-tags"]!.next).toBe("2.0.0-beta.1");
  });

  test("preserves created/modified meta keys in time map", () => {
    const doc = makePackument({ "1.0.0": 30 });
    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    const result = filterPackument(doc, { cutoff });
    expect(result.doc.time!.created).toBeDefined();
    expect(result.doc.time!.modified).toBeDefined();
  });

  test("drops versions with missing publish time", () => {
    const doc = makePackument({ "1.0.0": 30, "1.1.0": 14 });
    delete doc.time!["1.1.0"];
    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    const result = filterPackument(doc, { cutoff });
    expect(Object.keys(result.doc.versions!)).toEqual(["1.0.0"]);
    expect(result.removed).toBe(1);
  });

  test("drops versions with malformed publish time", () => {
    const doc = makePackument({ "1.0.0": 30, "1.1.0": 14 });
    doc.time!["1.1.0"] = "not-a-date";
    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    const result = filterPackument(doc, { cutoff });
    expect(Object.keys(result.doc.versions!)).toEqual(["1.0.0"]);
    expect(result.removed).toBe(1);
  });

  test("returns doc unchanged with kept=-1 when .time is missing", () => {
    const doc: Packument = { name: "demo", versions: { "1.0.0": {} } };
    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    const result = filterPackument(doc, { cutoff });
    expect(result.kept).toBe(-1);
    expect(result.removed).toBe(-1);
    expect(result.doc).toBe(doc);
  });

  test("handles empty versions object without crashing", () => {
    const doc: Packument = { name: "demo", versions: {}, time: { created: isoDaysAgo(100), modified: isoDaysAgo(50) } };
    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    const result = filterPackument(doc, { cutoff });
    expect(result.kept).toBe(0);
    expect(result.removed).toBe(0);
    expect(Object.keys(result.doc.versions!)).toHaveLength(0);
  });
});

// ---------- parsePath ----------

describe("parsePath", () => {
  test("recognizes unscoped packument", () => {
    expect(parsePath("/typescript")).toEqual({ kind: "packument", pkg: "typescript", scope: undefined });
  });
  test("recognizes scoped packument", () => {
    expect(parsePath("/@smcllns/gmail")).toEqual({ kind: "packument", pkg: "@smcllns/gmail", scope: "@smcllns" });
  });
  test("recognizes encoded scoped packument", () => {
    expect(parsePath("/@smcllns%2fgmail")).toEqual({ kind: "packument", pkg: "@smcllns/gmail", scope: "@smcllns" });
  });
  test("recognizes unscoped tarball", () => {
    const p = parsePath("/typescript/-/typescript-5.4.0.tgz");
    expect(p.kind).toBe("tarball");
    expect(p.pkg).toBe("typescript");
    expect(p.version).toBe("5.4.0");
  });
  test("recognizes scoped tarball", () => {
    const p = parsePath("/@smcllns/gmail/-/gmail-1.0.0.tgz");
    expect(p.kind).toBe("tarball");
    expect(p.pkg).toBe("@smcllns/gmail");
    expect(p.scope).toBe("@smcllns");
    expect(p.version).toBe("1.0.0");
  });
  test("recognizes encoded scoped tarball", () => {
    const p = parsePath("/@smcllns%2fgmail/-/gmail-1.0.0.tgz");
    expect(p.kind).toBe("tarball");
    expect(p.pkg).toBe("@smcllns/gmail");
    expect(p.scope).toBe("@smcllns");
    expect(p.version).toBe("1.0.0");
  });
  test("treats top-level /-/all as other", () => {
    expect(parsePath("/-/all").kind).toBe("other");
  });
  test("treats malformed tarball names as other", () => {
    expect(parsePath("/typescript/-/wrong-5.4.0.tgz").kind).toBe("other");
  });
  test("treats loose package-name prefix matches as other", () => {
    expect(parsePath("/lodash/-/lodash-es-1.0.0.tgz").kind).toBe("other");
  });
  test("ignores empty path", () => {
    expect(parsePath("/").kind).toBe("other");
  });
});

// ---------- allowlist parsing ----------

describe("parseAllowlist", () => {
  test("parses one scope per line with @ prefix", () => {
    const out = parseAllowlist("@smcllns\n@atipicallabs\n");
    expect(out.has("@smcllns")).toBeTrue();
    expect(out.has("@atipicallabs")).toBeTrue();
    expect(out.size).toBe(2);
  });
  test("ignores blank lines and # comments", () => {
    const text = `
# header comment
@smcllns
  # indented comment

@atipicallabs # inline comment
`;
    const out = parseAllowlist(text);
    expect(out.size).toBe(2);
    expect(out.has("@smcllns")).toBeTrue();
    expect(out.has("@atipicallabs")).toBeTrue();
  });
  test("auto-prefixes @ when missing", () => {
    const out = parseAllowlist("smcllns");
    expect(out.has("@smcllns")).toBeTrue();
  });
  test("empty file produces empty set", () => {
    expect(parseAllowlist("").size).toBe(0);
    expect(parseAllowlist("\n\n   \n# comment only").size).toBe(0);
  });
});

// ---------- cache ----------

describe("createCache", () => {
  test("returns set entry within TTL", () => {
    const c = createCache(60_000, now);
    c.set("demo", { time: { "1.0.0": isoDaysAgo(30) } });
    expect(c.get("demo")?.time["1.0.0"]).toBeDefined();
  });
  test("expires entry after TTL", () => {
    let clock = new Date(NOW);
    const c = createCache(1000, () => clock);
    c.set("demo", { time: { "1.0.0": isoDaysAgo(30) } });
    expect(c.get("demo")).toBeDefined();
    clock = new Date(NOW.getTime() + 2000);
    expect(c.get("demo")).toBeUndefined();
    expect(c.size()).toBe(0);
  });
  test("delete removes entry", () => {
    const c = createCache(60_000, now);
    c.set("demo", { time: {} });
    c.delete("demo");
    expect(c.get("demo")).toBeUndefined();
  });
});

// ---------- tarball URL rewriting ----------

describe("rewriteTarballUrls", () => {
  test("rewrites upstream tarball URLs to the proxy registry origin", () => {
    const doc = makePackument({ "1.0.0": 30 });
    const version = doc.versions!["1.0.0"] as { dist: { tarball: string } };
    version.dist.tarball = `${UPSTREAM}/demo/-/demo-1.0.0.tgz`;

    const rewritten = rewriteTarballUrls(doc, {
      upstream: UPSTREAM,
      registryBase: "http://localhost:8765",
    });

    const rewrittenVersion = rewritten.versions!["1.0.0"] as { dist: { tarball: string } };
    expect(rewrittenVersion.dist.tarball).toBe("http://localhost:8765/demo/-/demo-1.0.0.tgz");
  });

  test("leaves non-upstream tarball URLs alone", () => {
    const doc = makePackument({ "1.0.0": 30 });
    const rewritten = rewriteTarballUrls(doc, {
      upstream: UPSTREAM,
      registryBase: "http://localhost:8765",
    });

    const version = rewritten.versions!["1.0.0"] as { dist: { tarball: string } };
    expect(version.dist.tarball).toBe("https://example/demo-1.0.0.tgz");
  });
});

// ---------- handleRequest: packument ----------

describe("handleRequest packument", () => {
  test("filters packument and returns JSON", async () => {
    const doc = makePackument({ "1.0.0": 30, "1.1.0": 14, "1.2.0": 3 });
    doc["dist-tags"] = { latest: "1.2.0" };
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
    ]);
    const { deps, logs } = makeRig({ routes });

    const res = await handleRequest(new Request("http://proxy/demo"), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Packument;
    expect(Object.keys(body.versions!).sort()).toEqual(["1.0.0", "1.1.0"]);
    expect(body["dist-tags"]!.latest).toBe("1.1.0");
    expect(logs[0]!.note).toBe("filtered:3→2");
  });

  test("scoped packument", async () => {
    const doc = makePackument({ "1.0.0": 30 });
    doc.name = "@thirdparty/lib";
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/@thirdparty/lib`, mockJson(doc)],
    ]);
    const { deps } = makeRig({ routes });

    const res = await handleRequest(new Request("http://proxy/@thirdparty/lib"), deps);
    expect(res.status).toBe(200);
  });

  test("filters encoded scoped packument", async () => {
    const doc = makePackument({ "1.0.0": 30, "1.2.0": 2 });
    doc.name = "@thirdparty/lib";
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/@thirdparty%2flib`, mockJson(doc)],
    ]);
    const { deps } = makeRig({ routes });

    const res = await handleRequest(new Request("http://proxy/@thirdparty%2flib"), deps);
    const body = (await res.json()) as Packument;

    expect(Object.keys(body.versions!)).toEqual(["1.0.0"]);
    expect(body["dist-tags"]!.latest).toBe("1.0.0");
  });

  test("rewrites packument tarball URLs to the request origin", async () => {
    const doc = makePackument({ "1.0.0": 30 });
    const version = doc.versions!["1.0.0"] as { dist: { tarball: string } };
    version.dist.tarball = `${UPSTREAM}/demo/-/demo-1.0.0.tgz`;
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
    ]);
    const { deps } = makeRig({ routes });

    const res = await handleRequest(new Request("http://localhost:8765/demo"), deps);
    const body = (await res.json()) as Packument;
    const rewritten = body.versions!["1.0.0"] as { dist: { tarball: string } };

    expect(rewritten.dist.tarball).toBe("http://localhost:8765/demo/-/demo-1.0.0.tgz");
  });

  test("rejects packument with no .time field", async () => {
    const doc = { name: "demo", versions: { "1.0.0": {} } };
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
    ]);
    const { deps, logs } = makeRig({ routes });
    const res = await handleRequest(new Request("http://proxy/demo"), deps);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("missing publish time metadata");
    expect(logs[0]!.note).toBe("error:upstream");
  });

  test("rejects oversized packument bodies", async () => {
    const doc = makePackument({ "1.0.0": 30 });
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
    ]);
    const { deps } = makeRig({ routes, maxPackumentBytes: 10 });
    const res = await handleRequest(new Request("http://proxy/demo"), deps);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("packument body exceeds 10 bytes");
  });

  test("strips cache validators from filtered packuments", async () => {
    const doc = makePackument({ "1.0.0": 30 });
    const routes = new Map<string, MockResponseSpec | "throw">([
      [
        `${UPSTREAM}/demo`,
        mockJson(doc, 200, { etag: '"abc"', "last-modified": "Thu, 14 May 2026 12:00:00 GMT" }),
      ],
    ]);
    const { deps } = makeRig({ routes });
    const res = await handleRequest(new Request("http://proxy/demo"), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("last-modified")).toBeNull();
  });

  test("passes through empty .versions unmodified", async () => {
    const doc: Packument = {
      name: "demo",
      versions: {},
      time: { created: isoDaysAgo(1000), modified: isoDaysAgo(1000) },
    };
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
    ]);
    const { deps, logs } = makeRig({ routes });
    const res = await handleRequest(new Request("http://proxy/demo"), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Packument;
    expect(Object.keys(body.versions!)).toHaveLength(0);
    expect(logs[0]!.note).toBe("filtered:0→0");
  });

  test("passes 404 through unchanged", async () => {
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/missing`, { status: 404, body: "not found" }],
    ]);
    const { deps } = makeRig({ routes });
    const res = await handleRequest(new Request("http://proxy/missing"), deps);
    expect(res.status).toBe(404);
  });
});

// ---------- handleRequest: tarball ----------

describe("handleRequest tarball", () => {
  test("blocks fresh tarball with 403 containing pkg name and age", async () => {
    const doc = makePackument({ "1.0.0": 30, "1.2.0": 3 });
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
      [`${UPSTREAM}/demo/-/demo-1.2.0.tgz`, mockBinary(new Uint8Array([1, 2, 3]))],
    ]);
    const { deps, logs } = makeRig({ routes });

    const res = await handleRequest(new Request("http://proxy/demo/-/demo-1.2.0.tgz"), deps);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("demo@1.2.0");
    expect(text).toContain("3.0 days");
    expect(logs[0]!.note).toBe("block:fresh");
  });

  test("streams old tarball with 200", async () => {
    const doc = makePackument({ "1.0.0": 30 });
    const tarball = new Uint8Array([9, 9, 9, 9]);
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
      [`${UPSTREAM}/demo/-/demo-1.0.0.tgz`, mockBinary(tarball)],
    ]);
    const { deps } = makeRig({ routes });
    const res = await handleRequest(new Request("http://proxy/demo/-/demo-1.0.0.tgz"), deps);
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([9, 9, 9, 9]);
  });

  test("scoped tarball URL parses correctly and is blocked when fresh", async () => {
    const doc = makePackument({ "1.0.0": 2 });
    doc.name = "@thirdparty/lib";
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/@thirdparty/lib`, mockJson(doc)],
    ]);
    const { deps } = makeRig({ routes });
    const res = await handleRequest(
      new Request("http://proxy/@thirdparty/lib/-/lib-1.0.0.tgz"),
      deps,
    );
    expect(res.status).toBe(403);
  });

  test("returns 502 when requested version not in packument", async () => {
    const doc = makePackument({ "1.0.0": 30 });
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
    ]);
    const { deps } = makeRig({ routes });
    const res = await handleRequest(
      new Request("http://proxy/demo/-/demo-9.9.9.tgz"),
      deps,
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("not in packument");
  });

  test("rejects tarball when packument has no .time field", async () => {
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson({ name: "demo", versions: { "1.0.0": {} } })],
    ]);
    const { deps } = makeRig({ routes });
    const res = await handleRequest(
      new Request("http://proxy/demo/-/demo-1.0.0.tgz"),
      deps,
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("missing publish time metadata");
  });

  test("rejects tarball when publish time is malformed", async () => {
    const doc = makePackument({ "1.0.0": 30 });
    doc.time!["1.0.0"] = "not-a-date";
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
    ]);
    const { deps } = makeRig({ routes });
    const res = await handleRequest(
      new Request("http://proxy/demo/-/demo-1.0.0.tgz"),
      deps,
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("invalid publish time");
  });

  test("rejects oversized tarball lookup packuments", async () => {
    const doc = makePackument({ "1.0.0": 30 });
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
    ]);
    const { deps } = makeRig({ routes, maxPackumentBytes: 10 });
    const res = await handleRequest(
      new Request("http://proxy/demo/-/demo-1.0.0.tgz"),
      deps,
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("packument body exceeds 10 bytes");
  });
});

// ---------- allowlist ----------

describe("handleRequest allowlist", () => {
  test("passes through allowlisted scope without filtering even when fresh", async () => {
    const doc = makePackument({ "1.0.0": 1 }); // 1 day old — would be filtered
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/@smcllns/secret`, mockJson(doc)],
    ]);
    const { deps, logs } = makeRig({
      routes,
      allowlist: new Set(["@smcllns"]),
    });
    const res = await handleRequest(new Request("http://proxy/@smcllns/secret"), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Packument;
    expect(Object.keys(body.versions!)).toEqual(["1.0.0"]);
    expect(logs[0]!.note).toBe("allow:@smcllns");
  });

  test("passes through allowlisted tarball without age-checking", async () => {
    const tarball = new Uint8Array([5, 5, 5]);
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/@smcllns/secret/-/secret-1.0.0.tgz`, mockBinary(tarball)],
    ]);
    const { deps } = makeRig({ routes, allowlist: new Set(["@smcllns"]) });
    const res = await handleRequest(
      new Request("http://proxy/@smcllns/secret/-/secret-1.0.0.tgz"),
      deps,
    );
    expect(res.status).toBe(200);
  });

  test("empty allowlist applies default filter to non-allowlisted scope", async () => {
    const doc = makePackument({ "1.0.0": 1 }); // fresh
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/@thirdparty/lib`, mockJson(doc)],
    ]);
    const { deps } = makeRig({ routes, allowlist: new Set() });
    const res = await handleRequest(
      new Request("http://proxy/@thirdparty/lib"),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Packument;
    expect(Object.keys(body.versions!)).toHaveLength(0);
  });

  test("allowlist with comments and blanks parses correctly", () => {
    const text = "# comment\n\n@a\n@b # inline\n  # indented\n";
    const out = parseAllowlist(text);
    expect(out.size).toBe(2);
    expect(out.has("@a")).toBeTrue();
    expect(out.has("@b")).toBeTrue();
  });
});

// ---------- non-read methods (publish/login) ----------

describe("handleRequest method+body forwarding", () => {
  test("PUT to allowlisted scope forwards method and body to upstream", async () => {
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/@smcllns/foo`, { status: 201, body: '{"ok":true}', headers: { "content-type": "application/json" } }],
    ]);
    const { deps, inits } = makeRig({ routes, allowlist: new Set(["@smcllns"]) });
    const req = new Request("http://proxy/@smcllns/foo", {
      method: "PUT",
      body: JSON.stringify({ _id: "@smcllns/foo", versions: { "0.1.0": {} } }),
      headers: { "content-type": "application/json" },
    });
    const res = await handleRequest(req, deps);
    expect(res.status).toBe(201);
    expect(inits[0]!.method).toBe("PUT");
    expect(inits[0]!.body).toContain("@smcllns/foo");
  });

  test("PUT to non-allowlisted packument path passes through unfiltered (publish to third-party)", async () => {
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/somepkg`, { status: 201, body: '{"ok":true}' }],
    ]);
    const { deps, inits, logs } = makeRig({ routes });
    const req = new Request("http://proxy/somepkg", {
      method: "PUT",
      body: "payload-body",
    });
    const res = await handleRequest(req, deps);
    expect(res.status).toBe(201);
    expect(inits[0]!.method).toBe("PUT");
    expect(inits[0]!.body).toBe("payload-body");
    expect(logs[0]!.note).toBe("pass");
  });

  test("POST to /-/v1/login forwards body", async () => {
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/-/v1/login`, { status: 200, body: '{"token":"x"}' }],
    ]);
    const { deps, inits } = makeRig({ routes });
    const req = new Request("http://proxy/-/v1/login", {
      method: "POST",
      body: '{"hostname":"laptop"}',
    });
    const res = await handleRequest(req, deps);
    expect(res.status).toBe(200);
    expect(inits[0]!.method).toBe("POST");
    expect(inits[0]!.body).toBe('{"hostname":"laptop"}');
  });
});

// ---------- failure modes ----------

describe("handleRequest failure modes", () => {
  test("upstream 500 → proxy 502", async () => {
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, { status: 500, body: "boom", headers: { "content-type": "text/plain" } }],
    ]);
    const { deps } = makeRig({ routes });
    const res = await handleRequest(new Request("http://proxy/demo"), deps);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("status 500");
  });

  test("upstream network error → proxy 502", async () => {
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockError()],
    ]);
    const { deps } = makeRig({ routes });
    const res = await handleRequest(new Request("http://proxy/demo"), deps);
    expect(res.status).toBe(502);
  });

  test("malformed JSON → proxy 502", async () => {
    const routes = new Map<string, MockResponseSpec | "throw">([
      [
        `${UPSTREAM}/demo`,
        { status: 200, body: "this is { not json", headers: { "content-type": "application/json" } },
      ],
    ]);
    const { deps } = makeRig({ routes });
    const res = await handleRequest(new Request("http://proxy/demo"), deps);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("malformed JSON");
  });
});

// ---------- status + logging ----------

describe("status and logging", () => {
  test("returns proxy status without hitting upstream", async () => {
    const routes = new Map<string, MockResponseSpec | "throw">();
    const { deps, calls, logs } = makeRig({ routes, allowlist: new Set(["@smcllns"]) });
    deps.status.lastUpstreamError = {
      at: NOW.toISOString(),
      path: `${UPSTREAM}/demo`,
      detail: "status 500",
      upstreamStatus: 500,
    };

    const res = await handleRequest(new Request("http://proxy/__status"), deps);
    const body = await res.json() as {
      allowlistScopes: string[];
      cacheSize: number;
      lastUpstreamError: { detail: string };
    };

    expect(res.status).toBe(200);
    expect(body.allowlistScopes).toEqual(["@smcllns"]);
    expect(body.cacheSize).toBe(0);
    expect(body.lastUpstreamError.detail).toBe("status 500");
    expect(calls).toHaveLength(0);
    expect(logs[0]!.note).toBe("status");
  });

  test("sanitizes newline characters in log output", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      makeLogger("info")({
        method: "GET",
        path: "/demo\nforged",
        status: 200,
        durationMs: 1,
        note: "filtered:1→1",
      });
    } finally {
      console.log = original;
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/demo\\nforged");
    expect(lines[0]).not.toContain("/demo\nforged");
  });
});

// ---------- cache hits ----------

describe("handleRequest cache", () => {
  test("tarball lookup hits cache after packument fetch", async () => {
    const doc = makePackument({ "1.0.0": 30 });
    const tarball = new Uint8Array([1]);
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
      [`${UPSTREAM}/demo/-/demo-1.0.0.tgz`, mockBinary(tarball)],
    ]);
    const { deps, calls } = makeRig({ routes });

    // First request: packument fetch populates cache.
    await handleRequest(new Request("http://proxy/demo"), deps);
    const packumentCalls = calls.filter((u) => u === `${UPSTREAM}/demo`).length;
    expect(packumentCalls).toBe(1);

    // Second request: tarball should use cached time map (no extra packument fetch).
    const res = await handleRequest(new Request("http://proxy/demo/-/demo-1.0.0.tgz"), deps);
    expect(res.status).toBe(200);
    const totalPackumentCalls = calls.filter((u) => u === `${UPSTREAM}/demo`).length;
    expect(totalPackumentCalls).toBe(1); // unchanged — cache hit
  });

  test("cache expires after TTL", async () => {
    const doc = makePackument({ "1.0.0": 30 });
    const tarball = new Uint8Array([1]);
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
      [`${UPSTREAM}/demo/-/demo-1.0.0.tgz`, mockBinary(tarball)],
    ]);
    let clock = new Date(NOW);
    const { deps, calls } = makeRig({
      routes,
      cacheTtlMs: 1000,
      cacheClock: () => clock,
    });

    await handleRequest(new Request("http://proxy/demo/-/demo-1.0.0.tgz"), deps);
    const firstCount = calls.filter((u) => u === `${UPSTREAM}/demo`).length;
    expect(firstCount).toBe(1);

    clock = new Date(NOW.getTime() + 2000);
    await handleRequest(new Request("http://proxy/demo/-/demo-1.0.0.tgz"), deps);
    const secondCount = calls.filter((u) => u === `${UPSTREAM}/demo`).length;
    expect(secondCount).toBe(2);
  });
});

// ---------- config ----------

describe("config variations", () => {
  test("MIN_AGE_DAYS=0 allows fresh versions (no filtering)", async () => {
    const doc = makePackument({ "1.0.0": 0.1 }); // 2.4 hours old
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
    ]);
    const { deps } = makeRig({ routes, minAgeDays: 0 });
    const res = await handleRequest(new Request("http://proxy/demo"), deps);
    const body = (await res.json()) as Packument;
    expect(Object.keys(body.versions!)).toEqual(["1.0.0"]);
  });

  test("MIN_AGE_DAYS=3650 blocks essentially everything", async () => {
    const doc = makePackument({ "1.0.0": 30, "1.1.0": 365 });
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
    ]);
    const { deps } = makeRig({ routes, minAgeDays: 3650 });
    const res = await handleRequest(new Request("http://proxy/demo"), deps);
    const body = (await res.json()) as Packument;
    expect(Object.keys(body.versions!)).toHaveLength(0);
  });
});

// ---------- startServer config validation ----------

describe("startServer config validation", () => {
  test("rejects non-numeric MIN_AGE_DAYS", async () => {
    await expect(startServer({ minAgeDays: NaN as unknown as number })).rejects.toThrow(/MIN_AGE_DAYS/);
  });
  test("rejects negative MIN_AGE_DAYS", async () => {
    await expect(startServer({ minAgeDays: -1 })).rejects.toThrow(/MIN_AGE_DAYS/);
  });
  test("rejects negative CACHE_TTL_MS", async () => {
    await expect(startServer({ cacheTtlMs: -100 })).rejects.toThrow(/CACHE_TTL_MS/);
  });
  test("rejects negative MAX_PACKUMENT_BYTES", async () => {
    await expect(startServer({ maxPackumentBytes: -1 })).rejects.toThrow(/MAX_PACKUMENT_BYTES/);
  });
  test("status endpoint reflects hot-reloaded allowlist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "npm-age-proxy-"));
    const allowlistPath = join(dir, "allowlist.txt");
    await writeFile(allowlistPath, "@first\n");
    const server = await startServer({ port: 0, allowlistPath });
    const base = `http://${server.hostname}:${server.port}`;
    try {
      const initial = await fetch(`${base}/__status`).then((r) => r.json()) as { allowlistScopes: string[] };
      expect(initial.allowlistScopes).toEqual(["@first"]);

      await writeFile(allowlistPath, "@second\n");
      await waitFor(async () => {
        const body = await fetch(`${base}/__status`).then((r) => r.json()) as { allowlistScopes: string[] };
        return body.allowlistScopes.length === 1 && body.allowlistScopes[0] === "@second";
      });
    } finally {
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------- other paths ----------

describe("handleRequest other paths", () => {
  test("forwards /-/v1/search untouched", async () => {
    const routes = new Map<string, MockResponseSpec | "throw">([
      [
        `${UPSTREAM}/-/v1/search?text=demo`,
        { status: 200, body: '{"objects":[]}', headers: { "content-type": "application/json" } },
      ],
    ]);
    const { deps, logs } = makeRig({ routes });
    const res = await handleRequest(new Request("http://proxy/-/v1/search?text=demo"), deps);
    expect(res.status).toBe(200);
    expect(logs[0]!.note).toBe("pass");
  });
});

// ---------- integration smoke for the request flow ----------

describe("end-to-end packument → tarball flow", () => {
  beforeEach(() => {
    // No-op; each rig creates a fresh cache.
  });

  test("packument filter then tarball block, sharing cache", async () => {
    const doc = makePackument({ "1.0.0": 30, "1.2.0": 2 });
    doc["dist-tags"] = { latest: "1.2.0" };
    const routes = new Map<string, MockResponseSpec | "throw">([
      [`${UPSTREAM}/demo`, mockJson(doc)],
    ]);
    const { deps, calls } = makeRig({ routes });

    const r1 = await handleRequest(new Request("http://proxy/demo"), deps);
    expect(r1.status).toBe(200);

    const r2 = await handleRequest(
      new Request("http://proxy/demo/-/demo-1.2.0.tgz"),
      deps,
    );
    expect(r2.status).toBe(403);
    expect(calls.filter((u) => u === `${UPSTREAM}/demo`).length).toBe(1);
  });
});
