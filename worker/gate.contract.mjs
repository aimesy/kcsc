// Checks of the browser check and the document limits (gate.js) through one
// Worker's gateway. Every data Worker's tests call checkGate with its own
// paths; the same file sits beside gate.js in each repository. Not imported
// by index.js, so it is never deployed.
//
//   checkGate({
//     handle(path, { method, headers, body, env, counters, fetchImpl, now }) -> Response,
//     env(extra) -> the Worker's env with origins, SESSION_KEY and TURNSTILE_SECRET_KEY,
//     site: "https://viewer.amyc.us",   an allowed Origin
//     document(i) -> path of the i-th distinct document,
//     slices: true if a document can be read in byte ranges,
//     index: path of an index file,
//     open: an open summary file path, or null,
//     cookiePrefix, sessionHeader,
//   })

import assert from "node:assert/strict";
import {
  FILE_LIMIT_MESSAGE, VISIBLE_ACTION, addressKey, durableCounters, limits, memoryCounters, memoryStorage,
  sha256Hex, storeAlarm, storeDoc, tooFastMessage,
} from "./gate.js";

const DAY = Date.UTC(2026, 9, 3, 12, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export async function checkGate(w) {
  const host = new URL(w.site).hostname;
  // Turnstile: answers success for the viewer's host, with the action the
  // widget would carry ("visible" when it was shown).
  const turnstile = (action = "") => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return Response.json({ success: true, hostname: host, action });
    };
    return { calls, fetchImpl };
  };
  const cookies = (res) => {
    const out = {};
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      out[pair.slice(0, i)] = { value: pair.slice(i + 1), line };
    }
    return out;
  };
  const S = `${w.cookiePrefix}_session`;
  const B = `${w.cookiePrefix}_browser`;
  const H = w.sessionHeader;

  // A browser: holds its cookies, starts sessions and asks for paths.
  function browser(ip, { env, counters, now }) {
    const jar = {};
    const header = () => Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
    const keep = (res) => { for (const [k, { value }] of Object.entries(cookies(res))) jar[k] = value || null; };
    return {
      jar,
      ip,
      async session({ action = "", key, at = now() } = {}) {
        const t = turnstile(action);
        const body = key ? JSON.stringify({ token: "tok", key }) : "tok";
        const res = await w.handle("/session", {
          method: "POST",
          headers: { Origin: w.site, "CF-Connecting-IP": ip, "Content-Type": "text/plain", Cookie: header() },
          body, env: env(), counters, fetchImpl: t.fetchImpl, now: at,
        });
        keep(res);
        return res;
      },
      async get(path, { at = now(), range } = {}) {
        const headers = { Origin: w.site, "CF-Connecting-IP": ip, Cookie: header() };
        if (range) headers.Range = range;
        const res = await w.handle(path, { headers, env: env(), counters, now: at });
        keep(res);
        return res;
      },
    };
  }
  const world = (extra = {}, start = DAY) => {
    let t = start;
    const counters = memoryCounters();
    return { counters, env: () => w.env({ REQUIRE_SESSION: "true", ...extra }), now: () => t, advance: (ms) => { t += ms; } };
  };

  // Sessions: a browser ID cookie (400 days) on the first check, and a
  // session cookie (12 hours) bound to the address that carries it.
  {
    const x = world();
    const b = browser("203.0.113.30", x);
    const t = turnstile();
    const res = await w.handle("/session", {
      method: "POST",
      headers: { Origin: w.site, "CF-Connecting-IP": b.ip, "Content-Type": "text/plain" },
      body: "tok", env: x.env(), counters: x.counters, fetchImpl: t.fetchImpl, now: x.now(),
    });
    assert.equal(res.status, 204);
    assert.equal(t.calls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const form = new URLSearchParams(t.calls[0].body);
    assert.equal(form.get("response"), "tok");
    assert.equal(form.get("remoteip"), b.ip);
    const set = cookies(res);
    assert.match(set[B].line, new RegExp(`^${B}=b1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; Max-Age=34560000; Path=/; Secure; HttpOnly; SameSite=Lax$`));
    assert.match(set[S].line, new RegExp(`^${S}=s2\\.\\d+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.0\\.[A-Za-z0-9_-]+; Max-Age=43200; Path=/; Secure; HttpOnly; SameSite=Lax$`));
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), w.site);
    assert.equal(res.headers.get("Access-Control-Allow-Credentials"), "true");
    assert.equal(res.headers.get(H), "ok");

    // The same browser keeps its ID on its next check.
    const bid = set[B].value.split(".")[1];
    const again = await w.handle("/session", {
      method: "POST",
      headers: { Origin: w.site, "CF-Connecting-IP": b.ip, Cookie: `${B}=${set[B].value}` },
      body: "tok", env: x.env(), counters: x.counters, fetchImpl: turnstile().fetchImpl, now: x.now(),
    });
    assert.equal(again.status, 204);
    assert.equal(cookies(again)[B], undefined, "no new browser ID");
    assert.equal(cookies(again)[S].value.split(".")[3], bid, "the session carries the browser ID");

    // Without the Turnstile secret no session can start.
    const off = await w.handle("/session", {
      method: "POST", headers: { Origin: w.site, "CF-Connecting-IP": b.ip }, body: "tok",
      env: w.env({ TURNSTILE_SECRET_KEY: "" }), counters: x.counters, fetchImpl: t.fetchImpl, now: x.now(),
    });
    assert.equal(off.status, 503);
    const empty = await w.handle("/session", { method: "POST", headers: { Origin: w.site }, body: "", env: x.env(), counters: x.counters, fetchImpl: t.fetchImpl, now: x.now() });
    assert.equal(empty.status, 400);
    const noOrigin = await w.handle("/session", { method: "POST", headers: {}, body: "tok", env: x.env(), counters: x.counters, fetchImpl: t.fetchImpl, now: x.now() });
    assert.equal(noOrigin.status, 403);
    const failed = await w.handle("/session", {
      method: "POST", headers: { Origin: w.site }, body: "tok", env: x.env(), counters: x.counters, now: x.now(),
      fetchImpl: async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
    });
    assert.equal(failed.status, 403);
    assert.match(await failed.text(), /invalid-input-response/);
    const elsewhere = await w.handle("/session", {
      method: "POST", headers: { Origin: w.site }, body: "tok", env: x.env(), counters: x.counters, now: x.now(),
      fetchImpl: async () => Response.json({ success: true, hostname: "evil.example" }),
    });
    assert.equal(elsewhere.status, 403);
  }

  // REQUIRE_SESSION "true": no session, another address, an expired or old
  // cookie all get 401; a session gets through; index files never count.
  {
    const x = world();
    const b = browser("203.0.113.40", x);
    const none = await b.get(w.index);
    assert.equal(none.status, 401);
    assert.equal(none.headers.get(H), "missing");
    assert.equal(none.headers.get("Access-Control-Allow-Credentials"), "true");
    assert.equal((await b.get(w.document(1))).status, 401);
    await b.session();
    const ok = await b.get(w.index);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get(H), "ok");
    for (let i = 0; i < 300; i++) assert.equal((await b.get(w.index)).status, 200, "index files never count");
    assert.equal([...x.counters.stores.keys()].filter((k) => k.startsWith("b:")).every((k) => !x.counters.stores.get(k).map.has("d:2026-10-03:")), true);

    const moved = browser("203.0.113.41", x);
    moved.jar[S] = b.jar[S];
    const res = await moved.get(w.index);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get(H), "invalid", "a copied cookie fails from another address");

    const late = await b.get(w.index, { at: x.now() + 13 * HOUR });
    assert.equal(late.status, 401, "a session lasts 12 hours");
    const old = browser("203.0.113.40", x);
    old.jar[S] = "v1.99999999999.abc";
    assert.equal((await old.get(w.index)).status, 401);
    const redeploy = await w.handle(w.index, {
      headers: { Origin: w.site, "CF-Connecting-IP": b.ip, Cookie: `${S}=${b.jar[S]}` },
      env: w.env({ REQUIRE_SESSION: "true", SESSION_KEY: "another-deploy" }), counters: x.counters, now: x.now(),
    });
    assert.equal(redeploy.status, 401, "a new deploy ends sessions");
  }

  // Open summary files: no session needed, Origin still required.
  if (w.open) {
    const x = world();
    const res = await w.handle(w.open, { headers: { Origin: w.site }, env: x.env(), counters: x.counters, now: x.now() });
    assert.equal(res.status, 200, `${w.open} is open`);
    const bare = await w.handle(w.open, { headers: {}, env: x.env(), counters: x.counters, now: x.now() });
    assert.equal(bare.status, 403);
  }

  // Each passed check allows DOCUMENTS_PER_CHECK distinct documents; a
  // document opened again that day is free; then a visible check is owed.
  {
    const x = world({ DOCUMENTS_PER_CHECK: "3" });
    const b = browser("198.51.100.10", x);
    await b.session();
    for (const i of [1, 2, 3, 1, 2]) assert.equal((await b.get(w.document(i))).status, 200, `document ${i}`);
    if (w.slices) {
      for (let k = 0; k < 5; k++) assert.equal((await b.get(w.document(3), { range: `bytes=${k * 1024}-${k * 1024 + 1023}` })).status, 200, "slices of one document are one document");
    }
    const spent = await b.get(w.document(4));
    assert.equal(spent.status, 401);
    assert.equal(spent.headers.get("X-Check"), "visible");
    assert.equal(spent.headers.get(H), "spent");
    assert.equal((await b.get(w.index)).status, 200, "index files still load");
    assert.equal((await b.get(w.document(2))).status, 200, "a document already opened today still opens");
    const hidden = await b.session();
    assert.equal(hidden.status, 401, "the next check must be visible");
    assert.equal(hidden.headers.get("X-Check"), "visible");
    const shown = await b.session({ action: VISIBLE_ACTION });
    assert.equal(shown.status, 204);
    for (const i of [4, 5, 6]) assert.equal((await b.get(w.document(i))).status, 200, `document ${i} after the visible check`);
    assert.equal((await b.get(w.document(7))).status, 401);
  }

  // DAILY_DOCUMENT_LIMIT per browser per UTC day, whatever the sessions.
  {
    const x = world({ DOCUMENTS_PER_CHECK: "100", DAILY_DOCUMENT_LIMIT: "4" });
    const b = browser("198.51.100.11", x);
    await b.session();
    for (let i = 1; i <= 4; i++) assert.equal((await b.get(w.document(i))).status, 200);
    const over = await b.get(w.document(5));
    assert.equal(over.status, 429);
    assert.equal(await over.text(), FILE_LIMIT_MESSAGE);
    assert.equal(over.headers.get("X-Limit"), "files");
    assert.equal(over.headers.get("Retry-After"), String(12 * 3600), "until midnight UTC");
    assert.equal(over.headers.get("Access-Control-Allow-Origin"), w.site);
    await b.session({ action: VISIBLE_ACTION });
    assert.equal((await b.get(w.document(5))).status, 429, "a new check does not reset the day");
    assert.equal((await b.get(w.document(1))).status, 200, "documents already opened today still open");
    x.advance(24 * HOUR);
    await b.session();
    assert.equal((await b.get(w.document(5))).status, 200, "the next UTC day starts again");
  }

  // WEEKLY_DOCUMENT_LIMIT in any WEEKLY_DAYS UTC days.
  {
    const x = world({ DAILY_DOCUMENT_LIMIT: "4", WEEKLY_DOCUMENT_LIMIT: "6" });
    const b = browser("198.51.100.12", x);
    await b.session();
    for (let i = 1; i <= 4; i++) assert.equal((await b.get(w.document(i))).status, 200);
    x.advance(24 * HOUR);
    await b.session();
    for (let i = 5; i <= 6; i++) assert.equal((await b.get(w.document(i))).status, 200);
    const over = await b.get(w.document(7));
    assert.equal(over.status, 429);
    assert.equal(await over.text(), FILE_LIMIT_MESSAGE);
    assert.equal(over.headers.get("Retry-After"), String(12 * 3600 + 5 * 86400), "until the first day leaves the window");
    x.advance(6 * 24 * HOUR);
    await b.session();
    assert.equal((await b.get(w.document(7))).status, 200, "the first day left the window");
  }

  // ADDRESS_DAILY_DOCUMENT_LIMIT across every browser at one address; a
  // refused document is not left on the browser's count.
  {
    const x = world({ ADDRESS_DAILY_DOCUMENT_LIMIT: "3" });
    const a = browser("192.0.2.50", x);
    const b = browser("192.0.2.50", x);
    await a.session();
    await b.session();
    for (let i = 1; i <= 2; i++) assert.equal((await a.get(w.document(i))).status, 200);
    assert.equal((await b.get(w.document(1))).status, 200, "a document the address already counted is free");
    assert.equal((await b.get(w.document(3))).status, 200);
    const over = await b.get(w.document(4));
    assert.equal(over.status, 429);
    assert.equal(await over.text(), FILE_LIMIT_MESSAGE);
    const other = browser("192.0.2.51", x);
    await other.session();
    assert.equal((await other.get(w.document(4))).status, 200, "another address is not affected");
  }

  // Too fast: more than RECHECK_DOCUMENTS_PER_MINUTE distinct documents in a
  // minute ends the session; no new one for RECHECK_PAUSE_SECONDS; then a
  // visible check.
  {
    const x = world({ RECHECK_DOCUMENTS_PER_MINUTE: "3" });
    const b = browser("198.51.100.13", x);
    await b.session();
    const old = b.jar[S];
    for (let i = 1; i <= 3; i++) assert.equal((await b.get(w.document(i))).status, 200);
    const fast = await b.get(w.document(4));
    assert.equal(fast.status, 429);
    assert.equal(await fast.text(), tooFastMessage(600));
    assert.equal(tooFastMessage(600), "Too many files at once. Wait 10 minutes and pass the check again. For bulk access, please email db@amyc.us.\n");
    assert.equal(fast.headers.get("X-Check"), "visible");
    assert.equal(fast.headers.get("X-Limit"), "fast");
    assert.equal(fast.headers.get("Retry-After"), "600");
    assert.equal(b.jar[S], null, "the session cookie is cleared");
    b.jar[S] = old;
    assert.equal((await b.get(w.document(1))).status, 429, "the old session cannot open documents while paused");
    b.jar[S] = null;
    const paused = await b.session({ action: VISIBLE_ACTION });
    assert.equal(paused.status, 429);
    assert.equal(paused.headers.get("X-Limit"), "fast");
    x.advance(10 * MINUTE + 1000);
    b.jar[S] = old;
    const ended = await b.get(w.document(1));
    assert.equal(ended.status, 401, "the ended session stays ended");
    assert.equal(ended.headers.get(H), "ended");
    assert.equal((await b.session()).status, 401, "the next check must be visible");
    assert.equal((await b.session({ action: VISIBLE_ACTION })).status, 204);
    assert.equal((await b.get(w.document(5))).status, 200);
    // Spread out, the same number of documents is fine.
    const c = browser("198.51.100.14", x);
    await c.session();
    for (let i = 1; i <= 8; i++) {
      assert.equal((await c.get(w.document(i))).status, 200);
      x.advance(25 * 1000);
    }
  }

  // The address backstop: MAX_SESSIONS_PER_ADDRESS_PER_HOUR, and
  // VISIBLE_CHECK_AFTER_TRIPS trips making every new check visible.
  {
    const x = world({ MAX_SESSIONS_PER_ADDRESS_PER_HOUR: "2" });
    const ip = "192.0.2.60";
    assert.equal((await browser(ip, x).session()).status, 204);
    assert.equal((await browser(ip, x).session()).status, 204);
    const third = await browser(ip, x).session();
    assert.equal(third.status, 429);
    assert.equal(third.headers.get("X-Limit"), "sessions");
    assert.equal(third.headers.get("Retry-After"), String(3600), "until the hour ends");
    x.advance(HOUR);
    assert.equal((await browser(ip, x).session()).status, 204, "the next hour starts again");

    const y = world({ RECHECK_DOCUMENTS_PER_MINUTE: "1", VISIBLE_CHECK_AFTER_TRIPS: "2" });
    const ip2 = "192.0.2.61";
    for (let n = 0; n < 2; n++) {
      const b = browser(ip2, y);
      await b.session();
      await b.get(w.document(1));
      assert.equal((await b.get(w.document(2))).status, 429);
    }
    const fresh = browser(ip2, y);
    assert.equal((await fresh.session()).status, 401, "after repeated trips every check from the address is visible");
    assert.equal((await fresh.session({ action: VISIBLE_ACTION })).status, 204);
    y.advance(24 * HOUR + 1000);
    assert.equal((await browser(ip2, y).session()).status, 204, "for 24 hours");
  }

  // Trusted keys: no document limits, 30 days, remembered by the browser
  // across deploys while the hash is listed.
  {
    const key = "trustedKeyForTests_0123456789abcdefghijklmnopq";
    const hash = await sha256Hex(key);
    const x = world({ DOCUMENTS_PER_CHECK: "1", DAILY_DOCUMENT_LIMIT: "1", WEEKLY_DOCUMENT_LIMIT: "1", ADDRESS_DAILY_DOCUMENT_LIMIT: "1", RECHECK_DOCUMENTS_PER_MINUTE: "1", TRUSTED_KEY_HASHES: `${hash} T` });
    const b = browser("198.51.100.20", x);
    const res = await b.session({ key });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get(H), "trusted");
    assert.match(cookies(res)[S].line, /; Max-Age=2592000;/);
    assert.match(b.jar[S], /^s2\.\d+\.[^.]+\.[^.]+\.1\./);
    for (let i = 1; i <= 20; i++) assert.equal((await b.get(w.document(i))).status, 200, `trusted document ${i}`);
    const doc = await b.get(w.document(21));
    assert.equal(doc.headers.get(H), "trusted");

    // A new deploy: the session ends, the browser's next check is trusted again.
    const redeploy = () => w.env({ REQUIRE_SESSION: "true", DOCUMENTS_PER_CHECK: "1", SESSION_KEY: "next-deploy", TRUSTED_KEY_HASHES: `${hash} T` });
    const after = await w.handle("/session", {
      method: "POST", headers: { Origin: w.site, "CF-Connecting-IP": b.ip, Cookie: `${B}=${b.jar[B]}` }, body: "tok",
      env: redeploy(), counters: x.counters, fetchImpl: turnstile().fetchImpl, now: x.now() + HOUR,
    });
    assert.equal(after.headers.get(H), "trusted", "the browser remembers the key");
    // Revoked: the hash is gone.
    const revoked = await w.handle("/session", {
      method: "POST", headers: { Origin: w.site, "CF-Connecting-IP": b.ip, Cookie: `${B}=${b.jar[B]}` }, body: "tok",
      env: w.env({ REQUIRE_SESSION: "true", SESSION_KEY: "third-deploy", TRUSTED_KEY_HASHES: "" }), counters: x.counters, fetchImpl: turnstile().fetchImpl, now: x.now() + 2 * HOUR,
    });
    assert.equal(revoked.status, 204);
    assert.equal(revoked.headers.get(H), "ok", "a revoked key no longer trusts the browser");
    // A wrong key: an ordinary session, flagged.
    const wrong = await browser("198.51.100.21", x).session({ key: "notTheKey_0123456789abcdefghijklmnopqrstuvwxy" });
    assert.equal(wrong.status, 204);
    assert.equal(wrong.headers.get(H), "ok");
    assert.equal(wrong.headers.get("X-Trusted-Key"), "refused");
  }

  // Report only (REQUIRE_SESSION not "true"): documents without a session
  // are served, and the address carries the daily limit and too fast.
  {
    const x = world({ REQUIRE_SESSION: "false", ADDRESS_DAILY_DOCUMENT_LIMIT: "3" });
    x.env = () => w.env({ REQUIRE_SESSION: "false", ADDRESS_DAILY_DOCUMENT_LIMIT: "3" });
    const b = browser("192.0.2.70", x);
    const first = await b.get(w.document(1));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get(H), "missing");
    assert.equal((await b.get(w.index)).status, 200);
    for (const i of [2, 3, 1]) assert.equal((await b.get(w.document(i))).status, 200);
    const over = await b.get(w.document(4));
    assert.equal(over.status, 429);
    assert.equal(await over.text(), FILE_LIMIT_MESSAGE);

    const y = world();
    y.env = () => w.env({ REQUIRE_SESSION: "false", RECHECK_DOCUMENTS_PER_MINUTE: "2" });
    const c = browser("192.0.2.71", y);
    for (const i of [1, 2]) assert.equal((await c.get(w.document(i))).status, 200);
    const fast = await c.get(w.document(3));
    assert.equal(fast.status, 429);
    assert.equal(fast.headers.get("X-Limit"), "fast");
    assert.equal((await c.get(w.index)).status, 200, "index files are not paused");
  }

  // The counters fail open; the session check does not.
  {
    const broken = { browser: () => ({ doc: async () => { throw new Error("down"); } }), address: () => ({ doc: async () => { throw new Error("down"); } }) };
    const x = world();
    const b = browser("198.51.100.30", x);
    await b.session();
    const res = await w.handle(w.document(1), { headers: { Origin: w.site, "CF-Connecting-IP": b.ip, Cookie: `${S}=${b.jar[S]}` }, env: x.env(), counters: broken, now: x.now() });
    assert.equal(res.status, 200, "an unreachable counter does not take the site down");
    const none = await w.handle(w.document(1), { headers: { Origin: w.site, "CF-Connecting-IP": b.ip }, env: x.env(), counters: broken, now: x.now() });
    assert.equal(none.status, 401);
  }

  // Logs carry the kind, session state and outcome, never an address.
  {
    const lines = [];
    const x = world();
    const ip = "198.51.100.77";
    await w.handle(w.document(1), { headers: { Origin: w.site, "CF-Connecting-IP": ip }, env: x.env(), counters: x.counters, now: x.now(), log: (l) => lines.push(l) });
    assert.ok(lines.length > 0);
    const last = JSON.parse(lines.at(-1));
    assert.equal(last.session, "missing");
    assert.equal(last.outcome, "no session");
    assert.ok(lines.every((l) => !l.includes(ip) && !l.includes(addressKey(ip))));
  }

  // Helpers: the Durable Object names, the defaults, the alarm.
  {
    const named = [];
    const ns = { idFromName: (n) => { named.push(n); return n; }, get: (id) => ({ id }) };
    const c = durableCounters(ns);
    assert.equal(c.browser("abc").id, "b:abc");
    assert.equal(c.address("192.0.2.1").id, "a:192.0.2.1");
    const L = limits({});
    assert.equal(L.DOCUMENTS_PER_CHECK, 100);
    assert.equal(L.DAILY_DOCUMENT_LIMIT, 500);
    assert.equal(L.WEEKLY_DOCUMENT_LIMIT, 1000);
    assert.equal(L.ADDRESS_DAILY_DOCUMENT_LIMIT, 2000);
    assert.equal(L.RECHECK_DOCUMENTS_PER_MINUTE, 50);
    assert.equal(L.RECHECK_PAUSE_SECONDS, 600);
    assert.equal(L.MAX_SESSIONS_PER_ADDRESS_PER_HOUR, 30);
    assert.equal(L.VISIBLE_CHECK_AFTER_TRIPS, 3);
    assert.equal(limits({ DAILY_DOCUMENT_LIMIT: "7" }).DAILY_DOCUMENT_LIMIT, 7);

    const s = memoryStorage();
    await storeDoc(s, { key: "k", day: "2026-10-03", now: DAY, sid: "s", sessionExp: DAY + HOUR, scope: "browser", limits: L });
    assert.ok(s.map.has("d:2026-10-03:k"));
    assert.ok(s.alarm > DAY);
    await storeDoc(s, { key: "k2", day: "2026-10-04", now: DAY + 24 * HOUR, sid: "s2", sessionExp: DAY + 25 * HOUR, scope: "browser", limits: L });
    assert.equal(s.map.has("d:2026-10-03:k"), false, "yesterday's documents are dropped");
    await storeAlarm(s, s.alarm - 1);
    assert.ok(s.map.size > 0, "an alarm before the keep time keeps the record");
    await storeAlarm(s, s.alarm + 1);
    assert.equal(s.map.size, 0, "an idle record deletes itself");
  }
}
