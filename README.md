# KCSC viewer

Static King County Superior Court case viewer.

This repo is the public product surface. It loads normalized parquet tables and
canonical case JSON from `aimesy/kcsc-data`.

Published site:

```text
https://kcsc.amyc.us/
```

Fallback GitHub Pages URL:

```text
https://aimesy.github.io/kcsc/
```

Cloudflare DNS must keep a DNS-only `CNAME` from `kcsc` to `aimesy.github.io`
so GitHub Pages can issue and renew the custom-domain certificate.

Local smoke test from `C:\Users\amita\Amybot\projects`:

```bash
python -m http.server 8765
```

Then open:

```text
http://127.0.0.1:8765/kcsc/?dataBase=../kcsc-data/
```

Data contract:

- `data/manifest.json`
- `assets/js/kcsc-data-client.js` (`kcsc-viewer-data-client-v1`)
- `assets/js/kcsc-statistics.js` (`kcsc-statistics-v1`)
- `data/attorney-practice-rankings.json` (`kcsc-attorney-rankings-v1`)
- `data/judgment-rankings.json` (`kcsc-judgment-rankings-v1`)
- `archive/cases-index/manifest.json`
- `archive/cases-index/<prefix>.ndjson`
- `data/cases.parquet`
- `data/docket_entries.parquet`
- `data/parties.parquet`
- `data/attorneys.parquet`
- `data/representation.parquet`
- `data/calendar.parquet`
- `data/payments.parquet`
- `archive/cases/<case_number>.json`

KCSC does not yet have document-byte capture. The viewer surfaces deferred
document rows from each case JSON instead of pretending document downloads exist.

