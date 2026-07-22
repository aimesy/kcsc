# KCSC Viewer Data Contract

The viewer expects the `kcsc-data` split-repo layout:

| Path | Purpose |
|---|---|
| `data/manifest.json` | Startup counts and table paths. |
| `archive/cases-index/manifest.json` | Startup index shard metadata. |
| `archive/cases-index/<prefix>.ndjson` | Compact case rows loaded in bounded batches. |
| `data/cases.parquet` | One row per canonical case. |
| `data/calendar.parquet` | Hearing rows derived from KCSC Events/docket tabs. |
| `data/docket_entries.parquet` | Non-hearing docket/event rows. |
| `data/parties.parquet` | Party rows derived from Participants tabs. |
| `data/attorneys.parquet` | Attorney rows derived from represented-by text. |
| `data/representation.parquet` | Party to attorney links. |
| `archive/cases/<case_number>.json` | Full canonical record plus KCSC raw tab data. |

Important KCSC differences from SFSC:

- Case numbers carry a location suffix, currently `SEA` or `KNT`.
- Criminal cases have charges preserved under `kcsc.charge_rows`.
- KCSC document-list rows are preserved under `kcsc.document_rows_deferred`.
- Document bytes are not captured yet, so no `documents.parquet` is emitted.
