# KCSC Repository Map

KCSC is split into three repositories:

| Repository | Visibility | Purpose |
|---|---|---|
| `aimesy/kcsc` | Public | Static viewer and public product documentation. |
| `aimesy/kcsc-data` | Public | Canonical case JSON, parquet tables, manifest, and compact indexes. |
| `aimesy/kcsc-ops` | Private | Capture runtime, systemd units, sanitized VPS runbooks, and maintenance scripts. |

The product viewer does not commit bulk data. It loads `kcsc-data` by default
from `https://raw.githubusercontent.com/aimesy/kcsc-data/master/`.
All public data access flows through `assets/js/kcsc-data-client.js`; operational
authentication and capture remain exclusively in `aimesy/kcsc-ops`.

## Operational source boundary

Only `aimesy/kcsc-ops` may supply KCSC capture, maintenance, pruning, or
systemd files to the VPS. The legacy product-repository paths
`scripts/prune_verified_raw_release.mjs` and
`systemd/kcsc-raw-release-prune.service` are retained as fail-closed historical
placeholders; they are not deployment inputs and must never be copied to
`/srv/kcsc/scripts` or `/etc/systemd/system`.

The ops repo must not contain `/etc/kcsc`, storage-state files, passwords,
cookies, browser profiles, generated logs, or live corpora. Data promotion is
from VPS capture outputs into `kcsc-data`, then the `kcsc` Pages workflow can
serve the updated viewer against the new data.
