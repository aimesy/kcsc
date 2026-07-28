# KCSC product repository instructions

- This repository contains the public static viewer for King County Superior Court data.
- Keep bulk archive payloads out of this repo. The viewer loads `aimesy/kcsc-data` by default.
- Do not commit credentials, cookies, saved browser state, browser profiles, logs, or `/etc/kcsc` contents.
- Preserve the SFSC-style static viewer pattern: no server requirement, DuckDB WASM for parquet tables, and lazy per-case JSON loading.
- King County specific behavior matters: preserve SEA/KNT location suffixes, portal case IDs, civil/criminal/family/probate filtering, hearing rows, docket rows, and the current document-byte gap.
- Never deploy operational scripts or systemd units from this product repository. `aimesy/kcsc-ops` is the sole canonical operational source.
- `scripts/prune_verified_raw_release.mjs` and `systemd/kcsc-raw-release-prune.service` are fail-closed historical placeholders retained only to document the old repository layout.
