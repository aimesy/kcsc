// node tests/worker.test.mjs
// Unit checks for the kcsc-data Worker (worker/release.js) with a mocked env,
// a stub for the cached Release entrypoint and a mocked fetch, plus a run of
// the viewer's own data client through the Worker. Adapted from aimesy/mfa.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleGateway, handleRelease, route, DATA_PATH, documentKey, OPEN_PATHS } from "../worker/release.js";
import { checkGate } from "../worker/gate.contract.mjs";
import { createKcscDataClient } from "../assets/js/kcsc-data-client.js";
import { createDirectoryClient } from "../assets/js/kcsc-directory.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SITE = "https://kcsc.amyc.us";
const HOME = "https://amyc.us"; // aimesy/me assets/projects.js reads data/manifest.json
const BASE = "https://kcsc-data.amyc.us";
const RAW = "https://raw.githubusercontent.com/aimesy/kcsc-data";

function limiter(allow = true) {
  const keys = [];
  return { keys, limit: async ({ key }) => { keys.push(key); return { success: allow }; } };
}

function env(extra = {}) {
  return { ALLOWED_ORIGINS: "https://kcsc.amyc.us https://amyc.us", RATE_LIMITER: limiter(), ...extra };
}

// Gateway with a stub Release entrypoint that records what it was sent.
async function gateway(path, { method = "GET", headers = {}, e = env(), reply } = {}) {
  const sent = [];
  const release = async (req) => {
    sent.push(req);
    return reply ? reply(req) : new Response("body", { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" } });
  };
  const res = await handleGateway(new Request(`${BASE}${path}`, { method, headers }), e, { release, log: () => {} });
  return { res, sent };
}

// Release entrypoint with a mocked GitHub.
async function release(path, { headers = {}, method = "GET", e = {}, upstream } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return upstream ? upstream(url, init) : new Response("{}", { status: 200, headers: { "Content-Length": "2", ETag: '"abc"' } });
  };
  const res = await handleRelease(new Request(`${BASE}${path}`, { method, headers }), e, fetchImpl);
  return { res, calls };
}

// Path allowlist: every file the viewer reads from aimesy/kcsc-data, as the
// repository held them on 2026-10-03 (data/manifest.json, its tables and
// ranking sources, the case directory, all 67 index shards, a case record).
const SHARDS = ("022 081 082 083 084 091 092 093 094 101 102 103 104 111 112 113 114 121 122 123 124 132 "
  + "171 172 173 174 180 181 182 183 184 190 191 192 193 194 200 201 202 203 204 210 211 212 213 214 "
  + "220 221 222 223 224 231 232 233 234 241 242 243 244 251 252 253 254 261 262 263 264").split(" ");
assert.equal(SHARDS.length, 67);
const LIVE_PATHS = [
  "data/manifest.json",
  ...["attorneys", "calendar", "cases", "docket_entries", "parties", "payments", "representation"].map((t) => `data/${t}.parquet`),
  "data/attorney-practice-rankings.json",
  "data/judgment-rankings.json",
  "archive/case-directory/manifest.json",
  "archive/cases-index/manifest.json",
  ...SHARDS.map((p) => `archive/cases-index/${p}.ndjson`),
  "archive/cases/081073617SEA.json",
  "archive/cases/022999999KNT.json",
];
{
  for (const path of LIVE_PATHS) {
    assert.deepEqual(route(`/master/${path}`), { kind: "file", ref: "master", path }, path);
    assert.deepEqual(route(`/${SHA}/${path}`), { kind: "file", ref: SHA, path }, path);
  }
  // The legacy single index the viewer falls back to when a manifest has no shards.
  assert.equal(DATA_PATH.test("archive/cases-index.ndjson"), true);
  assert.deepEqual(route("/ref"), { kind: "ref" });

  // Files the viewer never reads, and shapes it never builds.
  for (const bad of [
    "/master/data/normalization-summary.json", "/master/data/source-runs.json", "/master/README.md", "/master/AGENTS.md",
    "/master/DATA-USE-TERMS.md", "/master/.gitattributes", "/master/.gitignore", "/master/archive/promotions/raw-release/x.json",
    "/master/archive/case-directory/x.ndjson", "/master/archive/cases/081073617sea.json", "/master/archive/cases/08-1-07361-7SEA.json",
    "/master/archive/cases/a/b.json", "/master/archive/cases/.json", "/master/archive/cases-index/../cases/081073617SEA.json",
    "/master/archive/cases-index/a%2e%2e.ndjson", "/master/archive/cases-index/sub/081.ndjson", "/master/data/x.csv",
    "/master/data/X.parquet", "/master/data/x.parquet.tmp", "/master/data/manifest.json/x", "/master/data/rankings.json",
    `/${SHA}/.github/workflows/pages.yml`, `/${SHA.toUpperCase()}/data/manifest.json`, `/${SHA.slice(1)}/data/manifest.json`,
    "/main/data/manifest.json", "/dev/data/manifest.json", "/", "/data/manifest.json", "/master/", "/master/data",
    "/releases/download/raw-kcsc-runs-2026-10-03/x.tar.zst",
  ]) assert.equal(route(bad), null, `${bad} must be refused`);
}

// Unknown or missing origin: 403, and the Release entrypoint is never called.
{
  for (const headers of [{}, { Origin: "https://evil.example" }, { Origin: "null" }, { Origin: "https://aimesy.github.io" },
    { Origin: "https://www.amyc.us" }, { Origin: "http://kcsc.amyc.us" }, { Origin: "https://kcsc.amyc.us.evil.example" },
    { Referer: "https://evil.example/kcsc/" }, { Origin: "https://evil.example", Referer: `${SITE}/` }]) {
    const { res, sent } = await gateway("/master/data/manifest.json", { headers });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal(sent.length, 0);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
  }
}

// Allowed by Origin (fetch) or by Referer; CORS on the answer.
{
  const { res, sent } = await gateway("/master/data/manifest.json", { headers: { Origin: SITE } });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.match(res.headers.get("Vary"), /Origin/);
  assert.equal(res.headers.get("Access-Control-Expose-Headers"), "Content-Range, Content-Length, Accept-Ranges, Retry-After, X-Check, X-Limit, X-KCSC-Session, X-Trusted-Key");
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
  assert.equal(await res.text(), "body");

  const viaReferer = await gateway("/master/archive/cases/081073617SEA.json", { headers: { Referer: `${SITE}/#case=081073617SEA` } });
  assert.equal(viaReferer.res.status, 200);
  assert.equal(viaReferer.res.headers.get("Access-Control-Allow-Origin"), SITE);

  // The home page's live figures: data/manifest.json with its cache buster.
  const home = await gateway(`/master/data/manifest.json?v=${Date.now()}`, { headers: { Origin: HOME } });
  assert.equal(home.res.status, 200);
  assert.equal(home.res.headers.get("Access-Control-Allow-Origin"), HOME);
  assert.equal(home.sent[0].url, `${BASE}/master/data/manifest.json`);

  const kept = await gateway("/master/data/cases.parquet", { headers: { Origin: SITE }, reply: () => new Response("x", { headers: { Vary: "Accept-Encoding" } }) });
  assert.equal(kept.res.headers.get("Vary"), "Accept-Encoding, Origin");
}

// Query stripping and Range forwarding: the inner request carries the path and Range only.
{
  const { sent } = await gateway("/master/data/calendar.parquet?cachebust=1&token=x", {
    headers: { Origin: SITE, Range: "bytes=0-262143", Cookie: "a=b", Authorization: "Bearer nope", "Cache-Control": "no-cache" },
  });
  const inner = sent[0];
  assert.equal(inner.url, `${BASE}/master/data/calendar.parquet`);
  assert.deepEqual([...inner.headers.keys()], ["range"]);
  assert.equal(inner.headers.get("Range"), "bytes=0-262143");
  assert.equal(inner.method, "GET");

  const plain = await gateway("/master/data/manifest.json", { headers: { Origin: SITE, Accept: "*/*", "Cache-Control": "max-age=0" } });
  assert.deepEqual([...plain.sent[0].headers.keys()], []);
}

// Paths outside the allowlist: 404 without reaching GitHub.
{
  const { res, sent } = await gateway("/master/data/source-runs.json", { headers: { Origin: SITE } });
  assert.equal(res.status, 404);
  assert.equal(sent.length, 0);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
}

// Rate limit: per CF-Connecting-IP; over the limit, 429 with Retry-After and CORS so the viewer sees it.
{
  const e = env({ RATE_LIMITER: limiter(false) });
  const { res, sent } = await gateway("/master/data/manifest.json", { headers: { Origin: SITE, "CF-Connecting-IP": "203.0.113.9" }, e });
  assert.equal(res.status, 429);
  assert.equal(sent.length, 0);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.equal(res.headers.get("Access-Control-Expose-Headers"), "Content-Range, Content-Length, Accept-Ranges, Retry-After, X-Check, X-Limit, X-KCSC-Session, X-Trusted-Key");
  assert.deepEqual(e.RATE_LIMITER.keys, ["203.0.113.9"]);

  const ok = env();
  await gateway("/master/data/manifest.json", { headers: { Origin: SITE, "CF-Connecting-IP": "198.51.100.4" }, e: ok });
  assert.deepEqual(ok.RATE_LIMITER.keys, ["198.51.100.4"]);
}

// OPTIONS preflight: allowed origin gets Range; unknown origin gets 403.
{
  const { res, sent } = await gateway("/master/data/calendar.parquet", {
    method: "OPTIONS", headers: { Origin: SITE, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range" },
  });
  assert.equal(res.status, 204);
  assert.equal(sent.length, 0);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /Range/);
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /GET/);
  assert.match(res.headers.get("Vary"), /Origin/);
  const denied = await gateway("/master/data/calendar.parquet", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(denied.res.status, 403);
}

// Other methods are refused.
{
  const { res, sent } = await gateway("/master/data/manifest.json", { method: "POST", headers: { Origin: SITE } });
  assert.equal(res.status, 405);
  assert.equal(sent.length, 0);
}

// robots.txt disallows everything, for anyone.
{
  const { res, sent } = await gateway("/robots.txt");
  assert.equal(res.status, 200);
  assert.equal(sent.length, 0);
  assert.equal(await res.text(), "User-agent: *\nDisallow: /\n");
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
}

// Upstream: Authorization only when the token is set, User-Agent always, Range passed through.
{
  const withToken = await release("/master/data/manifest.json", { e: { KCSC_DATA_TOKEN: "t0ken" } });
  assert.equal(withToken.calls[0].url, `${RAW}/master/data/manifest.json`);
  assert.equal(withToken.calls[0].init.headers.Authorization, "Bearer t0ken");
  assert.match(withToken.calls[0].init.headers["User-Agent"], /kcsc-data-worker/);

  const without = await release("/master/data/manifest.json");
  assert.equal("Authorization" in without.calls[0].init.headers, false);

  const ranged = await release(`/${SHA}/data/calendar.parquet`, {
    headers: { Range: "bytes=262144-524287" },
    upstream: () => new Response("part", { status: 206, headers: { "Content-Range": "bytes 262144-524287/91914420", "Content-Length": "262144" } }),
  });
  assert.equal(ranged.calls[0].init.headers.Range, "bytes=262144-524287");
  assert.equal(ranged.res.status, 206);
  assert.equal(ranged.res.headers.get("Content-Range"), "bytes 262144-524287/91914420");
  assert.equal(ranged.res.headers.get("Content-Length"), "262144");
  assert.equal(ranged.res.headers.get("Accept-Ranges"), "bytes");

  const head = await release("/master/data/manifest.json", { method: "HEAD" });
  assert.equal(head.calls[0].init.method, "HEAD");
  assert.equal(await head.res.text(), "");
}

// Cache headers: a commit is immutable, master is short; errors are never stored.
{
  const pinned = await release(`/${SHA}/archive/cases/081073617SEA.json`);
  assert.equal(pinned.res.status, 200);
  assert.equal(pinned.res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(pinned.res.headers.get("Content-Type"), "application/json");
  assert.equal(pinned.res.headers.get("ETag"), '"abc"');
  assert.equal(pinned.res.headers.get("Content-Length"), "2");
  assert.equal(pinned.res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(pinned.res.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox");

  const head = await release("/master/archive/cases-index/081.ndjson");
  assert.equal(head.res.headers.get("Cache-Control"), "public, max-age=60");
  assert.equal(head.res.headers.get("Content-Type"), "application/x-ndjson");

  assert.equal((await release("/master/data/cases.parquet")).res.headers.get("Content-Type"), "application/vnd.apache.parquet");
  assert.equal((await release("/master/data/judgment-rankings.json")).res.headers.get("Content-Type"), "application/json");

  const missing = await release("/master/archive/cases/999999999SEA.json", { upstream: () => new Response("404: Not Found", { status: 404 }) });
  assert.equal(missing.res.status, 404);
  assert.equal(missing.res.headers.get("Cache-Control"), "no-store");
  const broken = await release("/master/data/manifest.json", { upstream: () => new Response("", { status: 500 }) });
  assert.equal(broken.res.status, 502);
  assert.equal(broken.res.headers.get("Cache-Control"), "no-store");
  const down = await release("/master/data/manifest.json", { upstream: () => { throw new Error("connect failed"); } });
  assert.equal(down.res.status, 502);
  assert.equal(down.res.headers.get("Cache-Control"), "no-store");
}

// A gzipped upstream body passes through still encoded: Content-Encoding and
// its Content-Length are kept, so the runtime never decodes it in the Worker.
{
  const { res } = await release("/master/data/judgment-rankings.json", {
    upstream: () => new Response("gz", { headers: { "Content-Encoding": "gzip", "Content-Length": "31", "Content-Type": "text/plain; charset=utf-8" } }),
  });
  assert.equal(res.headers.get("Content-Encoding"), "gzip");
  assert.equal(res.headers.get("Content-Length"), "31");
  assert.equal(res.headers.get("Content-Type"), "application/json");
  const viaGateway = await gateway("/master/data/judgment-rankings.json", {
    headers: { Origin: SITE },
    reply: () => new Response("gz", { headers: { "Content-Encoding": "gzip", "Content-Length": "31" } }),
  });
  assert.equal(viaGateway.res.headers.get("Content-Encoding"), "gzip");
  assert.equal(viaGateway.res.headers.get("Content-Length"), "31");
}

// /ref: the commit at master from the API, cached for 60 s.
{
  const { res, calls } = await release("/ref", {
    e: { KCSC_DATA_TOKEN: "t0ken" },
    upstream: () => new Response(`${SHA}\n`, { status: 200 }),
  });
  assert.equal(calls[0].url, "https://api.github.com/repos/aimesy/kcsc-data/commits/master");
  assert.equal(calls[0].init.headers.Accept, "application/vnd.github.sha");
  assert.equal(calls[0].init.headers.Authorization, "Bearer t0ken");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), SHA);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=60");

  const denied = await release("/ref", { upstream: () => new Response('{"message":"Not Found"}', { status: 404 }) });
  assert.equal(denied.res.status, 502);
  assert.equal(denied.res.headers.get("Cache-Control"), "no-store");

  const viaGateway = await gateway("/ref?x=1", { headers: { Origin: SITE } });
  assert.equal(viaGateway.sent[0].url, `${BASE}/ref`);
}

// The Release entrypoint refuses paths outside the allowlist on its own too.
{
  const { res, calls } = await release("/master/data/source-runs.json");
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
}

// The viewer's own data client, pointed at the viewer's REMOTE_DATA_BASE, reads
// every kind of file through the gateway and Release to the right GitHub URL.
{
  const viewer = readFileSync(new URL("../assets/js/kcsc-viewer.js", import.meta.url), "utf8");
  const remote = /const REMOTE_DATA_BASE = '([^']+)';/.exec(viewer)?.[1];
  assert.equal(remote, `${BASE}/master/`, "the viewer must read kcsc-data through the Worker at master");
  const wrangler = readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
  const origins = /^ALLOWED_ORIGINS = "([^"]*)"$/m.exec(wrangler)?.[1].split(/\s+/) || [];
  assert.deepEqual(origins, [SITE, HOME], "wrangler.toml must allow the viewer and the home page, and nothing else");

  const tables = Object.fromEntries(["cases", "docket_entries", "parties", "attorneys", "representation", "calendar", "payments"]
    .map((name) => [name, { path: `data/${name}.parquet`, rows: name === "cases" ? 1 : 0, size_bytes: 4 }]));
  const manifest = {
    format: "kcsc-data-manifest-v1",
    court_id: "kcsc",
    generated_at: "2026-10-02T21:16:54Z",
    archive: {
      cases: 1,
      cases_dir: "archive/cases",
      case_directory: "archive/case-directory/manifest.json",
      cases_index: "archive/cases-index/manifest.json",
      cases_index_parts: [{ path: "archive/cases-index/081.ndjson", rows: 1, size_bytes: 40 }],
    },
    documents: { byte_capture: false, table: null },
    tables,
  };
  const rankingManifest = { statistics: { ranking_sources: {
    attorney_rankings: { path: "data/attorney-practice-rankings.json" },
    judgment_rankings: { path: "data/judgment-rankings.json" },
  } } };
  const attorneyRankings = {
    format: "kcsc-attorney-rankings-v1",
    topics: [{
      topic: "all_matters", label: "All matters",
      categories: [{ key: "civil", label: "Civil", case_count: 1 }],
      attorneys: [{
        attorney_id: "bar:1", attorney_name: "Counsel One", matter_count: 1,
        matter_count_last_2_years: 1, all_matter_count: 1, judgment_count: 0,
        category_contributions: [{ category_key: "civil" }],
      }],
    }],
  };
  const judgmentRankings = {
    format: "kcsc-judgment-rankings-v1",
    matter_types: [{ key: "civil", label: "Civil", judgment_count: 1 }],
    matter_categories: [{ key: "civil:Contract", label: "Contract", matter_type: "civil", judgment_count: 1 }],
    rows: [{ rank: 1, case_number: "081073617SEA", judgment_amount: 10, case_type: "civil", cause_of_action: "Contract" }],
  };
  const row = '{"case_number":"081073617SEA","case_type":"criminal","location_code":"SEA","filed_date":"2008-11-05"}\n';
  const files = {
    "data/manifest.json": JSON.stringify(manifest),
    "data/attorney-practice-rankings.json": JSON.stringify(attorneyRankings),
    "data/judgment-rankings.json": JSON.stringify(judgmentRankings),
    "archive/case-directory/manifest.json": "{}",
    "archive/cases-index/081.ndjson": row,
    "archive/cases-index.ndjson": row,
    "archive/cases/081073617SEA.json": '{"case_number":"081073617SEA"}',
    ...Object.fromEntries(Object.values(tables).map((t) => [t.path, "PAR1"])),
  };
  const upstream = [];
  const github = async (url, init) => {
    upstream.push({ url, auth: init.headers.Authorization });
    const path = url.startsWith(`${RAW}/master/`) ? url.slice(`${RAW}/master/`.length) : null;
    return path !== null && Object.hasOwn(files, path) ? new Response(files[path]) : new Response("404: Not Found", { status: 404 });
  };
  const releaseEnv = { KCSC_DATA_TOKEN: "t0ken" };
  const gatewayEnv = env();
  const viewerFetch = (input, init = {}) => handleGateway(
    new Request(String(input), { method: init.method || "GET", headers: { Origin: SITE } }),
    gatewayEnv,
    { release: (inner) => handleRelease(inner, releaseEnv, github), log: () => {} },
  );

  const client = createKcscDataClient({ base: remote, locationHref: `${SITE}/`, fetchImpl: viewerFetch });
  assert.equal((await client.manifest()).data.court_id, "kcsc");
  assert.equal((await client.json(manifest.archive.case_directory)).data.constructor, Object);
  for (const part of manifest.archive.cases_index_parts) assert.match((await client.text(part.path)).text, /081073617SEA/);
  assert.match((await client.text("archive/cases-index.ndjson")).text, /081073617SEA/);
  for (const table of Object.values(tables)) assert.equal((await client.buffer(table.path)).bytes.byteLength, 4);
  assert.equal((await client.attorneyRankings(rankingManifest)).data.topics[0].topic, "all_matters");
  assert.equal((await client.judgmentRankings(rankingManifest)).data.rows[0].case_number, "081073617SEA");
  assert.equal((await client.caseRecord("08-1-07361-7 SEA")).data.case_number, "081073617SEA");
  const directory = createDirectoryClient({ base: client.base, locationHref: `${SITE}/`, fetchImpl: (input, init) => client.fetch(input, init) });
  assert.equal((await directory.loadSource({ path: "archive/cases-index/081.ndjson" })).rows[0].case_number, "081073617SEA");

  const expected = [
    "data/manifest.json", "archive/case-directory/manifest.json", "archive/cases-index/081.ndjson", "archive/cases-index.ndjson",
    ...Object.values(tables).map((t) => t.path), "data/attorney-practice-rankings.json", "data/judgment-rankings.json",
    "archive/cases/081073617SEA.json", "archive/cases-index/081.ndjson",
  ];
  assert.deepEqual(upstream.map((u) => u.url), expected.map((p) => `${RAW}/master/${p}`));
  assert.ok(upstream.every((u) => u.auth === "Bearer t0ken"));
  assert.equal(gatewayEnv.RATE_LIMITER.keys.length, expected.length);
}

