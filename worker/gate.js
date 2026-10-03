// The browser check and the document limits shared by every data Worker
// (TURNSTILE-SPEC.md, October 3, 2026). The canonical copy is aimesy/mfa
// worker/gate.js; aimesy/kcsc, nysc, tentatives and sfsc carry the same file,
// and each Worker's release.js decides which paths are documents.
// Kept free of Workers-only imports so each repository's tests run it under
// Node. index.js wires the DailyQuota Durable Object to the store functions.
//
// How it works:
//   POST /session    the viewer sends a Turnstile token (and, once, a trusted
//                    key from the page's #key= fragment). The Worker answers
//                    with a session cookie (12 hours, bound to the address)
//                    that carries a browser ID, and gives a browser that has
//                    none a browser ID cookie (400 days).
//   documents        PDFs and per case dockets. Each passed check allows
//                    DOCUMENTS_PER_CHECK distinct documents; then a visible
//                    check gives the next batch. A browser may open at most
//                    DAILY_DOCUMENT_LIMIT a UTC day and WEEKLY_DOCUMENT_LIMIT
//                    in any WEEKLY_DAYS days; an address at most
//                    ADDRESS_DAILY_DOCUMENT_LIMIT a day. More than
//                    RECHECK_DOCUMENTS_PER_MINUTE distinct documents within
//                    RECHECK_WINDOW_SECONDS ends the session and asks for a
//                    visible check after RECHECK_PAUSE_SECONDS.
//   index files      everything a viewer draws its tables from. They need a
//                    session but never count.
//   trusted keys     a session redeemed with a key whose SHA-256 is listed in
//                    TRUSTED_KEY_HASHES has no document limits and lasts
//                    TRUSTED_SESSION_SECONDS. The browser keeps that trust
//                    until the same time, so a new session after a deploy or
//                    an address change stays trusted while the hash is listed.
// Every number is a Worker variable (wrangler.toml [vars]); DEFAULTS below
// apply only when one is missing.
//
// The counters fail open: a Durable Object that cannot be reached never takes
// a site down. The session check never fails open.

export const DEFAULTS = Object.freeze({
  SESSION_SECONDS: 12 * 60 * 60,
  TRUSTED_SESSION_SECONDS: 30 * 24 * 60 * 60,
  BROWSER_ID_SECONDS: 400 * 24 * 60 * 60,
  DOCUMENTS_PER_CHECK: 100,
  DAILY_DOCUMENT_LIMIT: 500,
  WEEKLY_DOCUMENT_LIMIT: 1000,
  WEEKLY_DAYS: 7,
  ADDRESS_DAILY_DOCUMENT_LIMIT: 2000,
  RECHECK_DOCUMENTS_PER_MINUTE: 50,
  RECHECK_WINDOW_SECONDS: 60,
  RECHECK_PAUSE_SECONDS: 600,
  MAX_SESSIONS_PER_ADDRESS_PER_HOUR: 30,
  VISIBLE_CHECK_AFTER_TRIPS: 3,
  TRIP_WINDOW_SECONDS: 24 * 60 * 60,
  // How long an idle counter is kept before its Durable Object deletes itself.
  BROWSER_RECORD_SECONDS: 8 * 24 * 60 * 60,
  ADDRESS_RECORD_SECONDS: 2 * 24 * 60 * 60,
});

export const FILE_LIMIT_MESSAGE = "File limit exceeded. For bulk access, please email db@amyc.us.\n";
export function tooFastMessage(pauseSeconds) {
  const minutes = Math.max(1, Math.round(pauseSeconds / 60));
  return `Too many files at once. Wait ${minutes} minutes and pass the check again. For bulk access, please email db@amyc.us.\n`;
}
function nextBatchMessage(perCheck) {
  return `Pass the check again to open the next ${perCheck} files.\n`;
}

// The Turnstile action the viewer sets when it shows the widget (appearance
// "always"); a check the Worker asked to be visible must carry it.
export const VISIBLE_ACTION = "visible";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const NO_STORE = "no-store";
const DAY_MS = 24 * 60 * 60 * 1000;