[T&Cs](https://amyc.us/terms)

The shared viewer data client validates `kcsc-data-manifest-v1`, keeps every
manifest/index/parquet/case request inside the configured data base, and exposes
one capability contract for future merged access clients. Canonical profiles
surface docket, hearing, party, counsel, representation, payment, charge,
judgment, document-index, provenance, and raw-source features. Legacy manifests
remain readable; new indexed filters appear only when the manifest declares the
corresponding compact-index field and positive feature row count.

The Statistics scope now follows the shared SFSC interaction model: Dashboard,
Case types, Attorney rankings, and Judgment rankings. It includes exact headline
totals, exact filing-year trends, type/location/status/node breakdowns,
with complete/partial/unavailable capture-day status on every filing year,
case-versus-row feature coverage, seven attorney ranking measures, category
contributions, competition ranks, civil explicit-total and criminal-element
judgment rankings, dependent matter-type and matter-category judgment filters,
four views, sorting, limits, text filters, persisted controls, and CSV export. Ranking
resources load lazily through the unified data client; opening the dashboard
still does not download the full case index or either ranking payload.

## Data Worker

`aimesy/kcsc-data` is private, so the viewer reads it through `worker/`, a
Cloudflare Worker on the custom domain `kcsc-data.amyc.us`, adapted from the
one in `aimesy/mfa`. The Worker holds a GitHub token that can read the contents
of `aimesy/kcsc-data` and nothing else, because a token cannot be given to the
browser. Its URLs mirror `raw.githubusercontent.com`, and the viewer's
`REMOTE_DATA_BASE` is `https://kcsc-data.amyc.us/master/`:

The viewer's Bulk access control opens an email draft to `db@amyc.us` rather
than linking visitors to the private data repository. The bug reporter still
uses the public `aimesy/kcsc` issue tracker. Keep private data repository URLs
out of public controls; `scripts/check_viewer_static.mjs` checks this boundary.

| Path | Answer |
|---|---|
| `/master/<path>` | that file at the head of `master`, cached for 60 seconds |
| `/<commit>/<path>` | that file at a full commit hash, cached for a year as immutable (`?dataBase=https://kcsc-data.amyc.us/<commit>/`) |
| `/ref` | the commit at `master`, as text, cached for 60 seconds |
| `/robots.txt` | disallows everything; every answer also carries `X-Robots-Tag: noindex` |

`<path>` must match `DATA_PATH` in `worker/release.js`: `data/manifest.json`,
the two ranking files it lists, the metadata-only browse tables (`parties-browse` and `attorneys-browse`;
the canonical parquet tables, including `docket_entries`, are not served),
`archive/case-directory/manifest.json`, the index shards and manifest under
`archive/cases-index/` (and the legacy `archive/cases-index.ndjson`), and
`archive/cases/<CASE>.json`. Anything else in the repository, such as
`data/source-runs.json` or `archive/promotions/`, is a 404.
`tests/worker.test.mjs` checks the list against every file the viewer read on
2026-10-03 and runs the viewer's own data client through the Worker. If
`kcsc-data` starts publishing a file under a new name, widen `DATA_PATH` and the
test together. The viewer reads no release assets, the repository has no LFS
objects, and its largest file, `data/calendar.parquet` (91,914,420 bytes on
2026-10-03), is no longer served.

The Worker has two entrypoints. The default one is uncached: it answers CORS
preflights, refuses (403) any request whose `Origin`, or failing that
`Referer`, is not listed in `ALLOWED_ORIGINS` in `worker/wrangler.toml`: the
viewer at `https://kcsc.amyc.us` (`https://aimesy.github.io/kcsc/` redirects
there) and the home page at `https://amyc.us`, whose `assets/projects.js` in
`aimesy/me` reads `data/manifest.json` for its live figures. It also limits
each address (an IPv4 address, or an IPv6 /64) with the Workers Rate Limiting
binding (300 requests a minute). Over the limit it answers 429 with
`Retry-After`. Then come the browser check and the document limits in
`worker/gate.js`, the same file every data Worker carries (canonical copy in
`aimesy/mfa`):

- The viewer passes Cloudflare Turnstile (`assets/js/data-session.js`),
  invisibly unless Cloudflare wants a click, and posts the token to `/session`.
  The Worker answers with a session cookie for 12 hours, bound to the address,
  and on the first check a browser ID cookie for 400 days. With
  `REQUIRE_SESSION = "true"` a request without a session gets 401, except the
  open summary files in `OPEN_PATHS` (`/master/data/manifest.json`, which the
  home page reads).
- Documents are each case's own record, `archive/cases/<CASE>.json`
  (`documentKey` in `worker/release.js`); the manifest, directory, index
  shards, parquet tables and ranking files never count. A record counts once
  a UTC day however often it is reopened. Each check allows 100 distinct
  records, then a visible check gives the next 100; a browser may open 500 a
  UTC day and 1,000 in any 7 days, an address 2,000 a day.
  Past those the Worker answers 429 "File limit exceeded. For bulk access,
  please email db@amyc.us." More than 50 in a minute ends the session and asks
  for a visible check after 10 minutes. A trusted key (`TRUSTED_KEY_HASHES`,
  made with `scripts/new-trusted-key.mjs` in `aimesy/mfa`) lifts the document
  limits for 30 days. Every number is a variable in `worker/wrangler.toml`, and
  the `DailyQuota` Durable Object keeps the counts; if it cannot be reached,
  requests go through.

It then
sends the cached `Release` entrypoint a fresh request built from the path and
`Range` alone. `Release` fetches the file from GitHub with the token and
returns it with its own content type, `ETag` and cache headers, and Workers
Caching stores it. The default entrypoint must stay uncached, or a cache hit
would skip the origin check and the rate limit. GitHub sends the JSON and
NDJSON files gzipped; `Release` keeps `Content-Encoding` and `Content-Length`,
so the compressed body passes through the Worker without being decoded and
reaches the browser compressed, as it did from `raw.githubusercontent.com`.

Secrets, in this repository's Actions secrets:

- `KCSC_DATA_ACCESS`: a fine-grained GitHub token with read access to the
  contents of `aimesy/kcsc-data` and nothing else. The workflow stores it as
  the Worker secret `KCSC_DATA_TOKEN`.
- `TURNSTILE_SECRET_KEY`: the secret key of the Turnstile widget the five
  amyc.us viewers share; its site key is in `assets/js/data-session.js`. The
  workflow stores it as the Worker secret of the same name, with a new random
  `SESSION_KEY` on each deploy. Without it the Worker still deploys, but
  `/session` answers 503.
- `CLOUDFLARE_API_KEY`: a Cloudflare API token from the "Edit Cloudflare
  Workers" template, limited to the account and the `amyc.us` zone. The
  workflow hands it to Wrangler as `CLOUDFLARE_API_TOKEN`.

`.github/workflows/pages.yml` deploys the Worker first (job `data-worker`), and
the Pages deploy waits for it, so a failed Worker deploy leaves the current site
live. Each Worker deploy empties its cache, so a push redeploys the Worker only
when `worker/` or the workflow changed since the last successful run; run the
workflow by hand (Actions, Deploy Pages, Run workflow) to redeploy it anyway,
for example after replacing `KCSC_DATA_ACCESS`. After each deploy the workflow
checks the live Worker from the runner: `/ref`, the manifest, a table, an index
shard and one case record with the site's `Origin`, a 403 without it, and a 404
for a file the viewer never reads. Bot Fight Mode on `amyc.us` answers GitHub's
runners with a challenge before the Worker runs; the check then warns that it
could not reach the Worker, and the Pages deploy goes ahead.

The Worker runs on Cloudflare's free plan: 100,000 requests a day for the whole
account, shared with its other Workers. With caching on, the default entrypoint
and `Release` each count, so every file the viewer reads costs two requests,
cached or not. Opening the site reads the manifest and the case directory; a
search across the archive reads up to 67 index shards; the party and
counsel views read metadata-only parquet tables. Docket text is read through
individual case records. Past the daily limit Cloudflare answers error
1027 until midnight UTC; nothing is billed.

To run it locally, put `KCSC_DATA_TOKEN=<token>` in `worker/.dev.vars` (git
ignores it), run `npx wrangler@4 dev` in `worker/`, and open the viewer with
`?dataBase=` set to the address it prints followed by `/master/`. Allow the
viewer's local origin for that session with
`npx wrangler@4 dev --var "ALLOWED_ORIGINS:http://127.0.0.1:8765"`.

## Protected browse data

The Parties and Counsel scopes read `data/parties-browse.parquet` and
`data/attorneys-browse.parquet`. These contain names, roles, bar numbers and
case links; source rows, addresses and contact blocks stay in the private
canonical tables and in metered per-case records. The canonical publication
builder in `aimesy/kcsc-ops` regenerates these projections on every refresh.
The Worker refuses all original parquet paths at master and historical commits.
Protected gateway responses use `private, no-store`; the inner Release cache
still caches the source bytes after the session and document checks.

A `docket:` query first filters the compact case metadata. Narrow the other
filters to 20 cases or fewer, then press the docket-search button to load those
individual records. Each newly opened case consumes the ordinary document
allowance. The results describe all cases matching the metadata filters; a
broader query loads no docket text and asks for narrower filters. This replaces
the previous archive-wide full-text table scan. Case docket and hearing tabs,
location suffixes, portal IDs, statistics and capture coverage are preserved.
