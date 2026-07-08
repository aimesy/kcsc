# KCSC viewer

Static King County Superior Court case viewer.

This repo is the public product surface. It loads normalized parquet tables and
canonical case JSON from `aimesy/kcsc-data`.

Published site:

```text
https://aimesy.github.io/kcsc/
```

No `CNAME` is committed right now. `kcsc.amyc.us` should only be restored after
Cloudflare has a DNS-only `CNAME` from `kcsc` to `aimesy.github.io`; otherwise
GitHub Pages redirects the working site to a dead hostname.

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
- `data/cases.parquet`
- `data/docket_entries.parquet`
- `data/parties.parquet`
- `data/attorneys.parquet`
- `data/representation.parquet`
- `data/calendar.parquet`
- `archive/cases/<case_number>.json`

KCSC does not yet have document-byte capture. The viewer surfaces deferred
document rows from each case JSON instead of pretending document downloads exist.