export function limits(env) {
  const out = {};
  for (const [name, fallback] of Object.entries(DEFAULTS)) {
    const raw = env?.[name];
    const value = raw === undefined || raw === null || String(raw).trim() === "" ? NaN : Number(raw);
    out[name] = Number.isFinite(value) && value >= 0 ? value : fallback;
  }
  return out;
}

export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function secondsToMidnightUtc(now) {
  const d = new Date(now);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

// The key limits and sessions are kept under: the IPv4 address, or the /64
// network of an IPv6 address (a household or phone can use any address in
// its /64, so counting each one separately would count nothing).
export function addressKey(ip) {
  const value = String(ip || "").trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  if (mapped) return mapped[1];
  if (!value.includes(":")) return value || "unknown";
  const [head, tail = ""] = value.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = value.includes("::") && tail ? tail.split(":") : [];
  const groups = value.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}

// ------------------------------------------------------------------ crypto

const encoder = new TextEncoder();

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(text))));
}

export async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomId() {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// The browser ID cookie must outlive deploys, so it is signed with
// BROWSER_KEY, or failing that a key derived from TURNSTILE_SECRET_KEY (a
// Worker without that secret cannot start sessions at all). Rotating the
// Turnstile secret gives every browser a new ID at its next check.
async function browserKey(env) {
  if (env?.BROWSER_KEY) return String(env.BROWSER_KEY);
  if (!env?.TURNSTILE_SECRET_KEY) return "";
  return hmac(String(env.TURNSTILE_SECRET_KEY), "aimesy data worker browser id key v1");
}

const ID = /^[A-Za-z0-9_-]{16,64}$/;

export async function makeBrowserCookie(env, bid) {
  return `b1.${bid}.${await hmac(await browserKey(env), `b1.${bid}`)}`;
}

export async function readBrowserId(request, env, cfg) {
  const value = cookieValue(request.headers.get("Cookie"), `${cfg.cookiePrefix}_browser`);
  const m = /^b1\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]+)$/.exec(value || "");
  if (!m) return null;
  const key = await browserKey(env);
  if (!key) return null;
  return sameString(await hmac(key, `b1.${m[1]}`), m[2]) ? m[1] : null;
}

// The session cookie: s2.<exp>.<sid>.<bid>.<trusted>.<sig>, signed with the
// SESSION_KEY of this deploy over those fields and the address.
export async function makeSession(key, { exp, sid, bid, trusted }, address) {
  const body = `s2.${exp}.${sid}.${bid}.${trusted ? 1 : 0}`;
  return `${body}.${await hmac(key, `${body}.${address}`)}`;
}

// { state, sid, bid, trusted, exp }; state is "ok", "trusted", "missing" or
// "invalid" (expired, forged, from another address, or from an older deploy).
export async function readSession(request, env, address, now, cfg) {
  const value = cookieValue(request.headers.get("Cookie"), `${cfg.cookiePrefix}_session`);
  if (!value) return { state: "missing" };
  const m = /^s2\.(\d{1,12})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{16,64})\.([01])\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!env?.SESSION_KEY || !m || Number(m[1]) * 1000 < now) return { state: "invalid" };
  const body = `s2.${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  if (!sameString(await hmac(env.SESSION_KEY, `${body}.${address}`), m[5])) return { state: "invalid" };
  const trusted = m[4] === "1";
  return { state: trusted ? "trusted" : "ok", exp: Number(m[1]), sid: m[2], bid: m[3], trusted };
}

export function hasSession(session) {
  return session.state === "ok" || session.state === "trusted";
}

// TRUSTED_KEY_HASHES: "<sha256 hex> <label> <sha256 hex> <label> ...".
export function trustedHashes(env) {
  return String(env?.TRUSTED_KEY_HASHES || "").split(/\s+/).filter((t) => /^[0-9a-f]{64}$/.test(t));
}

// ------------------------------------------------------------------ responses

export function plain(status, text, headers = {}) {
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

function clearSessionCookie(cfg) {
  return `${cfg.cookiePrefix}_session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

// ------------------------------------------------------------------ Turnstile

