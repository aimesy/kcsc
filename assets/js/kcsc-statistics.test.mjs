import assert from 'node:assert/strict';

import {
  statisticsCoveragePercent,
  statisticsSegment,
  statisticsSegmentId,
  validateKcscAttorneyRankings,
  validateKcscJudgmentRankings,
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
  filing_year_coverage: {
    schema: 'kcsc-filing-year-coverage-v1',
    years: [
      { year: '2024', complete_days: 112, expected_days: 366, status: 'partial' },
      { year: '2025', complete_days: 365, expected_days: 365, status: 'complete' },
      { year: '2026', complete_days: 0, expected_days: 238, status: 'unavailable' },
    ],
  },
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

const badCoverage = structuredClone(statistics);
badCoverage.filing_year_coverage.years[0].status = 'complete';
assert.throws(() => validateKcscStatistics(badCoverage, {
  expectedCases: 1,
  features: manifestFeatures,
  generatedAt: '2026-08-27T00:00:00Z',
}), /invalid statistics filing-year coverage row/);

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

const attorneyRankings = validateKcscAttorneyRankings({
  format: 'kcsc-attorney-rankings-v1',
  topics: [{
    topic: 'all_matters',
    label: 'All matters',
    categories: [{ key: 'civil', label: 'Civil', case_count: 1 }],
    attorneys: [{
      attorney_id: 'bar:123', attorney_name: 'Counsel One', bar_number: '123',
      matter_count: 1, matter_count_last_2_years: 1, all_matter_count: 1,
      judgment_count: 1,
      category_contributions: [{ category_key: 'civil' }],
    }],
  }],
});
assert.equal(attorneyRankings.topics[0].attorneys[0].attorney_id, 'bar:123');
assert.throws(() => validateKcscAttorneyRankings({
  ...attorneyRankings,
  topics: [{ ...attorneyRankings.topics[0], attorneys: [
    attorneyRankings.topics[0].attorneys[0], attorneyRankings.topics[0].attorneys[0],
  ] }],
}), /invalid attorney identity/);

const judgmentRankings = validateKcscJudgmentRankings({
  format: 'kcsc-judgment-rankings-v1',
  matter_types: [{ key: 'civil', label: 'Civil', judgment_count: 1 }],
  matter_categories: [{ key: 'civil:Contract', label: 'Contract', matter_type: 'civil', judgment_count: 1 }],
  rows: [{
    rank: 1, case_number: '262000001SEA', judgment_amount: 1200.5,
    case_type: 'civil', cause_of_action: 'Contract',
  }],
});
assert.equal(judgmentRankings.rows[0].judgment_amount, 1200.5);
assert.throws(() => validateKcscJudgmentRankings({
  format: 'kcsc-judgment-rankings-v1',
  matter_types: [{ key: 'civil', label: 'Civil', judgment_count: 1 }],
  matter_categories: [{ key: 'civil:Contract', label: 'Contract', matter_type: 'civil', judgment_count: 1 }],
  rows: [{
    rank: 1, case_number: '262000001SEA', judgment_amount: 0,
    case_type: 'civil', cause_of_action: 'Contract',
  }],
}), /invalid KCSC judgment ranking row/);

console.log('KCSC statistics checks passed');
