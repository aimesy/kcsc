# KCSC Repository Map

KCSC is split into three repositories:

| Repository | Visibility | Purpose |
|---|---|---|
| `aimesy/kcsc` | Public | Static viewer and public product documentation. |
| `aimesy/kcsc-data` | Public | Canonical case JSON, parquet tables, manifest, and compact indexes. |
| `aimesy/kcsc-ops` | Private | Capture runtime, systemd units, sanitized VPS runbooks, and maintenance scripts. |

The product viewer does not commit bulk data. It loads `kcsc-data` by default
from `https://raw.githubusercontent.com/aimesy/kcsc-data/master/`.

The ops repo must not contain `/etc/kcsc`, storage-state files, passwords,
cookies, browser profiles, generated logs, or live corpora. Data promotion is
from VPS capture outputs into `kcsc-data`, then the `kcsc` Pages workflow can
serve the updated viewer against the new data.