function turnstileHostnames(env, cfg) {
  if (env?.TURNSTILE_HOSTNAMES) return String(env.TURNSTILE_HOSTNAMES).split(/[\s,]+/).filter(Boolean);
  return (cfg.origins || []).map((o) => {
    try {
      return new URL(o).hostname;
    } catch {
      return "";
    }
  }).filter(Boolean);
}

async function verifyTurnstile(token, ip, env, cfg, fetchImpl) {
  try {
    const res = await fetchImpl(SITEVERIFY, {
      method: "POST",
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
    });
    const out = await res.json();
    if (out.success === true && turnstileHostnames(env, cfg).includes(out.hostname)) return { ok: true, action: String(out.action || "") };
    return { ok: false, why: (out["error-codes"] || []).join(" ") || `hostname ${out.hostname}` };
  } catch {
    return { ok: false, why: "Turnstile did not answer" };
  }
}

// The /session body: the Turnstile token alone (older viewers), or JSON
// {"token": "...", "key": "..."} sent as text/plain so it needs no preflight.
function parseSessionBody(text) {
  const body = String(text || "").trim();
  if (body.startsWith("{")) {
    try {
      const o = JSON.parse(body);
      return { token: typeof o.token === "string" ? o.token.trim() : "", key: typeof o.key === "string" ? o.key.trim() : "" };
    } catch {
      return { token: "", key: "" };
    }
  }
  return { token: body, key: "" };
}

// POST /session. `counters` is { browser(bid), address(address) }, each
// answering a stub with the store functions below as methods (the DailyQuota
// Durable Object in index.js, an in-memory store in the tests).
export async function startSession(request, env, { ip, address, cors, cfg, counters, fetchImpl = fetch, now = Date.now(), log = () => {} }) {
  const L = limits(env);
  const text = await request.text();
  if (text.length > 4096) return plain(400, "Request too large\n", cors);
  const { token, key } = parseSessionBody(text);
  if (!token || token.length > 2048) return plain(400, "Missing human check token\n", cors);
  if (!env.SESSION_KEY || !env.TURNSTILE_SECRET_KEY) {
    log({ kind: "session", outcome: "not configured" });
    return plain(503, "Sessions are not configured\n", cors);
  }
  const headerName = cfg.sessionHeader;

  // The address: too many new sessions this hour, or repeated trips.
  let gate = { ok: true, visible: false, retryAfter: 0 };
  try {
    gate = await counters.address(address).sessionGate({ now, limits: L });
  } catch (err) {
    console.error("address counter unavailable", err);
  }
  if (!gate.ok) {
    log({ kind: "session", outcome: "address sessions" });
    const minutes = Math.max(1, Math.ceil(gate.retryAfter / 60));
    return plain(429, `Too many checks from this address. Try again in ${minutes} minutes.\n`, { ...cors, "Retry-After": String(gate.retryAfter), "X-Limit": "sessions" });
  }

  // The browser: paused after going too fast, or owed a visible check.
  let bid = await readBrowserId(request, env, cfg);
  let status = { pausedUntil: 0, visible: false, trust: null };
  if (bid) {
    try {
      status = await counters.browser(bid).status({ now });
    } catch (err) {
      console.error("browser counter unavailable", err);
    }
  }
  if (status.pausedUntil > now) {
    log({ kind: "session", outcome: "paused" });
    return plain(429, tooFastMessage(L.RECHECK_PAUSE_SECONDS), {
      ...cors,
      "Retry-After": String(Math.ceil((status.pausedUntil - now) / 1000)),
      "X-Check": "visible",
      "X-Limit": "fast",
    });
  }

  const check = await verifyTurnstile(token, ip, env, cfg, fetchImpl);
  if (!check.ok) {
    log({ kind: "session", outcome: "check failed" });
    return plain(403, `Human check failed: ${check.why}\n`, cors);
  }
  const visible = check.action === VISIBLE_ACTION;
  if ((gate.visible || status.visible) && !visible) {
    log({ kind: "session", outcome: "visible check needed" });
    return plain(401, "Pass the check shown on the page.\n", { ...cors, "X-Check": "visible" });
  }

  // A trusted key, redeemed now or remembered by this browser.
  const hashes = trustedHashes(env);
  let trustedUntil = 0;
  let redeemed = null;
  let keyRefused = false;
  if (key) {
    const hash = /^[A-Za-z0-9_-]{32,128}$/.test(key) ? await sha256Hex(key) : "";
    if (hash && hashes.includes(hash)) {
      trustedUntil = now + L.TRUSTED_SESSION_SECONDS * 1000;
      redeemed = { hash, until: trustedUntil };
    } else {
      keyRefused = true;
    }
  }
  if (!trustedUntil && status.trust && hashes.includes(status.trust.hash) && status.trust.until > now) {
    trustedUntil = Math.min(status.trust.until, now + L.TRUSTED_SESSION_SECONDS * 1000);
  }
  const trusted = trustedUntil > now;

  const headers = new Headers(cors);
  headers.set("Cache-Control", NO_STORE);
  headers.set("X-Robots-Tag", "noindex");
  if (!bid) {
    bid = randomId();
    headers.append("Set-Cookie", `${cfg.cookiePrefix}_browser=${await makeBrowserCookie(env, bid)}; Max-Age=${L.BROWSER_ID_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax`);
  }
  const sid = randomId();
  const expMs = trusted ? trustedUntil : now + L.SESSION_SECONDS * 1000;
  const exp = Math.floor(expMs / 1000);
  const value = await makeSession(env.SESSION_KEY, { exp, sid, bid, trusted }, address);
  headers.append("Set-Cookie", `${cfg.cookiePrefix}_session=${value}; Max-Age=${Math.max(1, exp - Math.floor(now / 1000))}; Path=/; Secure; HttpOnly; SameSite=Lax`);
  headers.set(headerName, trusted ? "trusted" : "ok");
  if (keyRefused) headers.set("X-Trusted-Key", "refused");

  try {
    await counters.address(address).addressSession({ now, limits: L });
  } catch (err) {
    console.error("address counter unavailable", err);
  }
  try {
    await counters.browser(bid).browserSession({ now, sid, exp: expMs, visible, trust: redeemed, limits: L });
  } catch (err) {
    console.error("browser counter unavailable", err);
  }
  log({ kind: "session", outcome: trusted ? "trusted" : visible ? "visible" : "started" });
  return new Response(null, { status: 204, headers });
}

