// Logic for the kcsc-data Worker, kept free of imports only Workers have, so
// tests/worker.test.mjs can run it under Node. index.js wires it up.
// Adapted from aimesy/mfa's worker/release.js.
//
// The data repository aimesy/kcsc-data is private. The viewer reads it
// through this Worker at https://kcsc-data.amyc.us/, whose URLs mirror
// raw.githubusercontent.com:
//   /<ref>/<path>   a file in the repository, at a full commit hash or master
//   /ref            the commit at master
//
// Two entrypoints:
//   gateway (default export, never cached): CORS preflight, the origin check
//     and the rate limit for each IP address, then a clean request to the
//     Release entrypoint.
//   release (the Release entrypoint, cached by Workers Caching): fetches the
//     file from GitHub with the read-only token and returns it with fresh headers.
// The cache sits in front of each entrypoint, so the gateway must stay
// uncached or a cache hit would skip the origin check and the rate limit.

export const REPO = "aimesy/kcsc-data";
export const BRANCH = "master";
// Every path the viewer asks for, and nothing else in the repository:
//   data/manifest.json, the parquet tables it lists, and its two ranking files;
//   archive/case-directory/manifest.json;
//   archive/cases-index/<prefix>.ndjson, its manifest.json, and the legacy
//     archive/cases-index.ndjson the viewer falls back to;
//   archive/cases/<CASE>.json, the name kcsc-data-client.js builds (A-Z, 0-9).
// tests/worker.test.mjs drives the viewer's own data client through this list.
export const DATA_PATH = /^(?:data\/(?:manifest\.json|[a-z0-9_]{1,64}\.parquet|[a-z0-9-]{1,64}-rankings\.json)|archive\/case-directory\/manifest\.json|archive\/cases-index\/(?:manifest\.json|[A-Za-z0-9_-]{1,64}\.ndjson)|archive\/cases-index\.ndjson|archive\/cases\/[A-Z0-9]{1,64}\.json)$/;
const SHA = /^[0-9a-f]{40}$/;
const USER_AGENT = "kcsc-data-worker (+https://github.com/aimesy/kcsc)";
const RETRY_AFTER_SECONDS = "60"; // the period of the RATE_LIMITER binding in wrangler.toml

const IMMUTABLE = "public, max-age=31536000, immutable";
const SHORT = "public, max-age=60";
const API_VERSION = "2022-11-28";
const NO_STORE = "no-store";

const CONTENT_TYPES = {
  json: "application/json",
  ndjson: "application/x-ndjson",
  parquet: "application/vnd.apache.parquet",
};

const ROBOTS = "User-agent: *\nDisallow: /\n";

// Which file a path names: { kind: "robots" | "ref" | "file", ref, path },
// or null for anything the viewer would never ask for.
export function route(pathname) {
  if (pathname === "/robots.txt") return { kind: "robots" };
  if (pathname === "/ref") return { kind: "ref" };
  const m = /^\/([^/]+)\/(.+)$/.exec(pathname);
  if (!m) return null;
  const [, ref, path] = m;
  if (!(SHA.test(ref) || ref === BRANCH)) return null;
  if (!DATA_PATH.test(path) || path.includes("..")) return null;
  return { kind: "file", ref, path };
}

export function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGINS || "").split(/[\s,]+/).filter(Boolean);
}

// The calling page's origin: Origin when the browser sent one (every fetch()),
// else the origin of Referer. Null unless listed.
export function callerOrigin(request, origins) {
  const origin = request.headers.get("Origin");
  if (origin !== null) return origins.includes(origin) ? origin : null;
  const referer = request.headers.get("Referer");
  if (!referer) return null;
  try {
    const o = new URL(referer).origin;
    return origins.includes(o) ? o : null;
  } catch {
    return null;
  }
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  };
}

function addVary(headers, name) {
  const vary = headers.get("Vary");
  if (!vary) headers.set("Vary", name);
  else if (!vary.split(",").some((v) => v.trim().toLowerCase() === name.toLowerCase())) headers.set("Vary", `${vary}, ${name}`);
}

function plain(status, text, headers = {}) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": NO_STORE,
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
      ...headers,
    },
  });
}

