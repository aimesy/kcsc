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

[T&Cs](https://kcsc.amyc.us/terms.html)

The shared viewer data client validates `kcsc-data-manifest-v1`, keeps every
manifest/index/parquet/case request inside the configured data base, and exposes
one capability contract for future merged access clients. Canonical profiles
surface docket, hearing, party, counsel, representation, payment, charge,
judgment, document-index, provenance, and raw-source features. Legacy manifests
remain readable; new indexed filters appear only when the manifest declares the
corresponding compact-index field and positive feature row count.

The Statistics scope now follows the shared SFSC interaction model: Dashboard,
Aggregates, Attorney rankings, and Judgment rankings. It includes exact headline
totals, exact filing-year trends, type/location/status/node breakdowns,
case-versus-row feature coverage, seven attorney ranking measures, category
contributions, competition ranks, civil explicit-total and criminal-element
judgment rankings, dependent matter-type and matter-category judgment filters,
four views, sorting, limits, text filters, persisted controls, and CSV export. Ranking
resources load lazily through the unified data client; opening the dashboard
still does not download the full case index or either ranking payload.
