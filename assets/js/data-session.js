// The browser check for an amyc.us data Worker (TURNSTILE-SPEC.md, October
// 3, 2026). The same file is in aimesy/kcsc, nysc, tentatives and sfsc; the
// mfa viewer carries the same logic in its app.js, and the Worker side is
// worker/gate.js.
//
// Before the first data request the viewer passes Cloudflare Turnstile,
// invisibly unless Cloudflare wants an interaction, and posts the token to
// the Worker's /session, which answers with a session cookie. Data requests
// then go with credentials: "include". When the Worker answers 401 the viewer
// starts a new session once and retries; the check is shown (appearance
// "always") when the Worker says X-Check: visible. A refusal (a limit, a
// failed check) throws a DataRefusal carrying the Worker's own message.
//
// A trusted key arrives once in the fragment (#key=...), so it never reaches
// a server log or a Referer. It is taken out of the address bar when this
// module loads, before any router reads the hash, and sent with the next
// check.

export const TURNSTILE_SITEKEY = "0x4AAAAAAFM3PzdZrBklJy9m";
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const VISIBLE_ACTION = "visible";
// A browser Cloudflare will not pass is asked at most this often per page
// load, then told so, instead of being asked again for every file.
const MAX_CHECKS = 2;
const CHECK_REFUSED = "Cloudflare could not confirm that a person is using this browser. Reload to try again, or try another browser.";

export class DataRefusal extends Error {
  constructor(message, status, limit) {
    super(message);
    this.name = "DataRefusal";
    this.status = status;
    this.limit = limit || "";
  }
}

let pendingKey = takeTrustedKey();

function takeTrustedKey() {
  if (typeof location === "undefined" || !location.hash) return "";
  const m = /(^#|&)key=([A-Za-z0-9_-]{32,128})(?=&|$)/.exec(location.hash);
  if (!m) return "";
  let rest = location.hash.slice(0, m.index) + location.hash.slice(m.index + m[0].length);
  rest = rest.replace(/^#&/, "#").replace(/&$/, "");
  if (rest === "#") rest = "";
  history.replaceState(history.state, "", `${location.pathname}${location.search}${rest}`);
  return m[2];
}

let scriptPromise = null;
function turnstileReady(timeoutMs = 20000) {
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      if (!window.turnstile && !document.querySelector(`script[src="${TURNSTILE_SCRIPT}"]`)) {
        const s = document.createElement("script");
        s.src = TURNSTILE_SCRIPT;
        s.async = true;
        s.defer = true;
        document.head.append(s);
      }
      const started = Date.now();
      const poll = () => {
        if (window.turnstile?.render) resolve(window.turnstile);
        else if (Date.now() - started > timeoutMs) reject(new Error("The human check did not load."));
        else setTimeout(poll, 50);
      };
      poll();
    });
    scriptPromise.catch(() => { scriptPromise = null; });
  }
  return scriptPromise;
}

// The overlay that holds the widget when Cloudflare (or the Worker) wants it
// seen. Built here so no page needs markup or styles for it.
let overlay = null;
let widgetSlot = null;
function checkBox() {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Human check");
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", zIndex: "2147483000", display: "grid", placeItems: "center",
    padding: "1rem", visibility: "hidden", pointerEvents: "none",
  });
  const card = document.createElement("div");
  Object.assign(card.style, {
    padding: "0.75rem", borderRadius: "6px", background: "var(--paper, var(--bg, #fff))",
    border: "1px solid var(--rule, rgba(0, 0, 0, 0.2))", boxShadow: "0 8px 30px rgba(0, 0, 0, 0.25)",
  });
  const slot = document.createElement("div");
  card.append(slot);
  overlay.append(card);
  widgetSlot = slot;
  document.body.append(overlay);
  return overlay;
}
function showBox(on) {
  const box = checkBox();
  box.style.visibility = on ? "visible" : "hidden";
  box.style.pointerEvents = on ? "auto" : "none";
  box.style.background = on ? "rgba(0, 0, 0, 0.35)" : "transparent";
  box.setAttribute("aria-hidden", on ? "false" : "true");
}

