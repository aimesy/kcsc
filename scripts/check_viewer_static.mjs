#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`viewer check failed: ${message}`);
    process.exitCode = 1;
  }
}

const index = read('index.html');
const app = read('assets/js/kcsc-viewer.js');
const terms = read('terms.html');
const dataClient = read('assets/js/kcsc-data-client.js');
const statistics = read('assets/js/kcsc-statistics.js');
const sharedThemeAssets = new Set([
  'theme.css',
  'theme-bar.css',
  'bug-report.css',
  'font-system.css',
  'theme.js',
  'bug-report.js',
  'font-system.js',
]);
const sharedThemeMatches = [...index.matchAll(
  /https:\/\/cdn\.jsdelivr\.net\/gh\/aimesy\/themes@([0-9a-f]{40})\/src\/(theme\.css|theme-bar\.css|bug-report\.css|font-system\.css|theme\.js|bug-report\.js|font-system\.js)/g,
)];
const allSharedThemeMatches = [...index.matchAll(
  /https:\/\/cdn\.jsdelivr\.net\/gh\/aimesy\/themes[^"' \s>]*/g,
)];

assert(index.includes('<title>KCSC Case Archive</title>'), 'index title must identify KCSC');
assert(index.includes('<meta name="theme-color" content="#24211d">'), 'theme-color metadata is missing');
assert(index.includes('<link rel="terms-of-service" href="./terms.html">'), 'terms metadata is missing');
assert(index.includes('href="./terms.html" style="color:inherit;text-decoration:none">T&amp;Cs</a>'), 'quiet T&Cs footer link is missing');
assert(terms.includes('Version 0.1. Effective August 22, 2026.'), 'terms page version is missing');
assert(terms.includes('I claim no ownership in facts, official court records, government works'), 'source record boundary is missing from terms');
assert(terms.includes('commercial artificial intelligence or machine learning system'), 'commercial AI license boundary is missing from terms');
assert(sharedThemeMatches.length === sharedThemeAssets.size, 'shared theme asset set must contain exactly seven pinned assets');
assert(allSharedThemeMatches.length === sharedThemeAssets.size, 'unexpected shared theme asset reference remains');
assert(
  sharedThemeAssets.size === new Set(sharedThemeMatches.map((match) => match[2])).size
    && [...sharedThemeAssets].every((asset) => sharedThemeMatches.some((match) => match[2] === asset)),
  'shared theme asset set is incomplete or duplicated',
);
assert(new Set(sharedThemeMatches.map((match) => match[1])).size === 1, 'shared theme assets must use one commit SHA');
assert(!/aimesy\/themes(?:\/|@(master|main|latest)\/)/i.test(index), 'mutable or unversioned shared theme reference remains');
assert(index.includes('/src/font-system.css') && index.includes('/src/font-system.js'), 'shared font controls must mirror SFSC');
assert((index.match(/\bdata-theme-toggle\b/g) || []).length === 1, 'viewer must contain exactly one theme toggle');
assert((index.match(/\bamyc-theme-bar\b/g) || []).length === 1, 'viewer must contain exactly one shared theme bar');
assert(index.indexOf('</style>') < index.indexOf('/src/theme.css'), 'shared theme CSS must load after inline viewer CSS');
assert(index.includes('data-bug-report-repo="aimesy/kcsc"'), 'KCSC bug-report repo is missing');
assert(index.includes('href="https://github.com/aimesy/kcsc-data"'), 'KCSC data repo link is missing');
assert(index.includes('id="cs-scope-btn" aria-haspopup="true" aria-controls="cs-scope-menu" aria-expanded="false"'), 'scope button must match SFSC aria controls');
assert(index.includes('<span id="cs-scope-label">Cases</span><span class="cs-scope-chevron" aria-hidden="true"></span>'), 'scope button must use the CSS chevron');
assert(index.includes('.cs-scope-chevron'), 'scope button chevron must be CSS-drawn');
assert(!index.includes('<span id="cs-scope-label">Cases</span> ▾'), 'scope button must not render a font-dependent chevron glyph');
assert(!index.includes('<span id="cs-scope-label">Cases</span>&nbsp;v'), 'scope button must not render a literal v');
assert(!index.includes('<span id="cs-scope-label">Cases</span> v'), 'scope button must not render a literal v');
assert(index.includes('id="cs-scope-menu" role="radiogroup" aria-label="Search scope"'), 'scope menu must use SFSC radiogroup semantics');
assert(index.includes('value="parties"') && index.includes('value="counsel"'), 'KCSC entity scopes are missing');
assert(index.includes('value="statistics"'), 'KCSC statistics scope is missing');
assert(index.includes('id="cs-statistics-btn"'), 'visible statistics navigation button is missing');
assert(app.includes("raw.githubusercontent.com/aimesy/kcsc-data/master"), 'viewer is not wired to kcsc-data');
assert(app.includes("setAttribute('aria-expanded'"), 'scope button must update aria-expanded');
assert(app.includes('createKcscDataClient'), 'unified KCSC data client is missing');
assert(app.includes('await client.manifest()'), 'validated data manifest load is missing');
assert(dataClient.includes("KCSC_DATA_CLIENT_FORMAT = 'kcsc-viewer-data-client-v1'"), 'viewer data client contract is unversioned');
assert(dataClient.includes('validateKcscManifest'), 'KCSC data manifest validation is missing');
assert(dataClient.includes('validateKcscStatistics'), 'statistics contract is not validated by the unified data client');
assert(dataClient.includes('async function attorneyRankings') && dataClient.includes('async function judgmentRankings'), 'merged-client ranking operations are missing');
assert(statistics.includes("KCSC_STATISTICS_FORMAT = 'kcsc-statistics-v1'"), 'statistics contract is unversioned');
assert(statistics.includes("KCSC_ATTORNEY_RANKINGS_FORMAT = 'kcsc-attorney-rankings-v1'"), 'attorney ranking contract is unversioned');
assert(statistics.includes("KCSC_JUDGMENT_RANKINGS_FORMAT = 'kcsc-judgment-rankings-v1'"), 'judgment ranking contract is unversioned');
assert(app.includes('function renderStatistics()'), 'statistics dashboard renderer is missing');
assert(app.includes('function requestedScopeFromLocation()'), 'shareable statistics scope routing is missing');
assert(app.includes("$('cs-statistics-btn').addEventListener('click'"), 'visible statistics navigation is not wired');
assert(app.includes('statisticsFeatureCoverage'), 'feature coverage statistics are missing');
assert(app.includes('statisticsTrend'), 'filing trend statistics are missing');
assert(app.includes("['aggregates', 'dashboard', 'rankings', 'judgments']"), 'SFSC-compatible statistics modes are missing');
assert(app.indexOf("['dashboard', 'Dashboard']") < app.indexOf("['aggregates', 'Case types']")
  && app.indexOf("['aggregates', 'Case types']") < app.indexOf("['rankings', 'Attorney rankings']"),
  'Dashboard must be the leftmost statistics mode');
assert(app.includes("key !== 'practice_share_percent'")
  && app.includes("column.key !== 'practice_share_percent'"),
  'Practice share must be hidden for the all-jurisdictions rankings scope');
assert(app.includes('judgmentMatterType') && app.includes('judgmentMatterCategory'),
  'judgment matter type/category controls are missing');
assert(app.includes('<strong>${escapeHtml(nf.format(value))}</strong>'),
  'dashboard metrics must show exact figures');
assert(app.includes('function statisticsAttorneyRows()'), 'attorney ranking calculations are missing');
assert(app.includes('function statisticsJudgmentRows()'), 'judgment ranking calculations are missing');
assert(app.includes('competition ranks'), 'attorney ranking tie semantics are not disclosed');
assert(app.includes('function exportStatisticsCsv()'), 'statistics CSV export is missing');
assert(app.includes("STATISTICS_STORAGE_KEY = 'kcsc.statistics.controls.v2'"), 'statistics controls are not persisted');
assert(app.includes("['table', 'Table'], ['horizontal', 'Horizontal bars'], ['vertical', 'Vertical bars'], ['line', 'Line']"), 'statistics view parity is incomplete');
assert(index.includes('id="cs-stat-type"') === false, 'runtime statistics controls must not be duplicated in static markup');
assert(dataClient.includes('request escaped configured base'), 'data client must reject cross-base requests');
assert(app.includes('state.manifest?.archive?.case_directory'), 'compact case directory load is missing');
assert(app.includes('validateDirectoryManifest'), 'case directory validation is missing');
assert(app.includes('createDirectoryClient'), 'shared case shard cache is missing');
assert(app.includes('directoryBrowseEligible'), 'lazy case directory browse is missing');
assert(app.includes('hydrateDirectoryYearGroup'), 'on-demand year hydration is missing');
assert(app.includes('const hasDirectory = await loadCaseDirectoryManifest()'), 'case directory must load before the legacy index fallback');
assert(app.includes('if (!hasDirectory)'), 'legacy case index must only load when the directory is unavailable');
assert(app.includes('state.manifest?.archive?.cases_index_parts || []'), 'sharded case index fallback is missing');
assert(app.includes("state.manifest?.archive?.cases_index || 'archive/cases-index.ndjson'"), 'legacy case index fallback is missing');
assert(app.includes('const batchSize = 4'), 'case index shard concurrency must remain bounded');
assert(app.includes('CASE_SEARCH_RESULT_LIMIT = 300'), 'case search display cap must match SFSC');
assert(app.includes('CASE_SEARCH_CONCURRENCY = 6'), 'case search concurrency must remain bounded');
assert(app.includes('DIRECTORY_PAGE_SIZE = 300'), 'expanded directory groups must render in bounded pages');
assert(app.includes('data-directory-more'), 'expanded directory groups must expose incremental rendering');
assert(app.includes('scheduleResults(delay = 260)'), 'case search debounce must match SFSC');
assert(app.includes('searchSeq === state.searchSeq'), 'stale case search guard is missing');
assert(app.includes('const openSeq = ++state.caseOpenSeq'), 'stale case detail guard is missing');
assert(app.includes('state.caseOpenSeq += 1'), 'returning to results must cancel stale case loads');
assert(app.includes('createLoadProgress'), 'visible loading progress is missing');
assert(app.includes('REQUEST_TIMEOUT_MS = 20000'), 'case request timeout must match SFSC');
assert(app.includes('safeHttpHref'), 'external case links must be protocol checked');
assert(!app.includes("await registerParquet(tableName, path)"), 'viewer must not materialize all parquet tables at startup');
assert(app.includes('state.dataClient.caseRecord(canonical'), 'lazy per-case JSON load is missing');
assert(app.includes('renderRepresentation(representationRows(record))'), 'representation detail integration is missing');
assert(app.includes('renderPayments(record.payments || [])'), 'payment detail integration is missing');
assert(app.includes("renderStructuredSourceRows('Charges'"), 'structured charge rendering is missing');
assert(app.includes("renderStructuredSourceRows('Judgments'"), 'structured judgment rendering is missing');
assert(index.includes('data-feature="representation"'), 'representation filter capability is missing');
assert(index.includes('data-feature="charges"'), 'charge filter capability is missing');
assert(index.includes('data-feature="judgments"'), 'judgment filter capability is missing');
assert(index.includes('data-feature="payments"'), 'payment filter capability is missing');
assert(!app.includes('globalTextSearch'), 'dead global text search flag must not remain');
assert(!app.includes('has_deferred_documents'), 'viewer must not expose stale deferred document naming');
assert(!app.includes('document bytes deferred'), 'viewer must not surface stale deferred document wording');
assert(app.includes('has_document_index_rows'), 'document index row flag is missing');
assert(app.includes('Search party names, roles, counsel, address, or case number'), 'party search placeholder is stale');
assert(app.includes('Search counsel names, bar numbers, represented parties, or case number'), 'counsel search placeholder is stale');

if (!process.exitCode) {
  console.log(`viewer static contract ok (${root})`);
}
