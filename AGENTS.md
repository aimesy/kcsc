# KCSC product repository instructions

- This repository contains the public static viewer for King County Superior Court data.
- Keep bulk archive payloads out of this repo. The viewer loads `aimesy/kcsc-data` by default.
- Do not commit credentials, cookies, saved browser state, browser profiles, logs, or `/etc/kcsc` contents.
- Preserve the SFSC-style static viewer pattern: no server requirement, DuckDB WASM for parquet tables, and lazy per-case JSON loading.
- King County specific behavior matters: preserve SEA/KNT location suffixes, portal case IDs, civil/criminal/family/probate filtering, hearing rows, docket rows, and the current document-byte gap.