// Default export. `release(request)` calls the cached Release entrypoint
// (ctx.exports.Release.fetch in index.js; a stub in the tests).
export async function handleGateway(request, env, release) {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === "/robots.txt" && (method === "GET" || method === "HEAD")) {
    return new Response(method === "HEAD" ? null : ROBOTS, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400", "X-Robots-Tag": "noindex" },
    });
  }

  const origins = allowedOrigins(env);
  const origin = callerOrigin(request, origins);

  if (method === "OPTIONS") {
    if (!origin) return plain(403, "Forbidden\n");
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin),
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  if (!origin) return plain(403, "Forbidden\n");
  if (method !== "GET" && method !== "HEAD") {
    return plain(405, "Method not allowed\n", { ...corsHeaders(origin), Allow: "GET, HEAD, OPTIONS", Vary: "Origin" });
  }

  if (env.RATE_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return plain(429, "Too many requests. Try again in a minute.\n", {
        ...corsHeaders(origin),
        "Retry-After": RETRY_AFTER_SECONDS,
        Vary: "Origin",
      });
    }
  }

  const target = route(url.pathname);
  if (!target || target.kind === "robots") return plain(404, "Not found\n", { ...corsHeaders(origin), Vary: "Origin" });

  // A fresh request from the path alone: no query string (the cache key is
  // path plus query) and no headers but Range (Authorization or cookies would
  // make the cache bypass).
  const headers = {};
  const range = request.headers.get("Range");
  if (range) headers.Range = range;
  const res = await release(new Request(new URL(url.pathname, url.origin), { method, headers }));

  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
  addVary(out.headers, "Origin");
  out.headers.set("X-Robots-Tag", "noindex");
  return out;
}

function upstreamHeaders(env, extra = {}) {
  const headers = { "User-Agent": USER_AGENT, ...extra };
  // Absent in local development without worker/.dev.vars.
  if (env?.KCSC_DATA_TOKEN) headers.Authorization = `Bearer ${env.KCSC_DATA_TOKEN}`;
  return headers;
}

function contentType(path) {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// Turns GitHub's answer for one file into the Worker's: fresh headers only.
// GitHub gzips the JSON and NDJSON files (up to about 53 MB here). The body
// goes on still compressed, with its Content-Encoding and Content-Length: an
// unread body that keeps its Content-Encoding passes through the runtime
// without being decompressed and compressed again (Cloudflare docs, Workers
// Fetch, "Passthrough behavior"). mfa drops the header; its large files are
// PDFs, which GitHub does not compress.
function fileResponse(res, path, cacheControl, method) {
  if (res.status === 404 || res.status === 410) return plain(404, "Not found\n");
  if (res.status === 416) {
    const cr = res.headers.get("Content-Range");
    return plain(416, "Range not satisfiable\n", cr ? { "Content-Range": cr } : {});
  }
  if (res.status !== 200 && res.status !== 206) return plain(502, `GitHub answered ${res.status}\n`);

  const headers = new Headers({
    "Content-Type": contentType(path),
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  const etag = res.headers.get("ETag");
  if (etag) headers.set("ETag", etag);
  const encoding = res.headers.get("Content-Encoding");
  if (encoding) headers.set("Content-Encoding", encoding);
  const length = res.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  if (res.status === 206) {
    const cr = res.headers.get("Content-Range");
    if (cr) headers.set("Content-Range", cr);
  }
  return new Response(method === "HEAD" ? null : res.body, { status: res.status, headers });
}

// Release entrypoint. Fetches one file, or the commit at master, from GitHub.
export async function handleRelease(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const target = route(url.pathname);
  if (!target || target.kind === "robots") return plain(404, "Not found\n");

  if (target.kind === "ref") {
    let res;
    try {
      res = await fetchImpl(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
        headers: upstreamHeaders(env, { Accept: "application/vnd.github.sha", "X-GitHub-Api-Version": API_VERSION }),
      });
    } catch {
      return plain(502, "GitHub did not answer\n");
    }
    const sha = res.ok ? (await res.text()).trim() : "";
    if (!SHA.test(sha)) return plain(502, `GitHub answered ${res.status} for ${BRANCH}\n`);
    return new Response(sha, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": SHORT,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }

  const extra = {};
  const range = request.headers.get("Range");
  if (range) extra.Range = range;
  let res;
  try {
    res = await fetchImpl(`https://raw.githubusercontent.com/${REPO}/${target.ref}/${target.path}`, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: upstreamHeaders(env, extra),
    });
  } catch {
    return plain(502, "GitHub did not answer\n");
  }
  return fileResponse(res, target.path, SHA.test(target.ref) ? IMMUTABLE : SHORT, request.method);
}
