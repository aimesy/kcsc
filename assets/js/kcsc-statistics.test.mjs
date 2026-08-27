import assert from 'node:assert/strict';

import {
  statisticsCoveragePercent,
  statisticsSegment,
  statisticsSegmentId,
  validateKcscStatistics,
} from './kcsc-statistics.js';

const featureNames = ['docket', 'documents'];
const featureRows = { docket: 4, documents: 2 };

function breakdown(cases, value = 'known') {
  return [{ value, cases }];
}

function segment(caseType, location, cases, features) {
  return {
    id: statisticsSegmentId(caseType, location),
    case_type: caseType,
    location,
    cases,
    breakdowns: {
      case_type: breakdown(cases, caseType || 'mixed'),
      filing_year: breakdown(cases, '2026'),
      location: breakdown(cases, location || 'mixed'),
      portal_node: breakdown(cases, '420'),
      status_group: breakdown(cases, 'Active'),
    },
    features,
  };
}

const none = { docket: { cases: 0, rows: 0 }, documents: { cases: 0, rows: 0 } };
const one = { docket: { cases: 1, rows: 4 }, documents: { cases: 1, rows: 2 } };
const statistics = {
  format: 'kcsc-statistics-v1',
  generated_at: '2026-08-27T00:00:00Z',
  grain: 'one canonical case',
  filters: { case_types: ['civil'], locations: ['KNT', 'SEA'] },
  segments: [
    segment('', '', 1, one),
    segment('civil', '', 1, one),
    segment('', 'KNT', 1, one),
    segment('', 'SEA', 0, none),
    segment('civil', 'KNT', 1, one),
    segment('civil', 'SEA', 0, none),
  ],
};
const manifestFeatures = Object.fromEntries(featureNames.map((name) => [name, { rows: featureRows[name] }]));
const validated = validateKcscStatistics(structuredClone(statistics), {
  expectedCases: 1,
  features: manifestFeatures,
  generatedAt: '2026-08-27T00:00:00Z',
});

assert.equal(statisticsSegment(validated, { caseType: 'civil', location: 'KNT' }).cases, 1);
assert.equal(statisticsSegment(validated, { caseType: 'civil', location: 'SEA' }).cases, 0);
assert.equal(statisticsCoveragePercent(1, 4), 25);
assert.equal(statisticsCoveragePercent(1, 0), 0);

const badCount = structuredClone(statistics);
badCount.segments[0].breakdowns.filing_year[0].cases = 2;
assert.throws(() => validateKcscStatistics(badCount, {
  expectedCases: 1,
  features: manifestFeatures,
  generatedAt: '2026-08-27T00:00:00Z',
}), /does not reconcile/);

const badRows = structuredClone(statistics);
badRows.segments[0].features.documents.rows = 3;
assert.throws(() => validateKcscStatistics(badRows, {
  expectedCases: 1,
  features: manifestFeatures,
  generatedAt: '2026-08-27T00:00:00Z',
}), /do not match/);

console.log('KCSC statistics checks passed');
