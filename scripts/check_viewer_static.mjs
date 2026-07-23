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
const sharedThemeAssets = new Set([
  'theme.css',
  'theme-bar.css',
  'bug-report.css',
  'theme.js',
  'bug-report.js',
]);
const sharedThemeMatches = [...index.matchAll(
  /https:\/\/cdn\.jsdelivr\.net\/gh\/aimesy\/themes@([0-9a-f]{40})\/src\/(theme\.css|theme-bar\.css|bug-report\.css|theme\.js|bug-report\.js)/g,
)];
const allSharedThemeMatches = [...index.matchAll(
  /https:\/\/cdn\.jsdelivr\.net\/gh\/aimesy\/themes[^"' \s>]*/g,
)];

assert(index.includes('<title>KCSC Case Archive</title>'), 'index title must identify KCSC');
assert(index.includes('<meta name="theme-color" content="#24211d">'), 'theme-color metadata is missing');
assert(sharedThemeMatches.length === sharedThemeAssets.size, 'shared theme asset set must contain exactly five pinned assets');
assert(allSharedThemeMatches.length === sharedThemeAssets.size, 'unexpected shared theme asset reference remains');
assert(
  sharedThemeAssets.size === new Set(sharedThemeMatches.map((match) => match[2])).size
    && [...sharedThemeAssets].every((asset) => sharedThemeMatches.some((match) => match[2] === asset)),
  'shared theme asset set is incomplete or duplicated',
);
assert(new Set(sharedThemeMatches.map((match) => match[1])).size === 1, 'shared theme assets must use one commit SHA');
assert(!/aimesy\/themes(?:\/|@(master|main|latest)\/)/i.test(index), 'mutable or unversioned shared theme reference remains');
assert(!index.includes('font-system.'), 'unused shared font-system assets must not load');
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
assert(app.includes("raw.githubusercontent.com/aimesy/kcsc-data/master"), 'viewer is not wired to kcsc-data');
assert(app.includes("setAttribute('aria-expanded'"), 'scope button must update aria-expanded');
assert(app.includes('data/manifest.json'), 'data manifest load is missing');
assert(app.includes('state.manifest?.archive?.cases_index_parts || []'), 'sharded case index load is missing');
assert(app.includes("state.manifest?.archive?.cases_index || 'archive/cases-index.ndjson'"), 'legacy case index fallback is missing');
assert(app.includes('const batchSize = 4'), 'case index shard concurrency must remain bounded');
assert(app.includes('loadCaseIndexRows'), 'case index startup loader is missing');
assert(!app.includes("await registerParquet(tableName, path)"), 'viewer must not materialize all parquet tables at startup');
assert(app.includes('archive/cases/${encodeURIComponent(canonical)}.json'), 'lazy per-case JSON load is missing');
assert(!app.includes('globalTextSearch'), 'dead global text search flag must not remain');
assert(!app.includes('has_deferred_documents'), 'viewer must not expose stale deferred document naming');
assert(!app.includes('document bytes deferred'), 'viewer must not surface stale deferred document wording');
assert(app.includes('has_document_index_rows'), 'document index row flag is missing');
assert(app.includes('Search party names, roles, counsel, address, or case number'), 'party search placeholder is stale');
assert(app.includes('Search counsel names, bar numbers, represented parties, or case number'), 'counsel search placeholder is stale');

if (!process.exitCode) {
  console.log(`viewer static contract ok (${root})`);
}
