// Full docket text is fetched only from metered individual case records.
export const DOCKET_SEARCH_CASE_LIMIT = 20;

export function withoutDocketFilters(filters) {
  return {
    ...filters,
    parsed: { ...filters.parsed, filters: filters.parsed.filters.filter((filter) => filter.field !== 'docket') },
  };
}

export function docketRecordMatches(record, filters) {
  const haystack = (record.docket_entries || []).map((row) => [
    row.description, row.date_filed, row.entry_seq, row.fee, row.source, row.raw,
  ].map((value) => value == null ? '' : String(value)).join(' ')).join(' ').toLowerCase();
  return filters.every((filter) => haystack.includes(String(filter.value || '').toLowerCase()));
}

export async function scanDocketCandidates(rows, filters, { loadCase, current = () => true, onProgress = () => {} } = {}) {
  // Refuse broad scans, including callers that do not go through the UI.
  if (rows.length > DOCKET_SEARCH_CASE_LIMIT) throw new Error(`Narrow the case filters to ${DOCKET_SEARCH_CASE_LIMIT} cases or fewer before searching docket text.`);
  const matches = [];
  let scanned = 0;
  // Sequential loads avoid quota bursts and stop as soon as a check or limit fails.
  for (const row of rows) {
    if (!current()) return { matches, scanned, cancelled: true };
    const record = await loadCase(row.case_number);
    if (!current()) return { matches, scanned, cancelled: true };
    scanned += 1;
    if (docketRecordMatches(record, filters)) matches.push(row);
    onProgress({ scanned, total: rows.length });
  }
  return { matches, scanned, cancelled: false };
}
