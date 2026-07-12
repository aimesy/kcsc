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

assert(index.includes('<title>KCSC Case Archive</title>'), 'index title must identify KCSC');
assert(index.includes('data-bug-report-repo="aimesy/kcsc"'), 'KCSC bug-report repo is missing');
assert(index.includes('href="https://github.com/aimesy/kcsc-data"'), 'KCSC data repo link is missing');
assert(index.includes('id="cs-scope-btn" aria-haspopup="true" aria-controls="cs-scope-menu" aria-expanded="false"'), 'scope button must match SFSC aria controls');
assert(index.includes('<span id="cs-scope-label">Cases</span> ▾'), 'scope button must use the SFSC chevron');
assert(!index.includes('<span id="cs-scope-label">Cases</span>&nbsp;v'), 'scope button must not render a literal v');
assert(!index.includes('<span id="cs-scope-label">Cases</span> v'), 'scope button must not render a literal v');
assert(index.includes('id="cs-scope-menu" role="radiogroup" aria-label="Search scope"'), 'scope menu must use SFSC radiogroup semantics');
assert(index.includes('value="parties"') && index.includes('value="counsel"'), 'KCSC entity scopes are missing');
assert(app.includes("raw.githubusercontent.com/aimesy/kcsc-data/master"), 'viewer is not wired to kcsc-data');
assert(app.includes("setAttribute('aria-expanded'"), 'scope button must update aria-expanded');
assert(app.includes('data/manifest.json'), 'data manifest load is missing');
assert(app.includes("state.manifest?.archive?.cases_index || 'archive/cases-index.ndjson'"), 'case index load is missing');
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