// Charges one document request. Answers { refusal, outcome }: refusal is null
// to serve it, or the Response to send instead; outcome goes to the log.
// `key` names the document independent of ref and byte range.
export async function chargeDocument(env, { session, address, key, cors, cfg, counters, now = Date.now() }) {
  if (session.trusted) return { refusal: null, outcome: "trusted" };
  const L = limits(env);
  const day = utcDay(now);
  const fileLimit = (retryAfter) => plain(429, FILE_LIMIT_MESSAGE, { ...cors, "Retry-After": String(retryAfter), "X-Limit": "files" });
  const tooFast = (retryAfter, clear) => plain(429, tooFastMessage(L.RECHECK_PAUSE_SECONDS), {
    ...cors,
    "Retry-After": String(retryAfter),
    "X-Check": "visible",
    "X-Limit": "fast",
    ...(clear ? { "Set-Cookie": clearSessionCookie(cfg) } : {}),
  });
  try {
    if (hasSession(session)) {
      const browser = counters.browser(session.bid);
      const r = await browser.doc({ key, day, now, sid: session.sid, sessionExp: session.exp * 1000, scope: "browser", limits: L });
      if (!r.ok) {
        if (r.why === "fast") {
          try {
            await counters.address(address).trip({ now, limits: L });
          } catch (err) {
            console.error("address counter unavailable", err);
          }
          return { refusal: tooFast(L.RECHECK_PAUSE_SECONDS, true), outcome: "too fast" };
        }
        if (r.why === "paused") return { refusal: tooFast(r.retryAfter, true), outcome: "paused" };
        if (r.why === "ended") {
          return {
            refusal: plain(401, "This session ended. Pass the check again.\n", { ...cors, "X-Check": "visible", [cfg.sessionHeader]: "ended", "Set-Cookie": clearSessionCookie(cfg) }),
            outcome: "ended",
          };
        }
        if (r.why === "check") {
          return {
            refusal: plain(401, nextBatchMessage(L.DOCUMENTS_PER_CHECK), { ...cors, "X-Check": "visible", [cfg.sessionHeader]: "spent" }),
            outcome: "check spent",
          };
        }
        return { refusal: fileLimit(r.retryAfter), outcome: r.why };
      }
      if (r.charged) {
        const a = await counters.address(address).doc({ key, day, now, scope: "address", limits: L });
        if (!a.ok) {
          await browser.refund({ key, day, sid: session.sid });
          return { refusal: fileLimit(a.retryAfter), outcome: "address" };
        }
      }
      return { refusal: null, outcome: r.charged ? "counted" : "seen" };
    }
    // No session: only while REQUIRE_SESSION is off (report only). The
    // address carries the daily limit and the too fast rule on its own.
    const a = await counters.address(address).doc({ key, day, now, scope: "sessionless", limits: L });
    if (!a.ok) {
      if (a.why === "fast" || a.why === "paused") return { refusal: tooFast(a.why === "fast" ? L.RECHECK_PAUSE_SECONDS : a.retryAfter, false), outcome: a.why };
      return { refusal: fileLimit(a.retryAfter), outcome: "address" };
    }
    return { refusal: null, outcome: a.charged ? "counted" : "seen" };
  } catch (err) {
    // A counter that cannot be reached must not take the site down.
    console.error("document counter unavailable", err);
    return { refusal: null, outcome: "counter unavailable" };
  }
}

