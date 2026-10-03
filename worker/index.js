// Entrypoints for the kcsc-data Worker; the logic is in release.js.

import { WorkerEntrypoint } from "cloudflare:workers";
import { handleGateway, handleRelease } from "./release.js";

// Cached (wrangler.toml [exports.Release.cache]): one file from GitHub.
export class Release extends WorkerEntrypoint {
  fetch(request) {
    return handleRelease(request, this.env, fetch);
  }
}

// Not cached (wrangler.toml [exports.default.cache]): origin check and rate
// limit, then the cached Release entrypoint through ctx.exports.
export default {
  fetch(request, env, ctx) {
    return handleGateway(request, env, (req) => ctx.exports.Release.fetch(req));
  },
};
