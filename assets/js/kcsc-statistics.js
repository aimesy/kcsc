export const KCSC_STATISTICS_FORMAT = 'kcsc-statistics-v1';
export const KCSC_ATTORNEY_RANKINGS_FORMAT = 'kcsc-attorney-rankings-v1';
export const KCSC_JUDGMENT_RANKINGS_FORMAT = 'kcsc-judgment-rankings-v1';

const BREAKDOWN_FIELDS = [
  'case_type',
  'filing_year',
  'location',
  'portal_node',
  'status_group',
];

function clean(value) {
  return value == null ? '' : String(value).replace(/\u00a0/g, ' ').trim();
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value;
}

function cleanValues(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const cleaned = values.map(clean);
  if (cleaned.some((value) => !value) || new Set(cleaned).size !== cleaned.length) {
    throw new Error(`${label} must contain unique nonempty values`);
  }
  return cleaned;
}

function safePath(value) {
  const path = clean(value).replace(/\\/g, '/');
  if (!path || path.startsWith('/') || path.includes('//') || path.includes(':')
    || path.includes('?') || path.includes('#')
    || path.split('/').some((part) => part === '..' || part === '.')) return '';
  return path;
}

function validateRankingSources(sources) {
  if (sources == null) return;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new Error('statistics.ranking_sources must be an object');
  }
  for (const [name, format] of [
    ['attorney_rankings', KCSC_ATTORNEY_RANKINGS_FORMAT],
    ['judgment_rankings', KCSC_JUDGMENT_RANKINGS_FORMAT],
  ]) {
    const source = sources[name];
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(`statistics.ranking_sources.${name} is missing`);
    }
    if (clean(source.format) !== format || !safePath(source.path)) {
      throw new Error(`statistics.ranking_sources.${name} is invalid`);
    }
    count(source.rows, `statistics.ranking_sources.${name}.rows`);
    count(source.size_bytes, `statistics.ranking_sources.${name}.size_bytes`);
  }
}

function validateFilingYearCoverage(coverage) {
  if (coverage == null) return;
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)
      || clean(coverage.schema) !== 'kcsc-filing-year-coverage-v1'
      || !Array.isArray(coverage.years)) {
    throw new Error('statistics.filing_year_coverage is invalid');
  }
  const years = new Set();
  for (const [index, row] of coverage.years.entries()) {
    const year = clean(row?.year);
    const completeDays = count(
      row?.complete_days,
      `statistics.filing_year_coverage.years[${index}].complete_days`,
    );
    const expectedDays = count(
      row?.expected_days,
      `statistics.filing_year_coverage.years[${index}].expected_days`,
    );
    const expectedStatus = completeDays === expectedDays
      ? 'complete' : completeDays ? 'partial' : 'unavailable';
    if (!/^\d{4}$/.test(year) || years.has(year) || expectedDays === 0
        || completeDays > expectedDays || clean(row?.status) !== expectedStatus) {
      throw new Error(`invalid statistics filing-year coverage row: ${year || index}`);
    }
    years.add(year);
  }
}

export function statisticsSegmentId(caseType = '', location = '') {
  const parts = [];
  if (clean(caseType)) parts.push(`type:${clean(caseType)}`);
  if (clean(location)) parts.push(`location:${clean(location)}`);
  return parts.join('|') || 'all';
}

function validateBreakdown(rows, cases, label) {
  if (!Array.isArray(rows)) throw new Error(`${label} must be an array`);
  const values = new Set();
  let total = 0;
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const value = clean(row.value);
    if (!value || values.has(value)) throw new Error(`${label} values must be unique and nonempty`);
    values.add(value);
    total += count(row.cases, `${label}[${index}].cases`);
  }
  if (total !== cases) throw new Error(`${label} count ${total} does not reconcile to ${cases} cases`);
}

function validateFeatureCoverage(features, cases, label, featureNames) {
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    throw new Error(`${label} must be an object`);
  }
  const names = Object.keys(features).sort();
  if (names.join('|') !== featureNames.join('|')) {
    throw new Error(`${label} feature set does not match the data manifest`);
  }
  for (const name of names) {
    const feature = features[name];
    if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
      throw new Error(`${label}.${name} must be an object`);
    }
    const featureCases = count(feature.cases, `${label}.${name}.cases`);
    count(feature.rows, `${label}.${name}.rows`);
    if (featureCases > cases) throw new Error(`${label}.${name}.cases exceeds segment cases`);
  }
}