export function createDataSession({ root }) {
  let sessionPromise = null;
  let refreshing = null;
  let widgetId = null;
  let pendingCheck = null;
  let failedChecks = 0;
  let checkVisible = false;

  const owns = (url) => String(url).startsWith(root);

  function token(visible) {
    return turnstileReady().then((ts) => new Promise((resolve, reject) => {
      checkBox();
      // A new check replaces any earlier one, which must not wait forever.
      pendingCheck?.(new Error("The human check was restarted."));
      pendingCheck = reject;
      if (widgetId !== null) ts.remove(widgetId);
      const options = {
        sitekey: TURNSTILE_SITEKEY,
        appearance: visible ? "always" : "interaction-only",
        retry: "never",
        callback: (t) => { showBox(false); resolve(t); },
        "error-callback": (code) => {
          showBox(false);
          reject(new Error(`The human check failed (${code}).`));
          return true;
        },
        "before-interactive-callback": () => showBox(true),
      };
      if (visible) options.action = VISIBLE_ACTION;
      widgetId = ts.render(widgetSlot, options);
      if (visible) showBox(true);
    }));
  }

  async function refusal(res, fallback) {
    const text = (await res.text().catch(() => "")).trim();
    return new DataRefusal(text || fallback, res.status, res.headers.get("X-Limit"));
  }

  function start() {
    if (failedChecks >= MAX_CHECKS) return Promise.reject(new Error(CHECK_REFUSED));
    const attempt = async (visible) => {
      const t = await token(visible);
      const res = await fetch(`${root}session`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "text/plain" },
        body: pendingKey ? JSON.stringify({ token: t, key: pendingKey }) : t,
      });
      if (res.ok) {
        if (res.headers.get("X-Trusted-Key") === "refused") console.warn("The trusted key in this link was not recognized.");
        pendingKey = "";
        checkVisible = false;
        return;
      }
      if (res.status === 401 && res.headers.get("X-Check") === "visible" && !visible) {
        checkVisible = true;
        return attempt(true);
      }
      if (res.headers.get("X-Check") === "visible") checkVisible = true;
      throw await refusal(res, `HTTP ${res.status} starting a session`);
    };
    return attempt(checkVisible).catch((err) => {
      // A limit is the Worker's answer, not a failed check.
      if (err instanceof DataRefusal && !/^Human check failed/.test(err.message)) throw err;
      failedChecks += 1;
      console.warn("human check", err);
      throw failedChecks >= MAX_CHECKS ? new Error(CHECK_REFUSED) : err;
    });
  }

  // The session for this Worker; one check at a time, however many requests
  // are waiting.
  function ensure() {
    if (refreshing) return refreshing;
    if (!sessionPromise) {
      sessionPromise = start();
      sessionPromise.catch(() => { sessionPromise = null; });
    }
    return sessionPromise;
  }

  // A new session after the Worker answered 401 (`res`, if given, says
  // whether the check must be visible).
  function renew(res) {
    if (res?.headers?.get("X-Check") === "visible") checkVisible = true;
    if (!refreshing) {
      refreshing = start().finally(() => { refreshing = null; });
      sessionPromise = refreshing;
      sessionPromise.catch(() => { sessionPromise = null; });
    }
    return refreshing;
  }

  // Throws the Worker's message for a refusal: 401 or 403, or 429 from a
  // document limit (X-Limit). A 429 from the flood guard has no X-Limit and
  // is handed back, so a viewer can wait it out.
  async function check(res, url = "") {
    if (res.status === 401 || res.status === 403 || (res.status === 429 && res.headers.get("X-Limit"))) {
      if (res.headers.get("X-Check") === "visible") checkVisible = true;
      throw await refusal(res, `HTTP ${res.status} reading ${url}`);
    }
    return res;
  }

  // fetch() for this Worker's files: with the session cookie, and once more
  // after a new check when the Worker asks for one. `raw` performs one
  // request (a viewer's own fetch with its timeout, for example).
  async function sessionFetch(url, init = {}, raw = (u, i) => fetch(u, i)) {
    if (!owns(url)) return raw(url, init);
    await ensure().catch(() => {});
    let res = await raw(url, { ...init, credentials: "include" });
    if (res.status === 401) {
      await renew(res);
      res = await raw(url, { ...init, credentials: "include" });
    }
    return check(res, url);
  }

  // Links that open one of this Worker's documents in a new tab. A plain
  // click is checked first with a HEAD request, which counts the document
  // and shows the check when one is owed, and the tab opens after it; a
  // refusal goes to onRefusal instead of a tab with the Worker's plain text.
  // Clicks with a modifier key keep the browser's own behaviour.
  function guardLinks({ match = owns, onRefusal = (err) => window.alert(err.message) } = {}) {
    document.addEventListener("click", async (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const a = event.target?.closest?.("a[href]");
      if (!a || a.hasAttribute("download") || !match(a.href)) return;
      event.preventDefault();
      const href = a.href;
      const blank = a.target === "_blank";
      // Opened now, while the click still counts as the reader's; filled in
      // once the check is done.
      const tab = blank ? window.open("about:blank", "_blank") : null;
      if (tab) tab.opener = null;
      try {
        await sessionFetch(href, { method: "HEAD" });
        if (tab) tab.location.replace(href);
        else if (blank) window.open(href, "_blank", "noopener");
        else location.assign(href);
      } catch (err) {
        tab?.close();
        onRefusal(err);
      }
    });
  }

  return { root, owns, ensure, renew, check, fetch: sessionFetch, guardLinks };
}
