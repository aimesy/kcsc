# KCSC Viewer Data Contract

The viewer expects the `kcsc-data` split-repo layout:

| Path | Purpose |
|---|---|
| `data/manifest.json` | Startup counts, table paths, feature descriptors, and statistics segments. |
| `archive/cases-index/manifest.json` | Startup index shard metadata. |
| `archive/cases-index/<prefix>.ndjson` | Compact case rows loaded in bounded batches. |
| `data/cases.parquet` | One row per canonical case. |
| `data/calendar.parquet` | Hearing rows derived from KCSC Events/docket tabs. |
| `data/docket_entries.parquet` | Non-hearing docket/event rows. |
| `data/parties.parquet` | Party rows derived from Participants tabs. |
| `data/attorneys.parquet` | Attorney rows derived from represented-by text. |
| `data/representation.parquet` | Party to attorney links. |
| `data/payments.parquet` | Payment rows; currently emitted with an empty typed schema. |
| `archive/cases/<case_number>.json` | Full canonical record plus KCSC raw tab data. |

`data/manifest.json` uses `kcsc-data-manifest-v1`. Its `features` map declares
canonical detail paths, aggregate row counts, and compact `case_index_field`
names. `archive.case_index_fields` allows the viewer to enable only filters that
the currently published compact index can actually answer. The viewer accepts
the preceding unversioned manifest as a compatibility input.

The public `kcsc-viewer-data-client-v1` client resolves all manifest, directory,
index, parquet, and canonical case requests relative to one configured data
base. Absolute, traversal, credential-bearing, cross-origin, and cross-base
manifest paths fail closed.

The optional `statistics` member uses `kcsc-statistics-v1`. It declares the
one-canonical-case grain, generation timestamp, metric definitions, and fully
reconciled aggregate segments for all case-type and SEA/KNT location filter
combinations. Each segment contains filing-year, case-type, location, status,
and portal-node breakdowns plus both case coverage and row totals for every
declared feature. Statistics load with the manifest; opening the dashboard does
not download compact index shards or parquet tables.

When rankings are published, `statistics.ranking_sources` advertises two lazy,
same-base resources:

| Source | Format | Grain |
|---|---|---|
| `data/attorney-practice-rankings.json` | `kcsc-attorney-rankings-v1` | One stable KCSC attorney identity per matter topic, with per-category contributions. |
| `data/judgment-rankings.json` | `kcsc-judgment-rankings-v1` | One canonical case with at least one explicit positive dollar value in a preserved `Active` judgment cell. |

The attorney contract uses the same interoperable measure keys as SFSC where
the KCSC source supports them: `matter_count`, `matter_count_last_2_years`,
`practice_share_percent`, `judgment_total_amount`, `judgment_count`, and
`largest_judgment_amount`. KCSC uses `all_matter_count` because its source is
not limited to California civil practice. Stable `attorney_id` is the identity
key; names and optional bar numbers are display attributes.

KCSC judgment amounts have a narrower source meaning than SFSC judgment totals.
They are the sum, once per case, of explicit positive dollar values in preserved
KCSC `Active` judgment cells. The contract publishes that meaning in
`amount_semantics`; clients must not silently relabel it as a court-entered
total judgment.

Important KCSC differences from SFSC:

- Case numbers carry a location suffix, currently `SEA` or `KNT`.
- Criminal cases have charges preserved under `kcsc.charge_rows`.
- Judgment rows are preserved under `kcsc.judgment_rows`.
- KCSC document-list rows are preserved under `kcsc.document_rows_deferred`.
- Party-to-counsel edges are preserved in canonical `representation` and in
  `data/representation.parquet`; the viewer can derive legacy edges from
  `attorneys[].parties_represented`.
- Typed `payments` arrays and `data/payments.parquet` are part of the contract,
  even though the current corpus contains no payment rows.
- Document bytes are not captured yet, so no `documents.parquet` is emitted.