export function validateKcscStatistics(statistics, options = {}) {
  if (!statistics || typeof statistics !== 'object' || Array.isArray(statistics)) {
    throw new Error('invalid KCSC statistics contract');
  }
  if (statistics.format !== KCSC_STATISTICS_FORMAT) {
    throw new Error(`unsupported KCSC statistics format: ${clean(statistics.format) || 'missing'}`);
  }
  if (clean(statistics.grain) !== 'one canonical case') {
    throw new Error('KCSC statistics grain must be one canonical case');
  }
  if (options.generatedAt != null && clean(statistics.generated_at) !== clean(options.generatedAt)) {
    throw new Error('KCSC statistics generation does not match the data manifest');
  }
  const caseTypes = cleanValues(statistics.filters?.case_types, 'statistics.filters.case_types');
  const locations = cleanValues(statistics.filters?.locations, 'statistics.filters.locations');
  const featureNames = Object.keys(options.features || {}).sort();
  if (!featureNames.length) throw new Error('KCSC statistics require data manifest feature descriptors');
  if (!Array.isArray(statistics.segments)) throw new Error('statistics.segments must be an array');
  validateRankingSources(statistics.ranking_sources);
  validateFilingYearCoverage(statistics.filing_year_coverage);

  const expectedIds = new Set(['all']);
  caseTypes.forEach((caseType) => expectedIds.add(statisticsSegmentId(caseType, '')));
  locations.forEach((location) => expectedIds.add(statisticsSegmentId('', location)));
  caseTypes.forEach((caseType) => locations.forEach((location) => {
    expectedIds.add(statisticsSegmentId(caseType, location));
  }));

  const byId = new Map();
  for (const [index, segment] of statistics.segments.entries()) {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
      throw new Error(`statistics.segments[${index}] must be an object`);
    }
    const id = clean(segment.id);
    const caseType = clean(segment.case_type);
    const location = clean(segment.location);
    if (id !== statisticsSegmentId(caseType, location) || byId.has(id) || !expectedIds.has(id)) {
      throw new Error(`invalid or duplicate KCSC statistics segment: ${id || 'missing'}`);
    }
    const cases = count(segment.cases, `statistics.segments.${id}.cases`);
    if (!segment.breakdowns || typeof segment.breakdowns !== 'object' || Array.isArray(segment.breakdowns)) {
      throw new Error(`statistics.segments.${id}.breakdowns must be an object`);
    }
    for (const field of BREAKDOWN_FIELDS) {
      validateBreakdown(segment.breakdowns[field], cases, `statistics.segments.${id}.breakdowns.${field}`);
    }
    validateFeatureCoverage(segment.features, cases, `statistics.segments.${id}.features`, featureNames);
    byId.set(id, segment);
  }
  if (byId.size !== expectedIds.size) throw new Error('KCSC statistics segments are incomplete');

  const overall = byId.get('all');
  if (options.expectedCases != null && overall.cases !== count(options.expectedCases, 'expectedCases')) {
    throw new Error(`KCSC statistics case count ${overall.cases} does not match archive count ${options.expectedCases}`);
  }
  for (const name of featureNames) {
    if (overall.features[name].rows !== options.features[name].rows) {
      throw new Error(`KCSC statistics ${name} rows do not match the data manifest`);
    }
  }
  if (caseTypes.reduce((sum, value) => sum + byId.get(statisticsSegmentId(value, '')).cases, 0) !== overall.cases) {
    throw new Error('KCSC statistics case-type segments do not reconcile');
  }
  if (locations.reduce((sum, value) => sum + byId.get(statisticsSegmentId('', value)).cases, 0) !== overall.cases) {
    throw new Error('KCSC statistics location segments do not reconcile');
  }
  for (const caseType of caseTypes) {
    const total = locations.reduce((sum, location) => (
      sum + byId.get(statisticsSegmentId(caseType, location)).cases
    ), 0);
    if (total !== byId.get(statisticsSegmentId(caseType, '')).cases) {
      throw new Error(`KCSC statistics ${caseType} location segments do not reconcile`);
    }
  }
  Object.defineProperty(statistics, '_segmentsById', { value: byId, configurable: true });
  return statistics;
}

