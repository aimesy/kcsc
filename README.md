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
- `data/cases.parquet`
- `data/docket_entries.parquet`
- `data/parties.parquet`
- `data/attorneys.parquet`
- `data/representation.parquet`
- `data/calendar.parquet`
- `archive/cases/<case_number>.json`

KCSC does not yet have document-byte capture. The viewer surfaces deferred
document rows from each case JSON instead of pretending document downloads exist.
