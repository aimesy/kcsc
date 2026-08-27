import assert from 'node:assert/strict';

import {
  canonicalFeatureCounts,
  caseIndexFields,
  createKcscDataClient,
  describeKcscDataClient,
  featureAvailableInIndex,
  normalizeDataBase,
  representationRows,
  safeDataPath,
  validateKcscManifest,
} from './kcsc-data-client.js';

const tables = Object.fromEntries([
  'cases',
  'docket_entries',
  'parties',
  'attorneys',
  'representation',
  'calendar',
  'payments',
].map((name) => [name, {
  path: `data/${name}.parquet`,
  rows: name === 'cases' ? 2 : 0,
  size_bytes: 10,
}]));

const manifest = {
  format: 'kcsc-data-manifest-v1',
  court_id: 'kcsc',
  generated_at: '2026-08-27T00:00:00Z',
  archive: {
    cases: 2,
    cases_dir: 'archive/cases',
    cases_index: 'archive/cases-index/manifest.json',
    case_directory: 'archive/case-directory/manifest.json',
    case_index_fields: ['charge_count', 'representation_count'],
  },
  documents: { byte_capture: false, table: null },
  features: {
    charges: { rows: 3, case_index_field: 'charge_count', detail_path: 'kcsc.charge_rows' },
    representation: { rows: 1, case_index_field: 'representation_count', detail_path: 'representation' },
    payments: { rows: 0, case_index_field: 'payment_count', detail_path: 'payments' },
  },
  tables,
};

assert.equal(validateKcscManifest(structuredClone(manifest)).court_id, 'kcsc');
assert.throws(
  () => validateKcscManifest({ ...manifest, court_id: 'sfsc' }),
  /unexpected court_id/,
);
assert.throws(
  () => validateKcscManifest({
    ...manifest,
    tables: { ...tables, parties: { ...tables.parties, path: 'https://foreign.example/parties.parquet' } },
  }),
  /invalid path/,
);
assert.throws(
  () => validateKcscManifest({ ...manifest, archive: { ...manifest.archive, cases: 3 } }),
  /does not match archive count/,
);

assert.equal(safeDataPath('../secret'), '');
assert.equal(safeDataPath('https://foreign.example/data'), '');
assert.equal(safeDataPath('%2e%2e/secret'), '');
assert.equal(safeDataPath('archive/cases/262.json'), 'archive/cases/262.json');
assert.equal(
  normalizeDataBase('../kcsc-data', 'https://example.test/kcsc/'),
  'https://example.test/kcsc-data/',
);
assert.deepEqual([...caseIndexFields(manifest)], ['charge_count', 'representation_count']);
assert.equal(featureAvailableInIndex(manifest, 'charges'), true);
assert.equal(featureAvailableInIndex(manifest, 'payments'), false);

const record = {
  case_number: '262000011SEA',
  docket_entries: [{}],
  calendar: [{}, {}],
  parties: [{}],
  attorneys: [{
    attorney_id: 'bar:1',
    name: 'Counsel One',
    source: 'kcsc.participants',
    parties_represented: [{ party_id: 'party:1', party_seq: 1, name: 'Party One' }],
  }],
  payments: [{ amount: '$10.00' }],
  kcsc: {
    charge_rows: [{}, {}, {}],
    judgment_rows: [{}],
    document_rows_deferred: [{}, {}],
  },
};
assert.equal(representationRows(record)[0].party_name, 'Party One');
assert.deepEqual(canonicalFeatureCounts(record), {
  docket: 1,
  hearings: 2,
  parties: 1,
  counsel: 1,
  representation: 1,
  payments: 1,
  charges: 3,
  judgments: 1,
  documents: 2,
});
assert.equal(describeKcscDataClient().format, 'kcsc-viewer-data-client-v1');
assert.deepEqual(
  describeKcscDataClient().operations.slice(1, 4),
  ['statistics', 'attorney-rankings', 'judgment-rankings'],
);

const rankingManifest = {
  statistics: {
    ranking_sources: {
      attorney_rankings: { path: 'data/attorney-practice-rankings.json' },
      judgment_rankings: { path: 'data/judgment-rankings.json' },
    },
  },
};
const attorneyRankings = {
  format: 'kcsc-attorney-rankings-v1',
  topics: [{
    topic: 'all_matters', label: 'All matters',
    categories: [{ key: 'civil', label: 'Civil', case_count: 1 }],
    attorneys: [{
      attorney_id: 'bar:1', attorney_name: 'Counsel One', matter_count: 1,
      matter_count_last_2_years: 1, all_matter_count: 1, judgment_count: 0,
      category_contributions: [{ category_key: 'civil' }],
    }],
  }],
};
const judgmentRankings = {
  format: 'kcsc-judgment-rankings-v1',
  rows: [{ rank: 1, case_number: '262000011SEA', judgment_amount: 10 }],
};

const requests = [];
const client = createKcscDataClient({
  base: 'https://data.example/kcsc-data/',
  fetchImpl: async (input) => {
    requests.push(String(input));
    if (String(input).endsWith('data/manifest.json')) {
      return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } });
    }
    if (String(input).endsWith('data/attorney-practice-rankings.json')) {
      return new Response(JSON.stringify(attorneyRankings));
    }
    if (String(input).endsWith('data/judgment-rankings.json')) {
      return new Response(JSON.stringify(judgmentRankings));
    }
    return new Response(JSON.stringify(record));
  },
});
assert.equal((await client.manifest()).data.archive.cases, 2);
assert.equal((await client.caseRecord('26-2-00001-1 SEA')).data.case_number, '262000011SEA');
assert.equal((await client.attorneyRankings(rankingManifest)).data.topics[0].topic, 'all_matters');
assert.equal((await client.judgmentRankings(rankingManifest)).data.rows[0].judgment_amount, 10);
assert.equal(requests.length, 4);
await assert.rejects(client.fetch('https://foreign.example/data.json'), /escaped configured base/);

console.log('KCSC data client checks passed');