// ------------------------------------------------------------------ store
// The counters, written against the Durable Object storage API (get, put,
// delete, list, setAlarm, deleteAll) so the tests can use an in-memory copy.
// One object per browser ("b:<id>") and one per address ("a:<address>").
// Keys: "m" holds the record; "d:<day>:<document>" marks a document opened
// that UTC day.

async function loadMeta(storage, day) {
  const meta = (await storage.get("m")) || {};
  if (meta.day !== day) {
    if (meta.day) {
      const old = [...(await storage.list({ prefix: `d:${meta.day}:` })).keys()];
      for (let i = 0; i < old.length; i += 128) await storage.delete(old.slice(i, i + 128));
    }
    meta.day = day;
    meta.today = 0;
  }
  meta.days = meta.days || {};
  meta.sessions = meta.sessions || {};
  meta.win = meta.win || [];
  meta.trips = meta.trips || [];
  return meta;
}

function keepDays(days, day, count) {
  const out = {};
  const start = Date.parse(`${day}T00:00:00Z`) - (count - 1) * DAY_MS;
  for (const [d, n] of Object.entries(days)) if (Date.parse(`${d}T00:00:00Z`) >= start && n > 0) out[d] = n;
  return out;
}

// Seconds until the rolling window's count falls below the limit.
function weeklyRetryAfter(days, day, now, count, limit) {
  const today = Date.parse(`${day}T00:00:00Z`);
  for (let k = 1; k <= count; k++) {
    const start = today + k * DAY_MS - (count - 1) * DAY_MS;
    let sum = 0;
    for (const [d, n] of Object.entries(days)) if (Date.parse(`${d}T00:00:00Z`) >= start) sum += n;
    if (sum < limit) return secondsToMidnightUtc(now) + (k - 1) * 86400;
  }
  return secondsToMidnightUtc(now) + (count - 1) * 86400;
}

// The alarm stays at least keepSeconds past the last change, and is moved
// (one write) only when it falls inside that, so most changes skip it.
async function save(storage, meta, now, keepSeconds) {
  if (!meta.alarmAt || meta.alarmAt < now + keepSeconds * 1000) {
    meta.alarmAt = now + 2 * keepSeconds * 1000;
    await storage.setAlarm(meta.alarmAt);
  }
  await storage.put("m", meta);
}

