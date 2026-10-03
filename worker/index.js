// Entrypoints for the kcsc-data Worker; the logic is in release.js and gate.js.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { handleGateway, handleRelease } from "./release.js";
import { durableCounters, quotaMethods, storeAlarm } from "./gate.js";

// Cached (wrangler.toml [exports.Release.cache]): one file from GitHub.
export class Release extends WorkerEntrypoint {
  fetch(request) {
    return handleRelease(request, this.env, fetch);
  }
}

// The document counters (gate.js): one object per browser ID ("b:<id>") and
// one per address ("a:<address>"). Named as in aimesy/mfa.
export class DailyQuota extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.methods = quotaMethods(ctx.storage);
  }
  doc(args) { return this.methods.doc(args); }
  refund(args) { return this.methods.refund(args); }
  status(args) { return this.methods.status(args); }
  browserSession(args) { return this.methods.browserSession(args); }
  addressSession(args) { return this.methods.addressSession(args); }
  sessionGate(args) { return this.methods.sessionGate(args); }
  trip(args) { return this.methods.trip(args); }
  alarm() { return storeAlarm(this.ctx.storage); }
}

// Not cached (wrangler.toml [exports.default.cache]): origin check, flood
// guard, session check and document limits, then the cached Release
// entrypoint through ctx.exports.
export default {
  fetch(request, env, ctx) {
    return handleGateway(request, env, {
      release: (req) => ctx.exports.Release.fetch(req),
      counters: durableCounters(env.DAILY_QUOTA),
    });
  },
};