export function validateKcscAttorneyRankings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || clean(data.format) !== KCSC_ATTORNEY_RANKINGS_FORMAT
    || !Array.isArray(data.topics)) throw new Error('invalid KCSC attorney rankings');
  const topicKeys = new Set();
  for (const [topicIndex, topic] of data.topics.entries()) {
    const key = clean(topic?.topic);
    if (!key || topicKeys.has(key) || !Array.isArray(topic?.categories) || !Array.isArray(topic?.attorneys)) {
      throw new Error(`invalid KCSC attorney ranking topic ${topicIndex}`);
    }
    topicKeys.add(key);
    const categoryKeys = new Set(topic.categories.map((category) => clean(category?.key)).filter(Boolean));
    if (categoryKeys.size !== topic.categories.length) throw new Error(`invalid categories for ${key}`);
    const attorneyIds = new Set();
    for (const attorney of topic.attorneys) {
      const attorneyId = clean(attorney?.attorney_id);
      if (!attorneyId || attorneyIds.has(attorneyId) || !clean(attorney?.attorney_name)) {
        throw new Error(`invalid attorney identity in ${key}`);
      }
      attorneyIds.add(attorneyId);
      for (const field of [
        'matter_count', 'matter_count_last_2_years', 'all_matter_count',
        'judgment_count',
      ]) count(attorney[field], `${key}.${attorneyId}.${field}`);
      for (const contribution of attorney.category_contributions || []) {
        if (!categoryKeys.has(clean(contribution?.category_key))) {
          throw new Error(`unknown category contribution in ${key}`);
        }
      }
    }
  }
  return data;
}

export function validateKcscJudgmentRankings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || clean(data.format) !== KCSC_JUDGMENT_RANKINGS_FORMAT
    || !Array.isArray(data.rows) || !Array.isArray(data.matter_types)
    || !Array.isArray(data.matter_categories)) throw new Error('invalid KCSC judgment rankings');
  const matterTypes = new Set();
  let typeTotal = 0;
  for (const item of data.matter_types) {
    const key = clean(item?.key);
    if (!key || matterTypes.has(key) || !clean(item?.label)) {
      throw new Error('invalid KCSC judgment matter type');
    }
    matterTypes.add(key);
    typeTotal += count(item.judgment_count, `judgment matter type ${key}`);
  }
  const matterCategories = new Set();
  let categoryTotal = 0;
  for (const item of data.matter_categories) {
    const key = clean(item?.key);
    const matterType = clean(item?.matter_type);
    if (!key || matterCategories.has(key) || !matterTypes.has(matterType) || !clean(item?.label)) {
      throw new Error('invalid KCSC judgment matter category');
    }
    matterCategories.add(key);
    categoryTotal += count(item.judgment_count, `judgment matter category ${key}`);
  }
  const cases = new Set();
  for (const [index, row] of data.rows.entries()) {
    const caseNumber = clean(row?.case_number);
    const amount = Number(row?.judgment_amount);
    const matterType = clean(row?.case_type);
    const matterCategory = `${matterType}:${clean(row?.cause_of_action) || 'Unknown'}`;
    if (!caseNumber || cases.has(caseNumber) || !Number.isFinite(amount) || amount <= 0
      || !Number.isSafeInteger(row?.rank) || row.rank < 1
      || !matterTypes.has(matterType) || !matterCategories.has(matterCategory)) {
      throw new Error(`invalid KCSC judgment ranking row ${index}`);
    }
    cases.add(caseNumber);
  }
  if (typeTotal !== data.rows.length || categoryTotal !== data.rows.length) {
    throw new Error('KCSC judgment facets do not reconcile to ranking rows');
  }
  return data;
}

export function statisticsSegment(statistics, filters = {}) {
  if (!statistics) return null;
  const id = statisticsSegmentId(filters.caseType, filters.location);
  const index = statistics._segmentsById || new Map(statistics.segments.map((segment) => [segment.id, segment]));
  return index.get(id) || null;
}

export function statisticsCoveragePercent(featureCases, cases) {
  return cases > 0 ? (Number(featureCases) / Number(cases)) * 100 : 0;
}