// One document request. scope "browser": per check, daily, weekly and too
// fast; "address": the address's daily limit only; "sessionless": the
// address's daily limit and too fast (report only mode).
export async function storeDoc(storage, { key, day, now, sid, sessionExp, scope, limits: L }) {
  const meta = await loadMeta(storage, day);
  const browser = scope === "browser";
  const fastOn = scope !== "address";
  const keep = browser ? Math.max(L.BROWSER_RECORD_SECONDS, L.WEEKLY_DAYS * 86400) : L.ADDRESS_RECORD_SECONDS;

  if (fastOn && meta.pausedUntil > now) return { ok: false, why: "paused", retryAfter: Math.ceil((meta.pausedUntil - now) / 1000) };
  if (browser && meta.sessions[sid]?.ended) return { ok: false, why: "ended" };

  if (fastOn) {
    const since = now - L.RECHECK_WINDOW_SECONDS * 1000;
    meta.win = meta.win.filter(([, t]) => t > since);
    if (!meta.win.some(([k]) => k === key)) meta.win.push([key, now]);
    if (meta.win.length > L.RECHECK_DOCUMENTS_PER_MINUTE) {
      meta.pausedUntil = now + L.RECHECK_PAUSE_SECONDS * 1000;
      meta.visible = true;
      meta.win = [];
      if (browser && sid) meta.sessions[sid] = { ...(meta.sessions[sid] || { n: 0, exp: sessionExp || now }), ended: true };
      await save(storage, meta, now, keep);
      return { ok: false, why: "fast" };
    }
  }

  const docKey = `d:${day}:${key}`;
  if (await storage.get(docKey)) {
    if (fastOn) await save(storage, meta, now, keep);
    return { ok: true, charged: false };
  }

  if (browser) {
    meta.days = keepDays(meta.days, day, L.WEEKLY_DAYS);
    const today = meta.days[day] || 0;
    const week = Object.values(meta.days).reduce((a, b) => a + b, 0);
    if (today >= L.DAILY_DOCUMENT_LIMIT) {
      await save(storage, meta, now, keep);
      return { ok: false, why: "daily", retryAfter: secondsToMidnightUtc(now) };
    }
    if (week >= L.WEEKLY_DOCUMENT_LIMIT) {
      await save(storage, meta, now, keep);
      return { ok: false, why: "weekly", retryAfter: weeklyRetryAfter(meta.days, day, now, L.WEEKLY_DAYS, L.WEEKLY_DOCUMENT_LIMIT) };
    }
    for (const [s, v] of Object.entries(meta.sessions)) if (v.exp < now) delete meta.sessions[s];
    const session = meta.sessions[sid] || { n: 0, exp: sessionExp || now };
    if (session.n >= L.DOCUMENTS_PER_CHECK) {
      meta.visible = true;
      meta.sessions[sid] = session;
      await save(storage, meta, now, keep);
      return { ok: false, why: "check" };
    }
    session.n += 1;
    meta.sessions[sid] = session;
    meta.days[day] = today + 1;
  } else {
    if ((meta.today || 0) >= L.ADDRESS_DAILY_DOCUMENT_LIMIT) {
      if (fastOn) await save(storage, meta, now, keep);
      return { ok: false, why: "address", retryAfter: secondsToMidnightUtc(now) };
    }
    meta.today = (meta.today || 0) + 1;
  }
  await storage.put(docKey, 1);
  await save(storage, meta, now, keep);
  return { ok: true, charged: true };
}

// Takes back a document the browser counted but the address refused.
export async function storeRefund(storage, { key, day, sid }) {
  const meta = (await storage.get("m")) || {};
  if (meta.day !== day) return;
  const docKey = `d:${day}:${key}`;
  if (!(await storage.get(docKey))) return;
  await storage.delete(docKey);
  if (meta.days?.[day]) meta.days[day] -= 1;
  if (meta.sessions?.[sid]?.n) meta.sessions[sid].n -= 1;
  await storage.put("m", meta);
}

// What /session needs to know about a browser.
export async function storeStatus(storage, { now }) {
  const meta = (await storage.get("m")) || {};
  return {
    pausedUntil: meta.pausedUntil > now ? meta.pausedUntil : 0,
    visible: Boolean(meta.visible),
    trust: meta.trust && meta.trust.until > now ? meta.trust : null,
  };
}

