import assert from 'node:assert/strict';

import {
  createDirectoryClient,
  directoryGroups,
  directorySourceBatches,
  filingYear,
  parseNdjsonRows,
  rowMatchesGroup,
  safeDirectoryPath,
  statusGroup,
  uniqueDirectorySources,
  validateDirectoryManifest,
} from './kcsc-directory.js';

const manifest = {
  format: 'kcsc-case-directory-v1',
  case_count: 3,
  case_types: [
    {
      case_type: 'civil',
      rows: 2,
      locations: [
        {
          location_code: 'SEA',
          rows: 2,
          years: [
            { year: '2026', rows: 1, sources: [{ path: 'archive/cases-index/262.ndjson', rows: 2, size_bytes: 42 }] },
            { year: '2025', rows: 1, sources: [{ path: 'archive/cases-index/252.ndjson', rows: 1, size_bytes: 21 }] },
          ],
        },
      ],
    },
    {
      case_type: 'criminal',
      rows: 1,
      locations: [
        {
          location_code: 'KNT',
          rows: 1,
          years: [
            { year: '2026', rows: 1, sources: [{ path: 'archive/cases-index/261.ndjson', rows: 1, size_bytes: 20 }] },
          ],
        },
      ],
    },
  ],
};

assert.equal(validateDirectoryManifest(structuredClone(manifest), 3).case_count, 3);
assert.throws(() => validateDirectoryManifest({ ...manifest, case_count: 4 }, 4), /group count/);
assert.throws(() => validateDirectoryManifest({ ...manifest, format: 'legacy' }), /unsupported/);
assert.equal(safeDirectoryPath('../escape.ndjson'), '');
assert.equal(safeDirectoryPath('https://foreign.example/x'), '');
assert.equal(filingYear('2026-08-21'), '2026');
assert.equal(statusGroup('Completed 08/01/2026'), 'Completed');

const groups = directoryGroups(manifest, { caseType: 'civil', from: '2026-01-01' });
assert.equal(groups.length, 1);
assert.equal(groups[0].year, '2026');
assert.equal(uniqueDirectorySources(groups).length, 1);
assert.equal(rowMatchesGroup({ case_type: 'civil', location_code: 'SEA', filed_date: '2026-01-02' }, groups[0]), true);
assert.equal(rowMatchesGroup({ case_type: 'civil', location_code: 'KNT', filed_date: '2026-01-02' }, groups[0]), false);
assert.deepEqual(
  directorySourceBatches(directoryGroups(manifest)).map((batch) => [batch.year, batch.sources.map((source) => source.path)]),
  [
    ['2026', ['archive/cases-index/262.ndjson', 'archive/cases-index/261.ndjson']],
    ['2025', ['archive/cases-index/252.ndjson']],
  ],
);

assert.deepEqual(parseNdjsonRows('{"case_number":"one"}\n\n{"case_number":"two"}\n').map((row) => row.case_number), ['one', 'two']);
assert.throws(() => parseNdjsonRows('{bad}\n'), /line 1/);

let fetches = 0;
let resolveFetch;
const pendingResponse = new Promise((resolve) => { resolveFetch = resolve; });
const client = createDirectoryClient({
  base: 'https://data.example/root/',
  fetchImpl: async () => {
    fetches += 1;
    await pendingResponse;
    return new Response('{"case_number":"one"}\n', { headers: { 'Content-Length': '22' } });
  },
});
const source = { path: 'archive/cases-index/262.ndjson' };
const first = client.loadSource(source);
const second = client.loadSource(source);
resolveFetch();
const [a, b] = await Promise.all([first, second]);
assert.equal(fetches, 1);
assert.equal(a, b);
assert.equal(a.rows[0].case_number, 'one');
assert.equal(client.sourceUrl(source.path), 'https://data.example/root/archive/cases-index/262.ndjson');

let retryFetches = 0;
const retryClient = createDirectoryClient({
  base: 'https://data.example/root/',
  fetchImpl: async () => {
    retryFetches += 1;
    if (retryFetches === 1) return new Response('', { status: 503 });
    return new Response('{"case_number":"recovered"}\n');
  },
});
await assert.rejects(retryClient.loadSource(source), /HTTP 503/);
assert.equal((await retryClient.loadSource(source)).rows[0].case_number, 'recovered');
assert.equal(retryFetches, 2);

console.log('KCSC directory checks passed');