// Documents: each case's own record; everything else is an index file.
{
  assert.equal(documentKey(route("/master/archive/cases/081073617SEA.json")), "case:081073617SEA");
  assert.equal(documentKey(route(`/${SHA}/archive/cases/081073617SEA.json`)), "case:081073617SEA", "one document whatever the ref");
  for (const index of ["/master/data/manifest.json", "/master/data/docket_entries.parquet", "/master/archive/cases-index/081.ndjson", "/master/archive/case-directory/manifest.json", "/ref"]) {
    assert.equal(documentKey(route(index)), null, `${index} is an index file`);
  }
  assert.deepEqual(OPEN_PATHS, ["/master/data/manifest.json"]);
}

// The browser check and the document limits (worker/gate.js), through this gateway.
await checkGate({
  handle: (path, { method = "GET", headers = {}, body, env: e, counters, fetchImpl, now, log = () => {} }) =>
    handleGateway(new Request(`${BASE}${path}`, { method, headers, body }), e, {
      release: async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
      counters, fetchImpl, now, log,
    }),
  env: (extra = {}) => env({ SESSION_KEY: "test-session-key", TURNSTILE_SECRET_KEY: "test-turnstile-secret", ...extra }),
  site: SITE,
  document: (i) => `/master/archive/cases/CASE${i}SEA.json`,
  slices: false,
  index: "/master/archive/cases-index/081.ndjson",
  open: "/master/data/manifest.json",
  cookiePrefix: "kcsc",
  sessionHeader: "X-KCSC-Session",
});

console.log("worker tests passed");