// A browser was given a session: register it, clear an owed visible check
// once one passed, and remember a redeemed key.
export async function storeBrowserSession(storage, { now, sid, exp, visible, trust, limits: L }) {
  const meta = await loadMeta(storage, utcDay(now));
  for (const [s, v] of Object.entries(meta.sessions)) if (v.exp < now) delete meta.sessions[s];
  meta.sessions[sid] = { n: 0, exp };
  if (visible) meta.visible = false;
  if (trust) meta.trust = trust;
  const keep = Math.max(L.BROWSER_RECORD_SECONDS, L.WEEKLY_DAYS * 86400, meta.trust ? Math.ceil((meta.trust.until - now) / 1000) : 0);
  await save(storage, meta, now, keep);
}

function hourOf(now) {
  return Math.floor(now / 3600000);
}

// Before a check is verified: too many sessions from this address this hour,
// or a visible check owed after repeated trips.
export async function storeSessionGate(storage, { now, limits: L }) {
  const meta = (await storage.get("m")) || {};
  const since = now - L.TRIP_WINDOW_SECONDS * 1000;
  const trips = (meta.trips || []).filter((t) => t > since);
  const count = meta.hour === hourOf(now) ? meta.hourCount || 0 : 0;
  if (count >= L.MAX_SESSIONS_PER_ADDRESS_PER_HOUR) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil(((hourOf(now) + 1) * 3600000 - now) / 1000)) };
  }
  return { ok: true, visible: trips.length >= L.VISIBLE_CHECK_AFTER_TRIPS };
}

export async function storeAddressSession(storage, { now, limits: L }) {
  const meta = await loadMeta(storage, utcDay(now));
  if (meta.hour !== hourOf(now)) {
    meta.hour = hourOf(now);
    meta.hourCount = 0;
  }
  meta.hourCount += 1;
  await save(storage, meta, now, L.ADDRESS_RECORD_SECONDS);
}

export async function storeTrip(storage, { now, limits: L }) {
  const meta = await loadMeta(storage, utcDay(now));
  const since = now - L.TRIP_WINDOW_SECONDS * 1000;
  meta.trips = meta.trips.filter((t) => t > since);
  meta.trips.push(now);
  await save(storage, meta, now, L.ADDRESS_RECORD_SECONDS);
}

// The alarm: a record idle past its keep time deletes itself, unless a
// remembered trusted key still has time left.
export async function storeAlarm(storage, now = Date.now()) {
  const meta = (await storage.get("m")) || {};
  const next = Math.max(meta.alarmAt || 0, meta.trust && meta.trust.until > now ? meta.trust.until : 0);
  if (next > now) {
    await storage.setAlarm(next);
    return;
  }
  await storage.deleteAll();
}

// The counters as index.js exposes them (one DailyQuota object per name).
export function durableCounters(namespace) {
  const get = (name) => namespace.get(namespace.idFromName(name));
  return { browser: (bid) => get(`b:${bid}`), address: (address) => get(`a:${address}`) };
}

// An in-memory storage with the same methods, for the tests.
export function memoryStorage() {
  const map = new Map();
  let alarm = null;
  return {
    map,
    get alarm() { return alarm; },
    async get(k) { return Array.isArray(k) ? new Map(k.filter((x) => map.has(x)).map((x) => [x, structuredClone(map.get(x))])) : structuredClone(map.get(k)); },
    async put(k, v) { map.set(k, structuredClone(v)); },
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) map.delete(x); },
    async list({ prefix = "" } = {}) { return new Map([...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))); },
    async setAlarm(t) { alarm = t; },
    async deleteAll() { map.clear(); alarm = null; },
  };
}

// Methods a DailyQuota object answers, over one storage.
export function quotaMethods(storage) {
  return {
    doc: (args) => storeDoc(storage, args),
    refund: (args) => storeRefund(storage, args),
    status: (args) => storeStatus(storage, args),
    browserSession: (args) => storeBrowserSession(storage, args),
    addressSession: (args) => storeAddressSession(storage, args),
    sessionGate: (args) => storeSessionGate(storage, args),
    trip: (args) => storeTrip(storage, args),
  };
}

// In-memory counters for the tests: the same store functions, one storage
// per name.
export function memoryCounters() {
  const stores = new Map();
  const get = (name) => {
    if (!stores.has(name)) stores.set(name, memoryStorage());
    return quotaMethods(stores.get(name));
  };
  return { stores, browser: (bid) => get(`b:${bid}`), address: (address) => get(`a:${address}`) };
}
