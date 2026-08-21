import {
  createLoadProgress,
  fetchJsonWithProgress,
  formatLoadBytes,
} from './load-progress.js';
import {
  createDirectoryClient,
  directoryGroups,
  directorySourceBatches,
  rowMatchesGroup,
  statusGroup,
  uniqueDirectorySources,
  validateDirectoryManifest,
} from './kcsc-directory.js';

const DUCKDB_ESM_URL = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev45.0/+esm';
const REMOTE_DATA_BASE = 'https://raw.githubusercontent.com/aimesy/kcsc-data/master/';
const CASE_SEARCH_RESULT_LIMIT = 300;
const CASE_SEARCH_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20000;

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US');
const GENERIC_COUNSEL_NAMES = new Set([
  'attorney',
  'counsel',
  'defendant',
  'minor',
  'other',
  'petitioner',
  'plaintiff',
  'respondent',
  'unknown',
]);

const state = {
  manifest: null,
  dataBase: '',
  duckdb: null,
  db: null,
  conn: null,
  bound: false,
  directory: null,
  directoryClient: null,
  directoryGroupRows: new Map(),
  directoryHydratedRows: new Map(),
  cases: [],
  docketRows: [],
  partyRows: [],
  attorneyRows: [],
  calendarRows: [],
  caseByNumber: new Map(),
  partyEntities: [],
  counselEntities: [],
  entityLoaded: { parties: false, counsel: false },
  entityPromises: new Map(),
  docketLoaded: false,
  docketPromise: null,
  nextHearings: new Map(),
  docketIndex: new Map(),
  partyIndex: new Map(),
  counselIndex: new Map(),
  selectedCaseNumber: '',
  selectedCase: null,
  selectedTab: 'summary',
  detailCache: new Map(),
  caseGroupRows: new Map(),
  entityCaseFilter: null,
  scope: 'cases',
  searchSeq: 0,
  searchTimer: null,
  caseOpenSeq: 0,
};

function text(value) {
  return value == null ? '' : String(value).replace(/\u00a0/g, ' ').trim();
}

function norm(value) {
  return text(value).toLowerCase();
}

function matchesTerms(value, query) {
  const haystack = norm(value);
  const terms = norm(query).match(/[a-z0-9]+/g) || [];
  return terms.every((term) => haystack.includes(term));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function normalizeBase(base) {
  const raw = text(base);
  if (!raw) return '';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function safeHttpHref(value) {
  try {
    const raw = text(value);
    if (!raw) return '';
    const url = new URL(raw, location.href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function normalizeCaseKey(value) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function dataUrl(path) {
  return new URL(path.replace(/^\/+/, ''), new URL(state.dataBase, location.href)).href;
}

function runningOnPublishedSite() {
  const host = location.hostname.toLowerCase();
  return (host === 'aimesy.github.io' && location.pathname.startsWith('/kcsc'))
    || host === 'kcsc.amyc.us'
    || host === 'kcsc.amcy.us';
}

function safeJson(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function displayDate(value) {
  const raw = text(value);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-');
    return `${m}/${d}/${y}`;
  }
  return raw;
}

function compactDateTime(date, time) {
  const d = displayDate(date);
  const t = text(time);
  return d && t ? `${d} ${t}` : (d || t);
}

function num(value) {
  if (typeof value === 'bigint') return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function tableRowsCount(name) {
  return num(state.manifest?.tables?.[name]?.rows);
}

function archiveCountText() {
  return nf.format(num(state.manifest?.archive?.cases || tableRowsCount('cases') || state.directory?.case_count || state.cases.length));
}

function archiveReadyText() {
  return `${archiveCountText()} captured dockets`;
}

function caseLocation(row) {
  if (row?.location_code) return text(row.location_code);
  const numText = text(row.display_case_number || row.case_number);
  const match = numText.match(/(SEA|KNT)$/i);
  return match ? match[1].toUpperCase() : '';
}

function yearFromDate(value) {
  const raw = text(value);
  return /^\d{4}/.test(raw) ? raw.slice(0, 4) : 'Unknown year';
}

function rowKcsc(row) {
  if (!row) return {};
  if (row._kcsc) return row._kcsc;
  const raw = safeJson(row.raw);
  row._kcsc = raw?.kcsc || {};
  return row._kcsc;
}

function casePortalNode(row) {
  if (row?.portal_node_id) return text(row.portal_node_id);
  return text(rowKcsc(row).portal_node_id || safeJson(row.raw)?.raw?.case?.portalNodeId);
}

function casePortalId(row) {
  if (row?.portal_case_id) return text(row.portal_case_id);
  return text(rowKcsc(row).portal_case_id || safeJson(row.raw)?.raw?.case?.portalCaseId);
}

function caseHasDocumentIndexRows(row) {
  if (num(row?.document_count)) return true;
  if (row?.has_document_index_rows != null) return Boolean(row.has_document_index_rows);
  const kcsc = rowKcsc(row);
  return Array.isArray(kcsc.document_rows_deferred) && kcsc.document_rows_deferred.length > 0;
}

function setStatus(label, detail = '') {
  $('cs-sync').textContent = label;
  if (detail) $('cs-entity-meta').textContent = detail;
}

function mountLoadProgress(root, progress, options = {}) {
  root.innerHTML = `<div class="cs-load-progress" role="status" aria-live="polite" aria-atomic="true">
    <div class="cs-load-progress-phase"></div>
    <div class="cs-load-progress-stats"><span data-load-bytes></span><span data-load-shards></span><span data-load-records></span></div>
    <div class="cs-load-progress-track" role="progressbar" aria-label="${escapeHtml(options.ariaLabel || 'KCSC data loaded')}"><div class="cs-load-progress-bar"></div></div>
  </div>`;
  const phaseEl = root.querySelector('.cs-load-progress-phase');
  const bytesEl = root.querySelector('[data-load-bytes]');
  const shardsEl = root.querySelector('[data-load-shards]');
  const recordsEl = root.querySelector('[data-load-records]');
  const track = root.querySelector('.cs-load-progress-track');
  const bar = root.querySelector('.cs-load-progress-bar');
  return progress.subscribe((snapshot) => {
    phaseEl.textContent = snapshot.phase;
    bytesEl.textContent = snapshot.bytesTotal == null
      ? `${formatLoadBytes(snapshot.bytesLoaded)} downloaded`
      : `${formatLoadBytes(snapshot.bytesLoaded)} / ${formatLoadBytes(snapshot.bytesTotal)}`;
    shardsEl.textContent = snapshot.shardsTotal == null
      ? `${nf.format(snapshot.shardsLoaded)} files`
      : `${nf.format(snapshot.shardsLoaded)} / ${nf.format(snapshot.shardsTotal)} files`;
    recordsEl.textContent = snapshot.recordsTotal == null
      ? `${nf.format(snapshot.recordsLoaded)} records`
      : `${nf.format(snapshot.recordsLoaded)} / ${nf.format(snapshot.recordsTotal)} records`;
    const knownTotal = snapshot.bytesTotal != null && snapshot.bytesTotal > 0;
    track.classList.toggle('is-unknown', !knownTotal);
    if (knownTotal) {
      const width = Math.min(100, Math.max(0, (snapshot.bytesLoaded / snapshot.bytesTotal) * 100));
      bar.style.width = `${width}%`;
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', String(snapshot.bytesTotal));
      track.setAttribute('aria-valuenow', String(Math.min(snapshot.bytesLoaded, snapshot.bytesTotal)));
    } else {
      bar.style.width = '';
      track.removeAttribute('aria-valuemin');
      track.removeAttribute('aria-valuemax');
      track.removeAttribute('aria-valuenow');
    }
  });
}

function showBodyError(message, retry = '') {
  $('cs-body').innerHTML = `<div class="cs-error">${escapeHtml(message)}${retry ? ` <button type="button" class="hbtn" data-retry-action="${escapeHtml(retry)}">Retry</button>` : ''}</div>`;
}

async function fetchJsonFrom(base, path) {
  const url = new URL(path, new URL(base, location.href)).href;
  const res = await fetchWithTimeout(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { json: await res.json(), url };
}

async function fetchTextFrom(base, path) {
  const url = new URL(path, new URL(base, location.href)).href;
  const res = await fetchWithTimeout(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { text: await res.text(), url };
}

async function resolveDataBase() {
  const params = new URLSearchParams(location.search);
  const requested = normalizeBase(params.get('dataBase'));
  const defaults = runningOnPublishedSite() ? [REMOTE_DATA_BASE, './'] : ['./', REMOTE_DATA_BASE];
  const candidates = [requested, ...defaults].filter(Boolean);
  const errors = [];

  for (const base of candidates) {
    try {
      const got = await fetchJsonFrom(base, 'data/manifest.json');
      state.dataBase = normalizeBase(base);
      state.manifest = got.json;
      return;
    } catch (err) {
      errors.push(`${base}: ${err.message || err}`);
    }
  }
  throw new Error(`Could not load KCSC data manifest. ${errors.join(' | ')}`);
}

async function ensureDuckDB() {
  if (state.duckdb) return state.duckdb;
  const duckdb = await import(DUCKDB_ESM_URL);
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  state.duckdb = duckdb;
  state.db = db;
  state.conn = await db.connect();
  return duckdb;
}

async function fetchBuffer(path, progress = null) {
  const res = await fetchWithTimeout(dataUrl(path), { cache: 'no-cache' }, 60000);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${path}`);
  const rawLength = res.headers.get('Content-Length');
  const total = /^\d+$/.test(text(rawLength)) ? Number(rawLength) : null;
  let loaded = 0;
  const chunks = [];
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      progress?.update({ bytesLoaded: loaded, bytesTotal: total });
    }
  } else {
    const value = new Uint8Array(await res.arrayBuffer());
    chunks.push(value);
    loaded = value.byteLength;
    progress?.update({ bytesLoaded: loaded, bytesTotal: total });
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  chunks.forEach((chunk) => {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return out;
}

async function registerParquet(tableName, path, progress = null) {
  const fname = `${tableName}.parquet`;
  const buf = await fetchBuffer(path, progress);
  progress?.update({ phase: `Opening ${tableName} table` });
  await state.db.registerFileBuffer(fname, buf);
  await state.conn.query(`CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM '${fname}'`);
}

function rowsFromArrow(table) {
  return table.toArray().map((row) => {
    if (typeof row.toJSON === 'function') return row.toJSON();
    const out = {};
    table.schema.fields.forEach((field, index) => {
      out[field.name] = row.get(index);
    });
    return out;
  });
}

async function loadTableRows(tableName, query) {
  const table = await state.conn.query(query || `SELECT * FROM ${tableName}`);
  return rowsFromArrow(table);
}

async function loadEntityParquetRows(entityTableName, parquetPath, progress = null) {
  progress?.update({ phase: 'Initialising database engine' });
  await ensureDuckDB();
  progress?.update({ phase: `Downloading ${entityTableName} table` });
  await registerParquet(entityTableName, parquetPath, progress);
  progress?.update({ phase: `Reading ${entityTableName} rows` });
  const rows = await loadTableRows(entityTableName);
  progress?.update({
    phase: `${entityTableName} index ready`,
    shardsLoaded: 1,
    recordsLoaded: rows.length,
  });
  return rows;
}

async function loadCaseIndexRows() {
  const configuredParts = state.manifest?.archive?.cases_index_parts || [];
  if (configuredParts.length) {
    const rows = [];
    const batchSize = 4;
    for (let offset = 0; offset < configuredParts.length; offset += batchSize) {
      const batch = configuredParts.slice(offset, offset + batchSize);
      const responses = await Promise.all(batch.map((part) => {
        const path = typeof part === 'string' ? part : part.path;
        return fetchTextFrom(state.dataBase, path);
      }));
      for (const got of responses) {
        rows.push(...got.text
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line)));
      }
    }
    return rows;
  }

  const legacyPath = state.manifest?.archive?.cases_index || 'archive/cases-index.ndjson';
  const got = await fetchTextFrom(state.dataBase, legacyPath);
  return got.text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function loadCaseDirectoryManifest() {
  const path = text(state.manifest?.archive?.case_directory);
  if (!path) return false;
  const progress = createLoadProgress({
    phase: 'Loading case directory',
    shardsTotal: 1,
    recordsTotal: num(state.manifest?.archive?.cases),
  });
  const unsubscribe = mountLoadProgress($('cs-body'), progress, {
    ariaLabel: 'KCSC case directory loaded',
  });
  try {
    const result = await fetchJsonWithProgress(dataUrl(path), { cache: 'no-cache' }, {
      fetchImpl: (input, init) => fetchWithTimeout(input, init),
      onProgress: ({ loaded, total }) => progress.update({ bytesLoaded: loaded, bytesTotal: total }),
      onPhase: () => progress.update({ phase: 'Validating case directory' }),
    });
    const directory = validateDirectoryManifest(
      result.data,
      num(state.manifest?.archive?.cases),
    );
    if (text(directory.built_at) !== text(state.manifest?.generated_at)) {
      throw new Error('case directory generation does not match the data manifest');
    }
    state.directory = directory;
    state.directoryClient = createDirectoryClient({
      base: state.dataBase,
      locationHref: location.href,
      fetchImpl: (input, init) => fetchWithTimeout(input, init, 60000),
    });
    progress.update({
      phase: 'Case directory ready',
      bytesLoaded: result.bytesLoaded,
      bytesTotal: result.bytesTotal,
      shardsLoaded: 1,
      recordsLoaded: directory.case_count,
    });
    return true;
  } finally {
    unsubscribe();
  }
}

function appendIndex(map, key, value) {
  const k = text(key);
  const v = text(value);
  if (!k || !v) return;
  map.set(k, `${map.get(k) || ''} ${v}`);
}

function buildSearchIndexes() {
  state.nextHearings.clear();
  for (const row of state.calendarRows) {
    const key = text(row.case_number);
    if (!key || state.nextHearings.has(key)) continue;
    state.nextHearings.set(key, row);
  }

  state.docketIndex.clear();
  for (const row of state.docketRows) {
    appendIndex(state.docketIndex, row.case_number, [
      row.description,
      row.date_filed,
      row.entry_seq,
      row.fee,
      row.source,
      row.raw,
    ].map(text).join(' '));
  }

  state.partyIndex.clear();
  for (const row of state.partyRows) {
    appendIndex(state.partyIndex, row.case_number, [
      row.name,
      row.party_type,
      row.attorneys,
      row.party_address,
      row.raw,
    ].map(text).join(' '));
  }

  state.counselIndex.clear();
  for (const row of state.attorneyRows) {
    appendIndex(state.counselIndex, row.case_number, [
      row.name,
      row.bar_number,
      row.parties_represented,
      row.contact_block,
      row.raw,
    ].map(text).join(' '));
  }
}

function enrichCases(caseRows) {
  return caseRows.map((row) => ({
    ...row,
    location_code: caseLocation(row),
    portal_node_id: casePortalNode(row),
    portal_case_id: casePortalId(row),
    status_group: statusGroup(row.status_group || row.status),
    has_document_index_rows: caseHasDocumentIndexRows(row),
    next_hearing: row.next_hearing || state.nextHearings.get(text(row.case_number)) || null,
  }));
}

function rememberCases(caseRows) {
  const remembered = [];
  for (const row of enrichCases(caseRows)) {
    const key = normalizeCaseKey(row.case_number);
    if (!key) continue;
    const previous = state.caseByNumber.get(key);
    const merged = previous ? { ...previous, ...row } : row;
    state.caseByNumber.set(key, merged);
    const displayKey = normalizeCaseKey(merged.display_case_number);
    if (displayKey) state.caseByNumber.set(displayKey, merged);
    if (!previous) state.cases.push(merged);
    remembered.push(merged);
  }
  return remembered;
}

function caseRowFor(caseNumber) {
  return state.caseByNumber.get(normalizeCaseKey(caseNumber)) || null;
}

function normalizeEntityName(value) {
  return norm(value)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:the|a|an|of|for|to)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGenericCounselName(value) {
  return GENERIC_COUNSEL_NAMES.has(normalizeEntityName(value));
}

function addSetValue(set, value) {
  const v = text(value);
  if (v) set.add(v);
}

function addJsonValues(set, value, key = '') {
  const parsed = safeJson(value);
  const arr = Array.isArray(parsed) ? parsed : (Array.isArray(value) ? value : []);
  const raw = text(value);
  if (!arr.length && raw && !['[]', '{}', 'null'].includes(raw.toLowerCase())) addSetValue(set, raw);
  for (const item of arr) {
    if (typeof item === 'string') addSetValue(set, item);
    else if (item && typeof item === 'object') addSetValue(set, key ? item[key] : Object.values(item).map(text).filter(Boolean).join(' '));
  }
}

function compactEntity(entity) {
  const cases = [...entity.caseNumbers]
    .map(caseRowFor)
    .filter(Boolean)
    .sort((a, b) => text(b.filed_date).localeCompare(text(a.filed_date)) || text(a.case_number).localeCompare(text(b.case_number)));
  return {
    ...entity,
    roles: [...(entity.roles || new Set())].sort((a, b) => a.localeCompare(b)),
    attorneys: [...(entity.attorneys || new Set())].sort((a, b) => a.localeCompare(b)),
    barNumbers: [...(entity.barNumbers || new Set())].sort((a, b) => a.localeCompare(b)),
    represented: [...(entity.represented || new Set())].sort((a, b) => a.localeCompare(b)),
    contacts: [...(entity.contacts || new Set())].sort((a, b) => a.localeCompare(b)),
    addresses: [...(entity.addresses || new Set())].sort((a, b) => a.localeCompare(b)),
    caseNumbers: [...entity.caseNumbers].sort((a, b) => a.localeCompare(b)),
    cases,
    rowCount: entity.rows.length,
  };
}

function buildPartyEntities() {
  const map = new Map();
  for (const row of state.partyRows) {
    const name = text(row.name);
    if (!name) continue;
    const key = normalizeEntityName(name) || norm(name);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        kind: 'parties',
        key,
        displayName: name,
        roles: new Set(),
        attorneys: new Set(),
        addresses: new Set(),
        caseNumbers: new Set(),
        rows: [],
      });
    }
    const entity = map.get(key);
    if (name.length < entity.displayName.length || entity.displayName === entity.displayName.toUpperCase()) entity.displayName = name;
    addSetValue(entity.roles, row.party_type);
    addJsonValues(entity.attorneys, row.attorneys);
    addSetValue(entity.addresses, row.party_address);
    addSetValue(entity.caseNumbers, row.case_number);
    entity.rows.push(row);
  }
  return [...map.values()].map(compactEntity).sort(sortEntities);
}

function buildCounselEntities() {
  const map = new Map();
  for (const row of state.attorneyRows) {
    const name = text(row.name);
    if (!name) continue;
    if (isGenericCounselName(name)) continue;
    const bar = normalizeEntityName(row.bar_number);
    const key = bar ? `bar:${bar}` : (normalizeEntityName(name) || norm(name));
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        kind: 'counsel',
        key,
        displayName: name,
        barNumbers: new Set(),
        represented: new Set(),
        contacts: new Set(),
        caseNumbers: new Set(),
        rows: [],
      });
    }
    const entity = map.get(key);
    if (name.length < entity.displayName.length || entity.displayName === entity.displayName.toUpperCase()) entity.displayName = name;
    addSetValue(entity.barNumbers, row.bar_number);
    addJsonValues(entity.represented, row.parties_represented, 'name');
    addSetValue(entity.contacts, row.contact_block);
    addSetValue(entity.caseNumbers, row.case_number);
    entity.rows.push(row);
  }
  return [...map.values()].map(compactEntity).sort(sortEntities);
}

function sortEntities(a, b) {
  return (b.caseNumbers.length - a.caseNumbers.length)
    || (b.rowCount - a.rowCount)
    || text(a.displayName).localeCompare(text(b.displayName));
}

async function loadData() {
  bindEvents();
  setStatus('loading data', 'reading manifest');
  await resolveDataBase();
  state.calendarRows = [];
  state.docketRows = [];
  state.partyRows = [];
  state.attorneyRows = [];
  setStatus('loading directory', 'reading compact case groups');
  const hasDirectory = await loadCaseDirectoryManifest();
  if (!hasDirectory) {
    setStatus('loading index', 'legacy archive index');
    const caseRows = await loadCaseIndexRows();
    state.cases = [];
    state.caseByNumber.clear();
    rememberCases(caseRows);
  }
  populateFilters();

  const initialCase = requestedCaseFromLocation();
  if (initialCase) {
    await openCase(initialCase, { push: false });
  } else {
    renderResults();
  }
  setStatus('loaded', initialCase ? '' : archiveReadyText());
}

async function ensureEntityData(kind) {
  if (state.entityLoaded[kind]) return;
  if (state.entityPromises.has(kind)) return state.entityPromises.get(kind);
  const promise = (async () => {
    const tables = state.manifest?.tables || {};
    const tableName = kind === 'parties' ? 'parties' : 'attorneys';
    const path = tables[tableName]?.path;
    if (!path) throw new Error(`${tableName} table is unavailable`);
    setStatus(`loading ${kind}`, `loading ${scopeLabel(kind).toLowerCase()} index`);
    const progress = createLoadProgress({
      phase: `Loading ${scopeLabel(kind).toLowerCase()} index`,
      shardsTotal: 1,
      recordsTotal: tableRowsCount(tableName),
    });
    const unsubscribe = mountLoadProgress($('cs-body'), progress, {
      ariaLabel: `${scopeLabel(kind)} index loaded`,
    });
    let rows;
    try {
      rows = await loadEntityParquetRows(tableName, path, progress);
    } finally {
      unsubscribe();
    }
    if (kind === 'parties') {
      state.partyRows = rows;
      state.partyEntities = buildPartyEntities();
    } else {
      state.attorneyRows = rows;
      state.counselEntities = buildCounselEntities();
    }
    buildSearchIndexes();
    state.entityLoaded[kind] = true;
    setStatus('loaded', archiveReadyText());
  })().catch((err) => {
    setStatus('entity load error');
    throw err;
  }).finally(() => {
    state.entityPromises.delete(kind);
  });
  state.entityPromises.set(kind, promise);
  return promise;
}

async function ensureDocketData() {
  if (state.docketLoaded) return;
  if (state.docketPromise) return state.docketPromise;
  state.docketPromise = (async () => {
    const path = state.manifest?.tables?.docket_entries?.path;
    if (!path) throw new Error('docket entry table is unavailable');
    setStatus('loading docket search', 'loading docket text index');
    const progress = createLoadProgress({
      phase: 'Loading docket text index',
      shardsTotal: 1,
      recordsTotal: tableRowsCount('docket_entries'),
    });
    const unsubscribe = mountLoadProgress($('cs-body'), progress, {
      ariaLabel: 'Docket text index loaded',
    });
    try {
      state.docketRows = await loadEntityParquetRows('docket_entries', path, progress);
      buildSearchIndexes();
      state.docketLoaded = true;
    } finally {
      unsubscribe();
    }
    setStatus('loaded', archiveReadyText());
  })().finally(() => {
    state.docketPromise = null;
  });
  return state.docketPromise;
}

function provenanceDataSource() {
  return state.dataBase === REMOTE_DATA_BASE ? 'aimesy/kcsc-data@master' : state.dataBase;
}

function optionList(values, allLabel) {
  const opts = [`<option value="">${escapeHtml(allLabel)}</option>`];
  [...new Set(values.map(text).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .forEach((v) => opts.push(`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`));
  return opts.join('');
}

function populateFilters() {
  const values = state.directory?.filter_values || {};
  $('type-filter').innerHTML = optionList(values.case_types || state.cases.map((r) => r.case_type), 'All types');
  $('location-filter').innerHTML = optionList(values.locations || state.cases.map((r) => r.location_code), 'All locations');
  $('status-filter').innerHTML = optionList(values.status_groups || state.cases.map((r) => statusGroup(r.status)), 'All statuses');
  $('node-filter').innerHTML = optionList(values.portal_nodes || state.cases.map((r) => r.portal_node_id), 'All nodes');
}

function scopeLabel(scope = state.scope) {
  return {
    cases: 'Cases',
    parties: 'Parties',
    counsel: 'Counsel',
  }[scope] || 'Cases';
}

function scopePlaceholder(scope = state.scope) {
  return {
    cases: 'Search title, cause, status, node, case number, or namespaces',
    parties: 'Search party names, roles, counsel, address, or case number',
    counsel: 'Search counsel names, bar numbers, represented parties, or case number',
  }[scope] || 'Search title, cause, status, node, case number, or namespaces';
}

function applyScopeUi(scope = state.scope) {
  $('cs-scope-label').textContent = scopeLabel(scope);
  $('cs-search').placeholder = scopePlaceholder(scope);
  const caseScope = scope === 'cases';
  $('cs-filter-btn').hidden = !caseScope;
  if (!caseScope) {
    $('cs-filter-panel').hidden = true;
    $('cs-filter-btn').classList.remove('active');
  }
  document.querySelectorAll('input[name="cs-scope"]').forEach((radio) => {
    radio.checked = radio.value === scope;
  });
}

function clearEntityCaseFilter() {
  state.entityCaseFilter = null;
}

function findEntity(kind, key) {
  if (!kind || !key) return null;
  const rows = kind === 'parties' ? state.partyEntities : state.counselEntities;
  return rows.find((row) => row.key === key) || null;
}

function scheduleResults(delay = 260) {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => renderResults(), delay);
}

function bindEvents() {
  if (state.bound) return;
  state.bound = true;

  $('cs-filter-btn').addEventListener('click', () => {
    const panel = $('cs-filter-panel');
    panel.hidden = !panel.hidden;
    $('cs-filter-btn').classList.toggle('active', !panel.hidden);
  });

  $('cs-reset-btn').addEventListener('click', () => {
    ['cs-search', 'type-filter', 'location-filter', 'status-filter', 'from-date', 'to-date', 'node-filter', 'content-filter'].forEach((id) => {
      $(id).value = '';
    });
    $('sort-filter').value = 'filed_desc';
    state.selectedCaseNumber = '';
    state.selectedCase = null;
    clearEntityCaseFilter();
    clearCaseHash();
    renderResults();
  });

  $('cs-search').addEventListener('input', () => {
    clearEntityCaseFilter();
    scheduleResults();
  });
  ['type-filter', 'location-filter', 'status-filter', 'from-date', 'to-date', 'sort-filter', 'node-filter', 'content-filter']
    .forEach((id) => $(id).addEventListener('change', () => scheduleResults(0)));

  $('cs-scope-btn').addEventListener('click', () => {
    const menu = $('cs-scope-menu');
    menu.classList.toggle('open');
    $('cs-scope-btn').setAttribute('aria-expanded', menu.classList.contains('open') ? 'true' : 'false');
  });

  document.querySelectorAll('input[name="cs-scope"]').forEach((radio) => {
    radio.addEventListener('change', async () => {
      state.scope = radio.value;
      clearEntityCaseFilter();
      applyScopeUi(state.scope);
      $('cs-scope-menu').classList.remove('open');
      $('cs-scope-btn').setAttribute('aria-expanded', 'false');
      if (state.scope === 'parties' || state.scope === 'counsel') {
        try {
          await ensureEntityData(state.scope);
        } catch (err) {
          showBodyError(err.message || String(err), `entity:${state.scope}`);
          return;
        }
      }
      renderResults();
    });
  });

  document.addEventListener('click', (event) => {
    const scopeWrap = event.target.closest('.cs-scope-wrap');
    if (!scopeWrap) {
      $('cs-scope-menu').classList.remove('open');
      $('cs-scope-btn').setAttribute('aria-expanded', 'false');
    }

    const entityLink = event.target.closest('[data-entity-search]');
    if (entityLink) {
      event.preventDefault();
      const entity = findEntity(entityLink.getAttribute('data-entity-kind'), entityLink.getAttribute('data-entity-key'));
      state.entityCaseFilter = entity ? {
        kind: entity.kind,
        key: entity.key,
        label: entity.displayName,
        caseNumbers: new Set(entity.caseNumbers.map(normalizeCaseKey).filter(Boolean)),
      } : null;
      state.scope = 'cases';
      applyScopeUi(state.scope);
      $('cs-search').value = entityLink.getAttribute('data-entity-search') || '';
      renderResults();
      return;
    }

    const caseLink = event.target.closest('[data-case-open]');
    if (caseLink) {
      event.preventDefault();
      openCase(caseLink.getAttribute('data-case-open'));
      return;
    }

    const tab = event.target.closest('[data-cs-tab]');
    if (tab) {
      state.selectedTab = tab.getAttribute('data-cs-tab');
      pushCaseHash(state.selectedCaseNumber, state.selectedTab, { replace: true });
      renderDetail();
      return;
    }

    const retry = event.target.closest('[data-retry-action]');
    if (retry) {
      const action = retry.getAttribute('data-retry-action') || '';
      if (action === 'search') renderResults();
      else if (action === 'case' && state.selectedCaseNumber) openCase(state.selectedCaseNumber, { push: false });
      else if (action === 'reload') location.reload();
      else if (action.startsWith('entity:')) {
        const kind = action.split(':')[1];
        ensureEntityData(kind).then(renderResults).catch((err) => showBodyError(err.message || String(err), action));
      }
      return;
    }

    const directoryRetry = event.target.closest('[data-directory-retry]');
    if (directoryRetry) {
      const details = directoryRetry.closest('[data-directory-group-key]');
      if (details) hydrateDirectoryYearGroup(details);
      return;
    }

    const back = event.target.closest('[data-results-back]');
    if (back) {
      event.preventDefault();
      state.selectedCaseNumber = '';
      state.selectedCase = null;
      clearCaseHash();
      renderResults();
    }
  });

  document.addEventListener('toggle', (event) => {
    if (event.target?.hasAttribute?.('data-directory-group-key')) hydrateDirectoryYearGroup(event.target);
    else hydrateCaseYearGroup(event.target);
  }, true);

  window.addEventListener('popstate', async () => {
    const requested = requestedCaseFromLocation();
    if (requested) {
      await openCase(requested, { push: false });
    } else {
      state.selectedCaseNumber = '';
      state.selectedCase = null;
      renderResults();
    }
  });
}

function requestedCaseFromLocation() {
  const params = new URLSearchParams(location.search);
  const queryCase = params.get('case');
  if (queryCase) return queryCase;
  const hash = location.hash.replace(/^#/, '');
  const hashParams = new URLSearchParams(hash);
  return hashParams.get('case') || '';
}

function requestedTabFromLocation() {
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  return text(hashParams.get('tab')) || 'summary';
}

function pushCaseHash(caseNumber, tab = '', options = {}) {
  const url = new URL(location.href);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  hashParams.set('case', caseNumber);
  if (tab && tab !== 'summary') hashParams.set('tab', tab);
  else hashParams.delete('tab');
  url.hash = hashParams.toString();
  history[options.replace ? 'replaceState' : 'pushState'](null, '', url);
}

function clearCaseHash() {
  const url = new URL(location.href);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  hashParams.delete('case');
  hashParams.delete('tab');
  url.hash = hashParams.toString();
  history.pushState(null, '', url);
}

function parseQuery(raw) {
  const filters = [];
  const free = text(raw).replace(/\b(case|title|party|counsel|docket|cause|status|node|from|to):(?:"([^"]*)"|(\S+))/ig, (_match, field, quoted, bare) => {
    filters.push({ field: field.toLowerCase(), value: text(quoted || bare) });
    return ' ';
  });
  return { free: norm(free), filters };
}

function caseSearchText(row) {
  return [
    row.case_number,
    row.display_case_number,
    row.case_title,
    row.case_type,
    row.status,
    row.status_group || statusGroup(row.status),
    row.cause_of_action,
    row.location_code,
    row.portal_node_id,
    row.portal_case_id,
  ].map(text).join(' ');
}

function caseFullSearchText(row) {
  const key = text(row.case_number);
  return [
    caseSearchText(row),
    state.partyIndex.get(key) || '',
    state.counselIndex.get(key) || '',
    state.docketIndex.get(key) || '',
  ].map(text).join(' ');
}

function namespaceText(row, field) {
  const key = text(row.case_number);
  if (field === 'case') return [row.case_number, row.display_case_number].map(text).join(' ');
  if (field === 'title') return row.case_title;
  if (field === 'party') return state.partyIndex.get(key) || '';
  if (field === 'counsel') return state.counselIndex.get(key) || '';
  if (field === 'docket') return state.docketIndex.get(key) || '';
  if (field === 'cause') return row.cause_of_action;
  if (field === 'status') return [row.status, row.status_group || statusGroup(row.status)].map(text).join(' ');
  if (field === 'node') return row.portal_node_id;
  return '';
}

function matchesNamespace(row, filter) {
  const value = norm(filter.value);
  if (!value) return true;
  const filed = text(row.filed_date || row.filing_date);
  if (filter.field === 'from') return filed && filed >= filter.value;
  if (filter.field === 'to') return filed && filed <= filter.value;
  return norm(namespaceText(row, filter.field)).includes(value);
}

function currentFilters() {
  return {
    parsed: parseQuery($('cs-search').value),
    type: text($('type-filter').value),
    loc: text($('location-filter').value),
    status: text($('status-filter').value),
    from: text($('from-date').value),
    to: text($('to-date').value),
    node: text($('node-filter').value),
    content: text($('content-filter').value),
    sort: text($('sort-filter').value),
  };
}

function caseMatchesFilters(row, filters, includeFreeText = true) {
  const filed = text(row.filed_date || row.filing_date);
  if (includeFreeText && filters.parsed.free && !matchesTerms(caseFullSearchText(row), filters.parsed.free)) return false;
  if (filters.parsed.filters.some((filter) => !matchesNamespace(row, filter))) return false;
  if (filters.type && text(row.case_type) !== filters.type) return false;
  if (filters.loc && text(row.location_code) !== filters.loc) return false;
  if (filters.status && text(row.status_group || statusGroup(row.status)) !== filters.status) return false;
  if (filters.node && text(row.portal_node_id) !== filters.node) return false;
  if (filters.from && (!filed || filed < filters.from)) return false;
  if (filters.to && (!filed || filed > filters.to)) return false;
  if (filters.content === 'docket' && !num(row.docket_entry_count)) return false;
  if (filters.content === 'hearing' && !num(row.calendar_count)) return false;
  if (filters.content === 'party' && !num(row.party_count)) return false;
  if (filters.content === 'counsel' && !num(row.attorney_count)) return false;
  if (filters.content === 'document' && !row.has_document_index_rows) return false;
  return true;
}

function sortCaseRows(rows, sort) {
  rows = rows.slice().sort((a, b) => {
    if (sort === 'filed_asc') return text(a.filed_date).localeCompare(text(b.filed_date)) || text(a.case_number).localeCompare(text(b.case_number));
    if (sort === 'case_number') return text(a.case_number).localeCompare(text(b.case_number));
    if (sort === 'docket_count') return num(b.docket_entry_count) - num(a.docket_entry_count) || text(a.case_number).localeCompare(text(b.case_number));
    if (sort === 'hearing_date') return text(a.next_hearing?.court_date || '9999-99-99').localeCompare(text(b.next_hearing?.court_date || '9999-99-99'));
    return text(b.filed_date).localeCompare(text(a.filed_date)) || text(a.case_number).localeCompare(text(b.case_number));
  });
  return rows;
}

function filteredCases() {
  const filters = currentFilters();
  return sortCaseRows(state.cases.filter((row) => {
    if (state.entityCaseFilter && !state.entityCaseFilter.caseNumbers.has(normalizeCaseKey(row.case_number))) return false;
    return caseMatchesFilters(row, filters, true);
  }), filters.sort);
}

function entitySearchText(kind, entity) {
  const caseText = [
    ...(entity.caseNumbers || []),
    ...(entity.cases || []).map(caseFullSearchText),
  ].join(' ');
  if (kind === 'parties') {
    return [
      entity.displayName,
      entity.roles.join(' '),
      entity.attorneys.join(' '),
      entity.addresses.join(' '),
      caseText,
    ].map(text).join(' ');
  }
  return [
    entity.displayName,
    entity.barNumbers.join(' '),
    entity.represented.join(' '),
    entity.contacts.join(' '),
    caseText,
  ].map(text).join(' ');
}

function filteredEntities(kind) {
  const filters = currentFilters();
  const rows = (kind === 'parties' ? state.partyEntities : state.counselEntities)
    .map((entity) => ({
      ...entity,
      visibleCaseNumbers: entity.caseNumbers || [],
      visibleCases: sortCaseRows(entity.cases || [], filters.sort),
    }))
    .filter((entity) => entity.visibleCaseNumbers.length)
    .filter((entity) => !filters.parsed.free || matchesTerms(entitySearchText(kind, entity), filters.parsed.free));
  return rows.sort((a, b) => (b.visibleCaseNumbers.length - a.visibleCaseNumbers.length)
    || (b.rowCount - a.rowCount)
    || text(a.displayName).localeCompare(text(b.displayName)));
}

function activeChips() {
  const chips = [];
  const q = text($('cs-search').value);
  if (state.scope !== 'cases') {
    if (q) chips.push(`${$('cs-scope-label').textContent}: ${q}`);
    return chips;
  }
  const type = text($('type-filter').value);
  const loc = text($('location-filter').value);
  const status = text($('status-filter').value);
  const node = text($('node-filter').value);
  const content = text($('content-filter').value);
  if (q) chips.push(`${$('cs-scope-label').textContent}: ${q}`);
  if (type) chips.push(type);
  if (loc) chips.push(loc);
  if (status) chips.push(status);
  if (node) chips.push(`node ${node}`);
  if (content) chips.push(content);
  if ($('from-date').value || $('to-date').value) chips.push(`${$('from-date').value || 'start'} to ${$('to-date').value || 'end'}`);
  return chips;
}

function caseStateLegendHtml() {
  const items = [
    ['cs-case-state-dot', 'index only'],
    ['cs-case-state-ring', 'docket/hearing rows'],
    ['cs-case-state-partial', 'party/counsel rows'],
    ['cs-case-state-check', 'case rows + people'],
  ];
  return `<span class="cs-case-legend" aria-label="Case row legend">${items.map(([className, label]) => (
    `<span class="cs-case-legend-item"><span class="cs-case-state mini"><span class="${className}"></span></span>${escapeHtml(label)}</span>`
  )).join('')}</span>`;
}

function directoryBrowseEligible(filters) {
  return state.directory
    && !filters.parsed.free
    && !filters.parsed.filters.length
    && !filters.status
    && !filters.from
    && !filters.to
    && !filters.node
    && !filters.content
    && filters.sort === 'filed_desc'
    && !state.entityCaseFilter;
}

function directoryGroupKey(group) {
  return [group.caseType, group.location, group.year].join('|');
}

function resultCountHtml(count, total, options = {}) {
  const chips = activeChips();
  const chipHtml = chips.map((chip) => `<span class="cs-badge cs-src">${escapeHtml(chip)}</span>`).join('');
  const capped = options.capped ? '+' : '';
  const note = options.note ? `<span>${escapeHtml(options.note)}</span>` : '';
  return `<p class="cs-count"><strong>${nf.format(count)}${capped} case${count === 1 && !options.capped ? '' : 's'}</strong><span>${nf.format(total)} indexed</span>${note}${chipHtml}${caseStateLegendHtml()}</p>`;
}

function renderDirectoryBrowse(filters) {
  const groups = directoryGroups(state.directory, {
    caseType: filters.type,
    location: filters.loc,
  });
  state.directoryGroupRows.clear();
  const count = groups.reduce((sum, group) => sum + group.rows, 0);
  const byType = grouped(groups, (group) => group.caseType);
  const body = sortedEntries(byType).map(([caseType, typeGroups]) => {
    const typeCount = typeGroups.reduce((sum, group) => sum + group.rows, 0);
    const byLocation = grouped(typeGroups, (group) => group.location);
    const locations = sortedEntries(byLocation).map(([location, locationGroups]) => {
      const locationCount = locationGroups.reduce((sum, group) => sum + group.rows, 0);
      const years = locationGroups.map((group) => {
        const key = directoryGroupKey(group);
        state.directoryGroupRows.set(key, group);
        const year = group.year === 'unknown' ? 'Unknown year' : group.year;
        return `<details class="cs-year-group" data-directory-group-key="${escapeHtml(key)}">
          <summary class="cs-year-head"><span class="cs-year-tag">${escapeHtml(year)}</span><span class="cs-year-count">${nf.format(group.rows)} cases</span></summary>
          <div data-directory-group-body></div>
        </details>`;
      }).join('');
      return `<details class="cs-prefix-group" open>
        <summary class="cs-prefix-head"><span class="cs-prefix-code">${escapeHtml(location)}</span><span class="cs-prefix-count">${nf.format(locationCount)} cases</span></summary>
        ${years}
      </details>`;
    }).join('');
    return `<details class="cs-type-group" open>
      <summary class="cs-type-head"><span class="cs-type-tag">${escapeHtml(caseType.toUpperCase())}</span><span class="cs-type-count">${nf.format(typeCount)} cases</span></summary>
      ${locations}
    </details>`;
  }).join('');
  $('cs-body').innerHTML = `${resultCountHtml(count, state.directory.case_count)}${body || '<div class="cs-empty">No matching case groups.</div>'}`;
}

async function hydrateDirectoryYearGroup(details) {
  if (!details?.open || !details.hasAttribute('data-directory-group-key')) return;
  const key = details.getAttribute('data-directory-group-key');
  const group = state.directoryGroupRows.get(key);
  const body = details.querySelector('[data-directory-group-body]');
  if (!group || !body || body.dataset.hydrated === '1') return;
  if (state.directoryHydratedRows.has(key)) {
    try {
      const rows = await state.directoryHydratedRows.get(key);
      if (details.isConnected) {
        body.innerHTML = `<ul class="cs-results">${rows.map(renderCaseRow).join('')}</ul>`;
        body.dataset.hydrated = '1';
      }
    } catch {
      // The original loader renders the actionable error.
    }
    return;
  }

  const sources = uniqueDirectorySources([group]);
  const progress = createLoadProgress({
    phase: `Loading ${group.caseType} ${group.location} ${group.year}`,
    bytesTotal: sources.reduce((sum, source) => sum + num(source.size_bytes), 0),
    shardsTotal: sources.length,
    recordsTotal: sources.reduce((sum, source) => sum + num(source.rows), 0),
  });
  const unsubscribe = mountLoadProgress(body, progress, { ariaLabel: 'Case rows loaded' });
  const promise = (async () => {
    const bytesByPath = new Map();
    let shardsLoaded = 0;
    let recordsLoaded = 0;
    const results = [];
    for (const source of sources) {
      const result = await state.directoryClient.loadSource(source, {
        onProgress: ({ loaded }) => {
          bytesByPath.set(source.path, loaded);
          progress.update({ bytesLoaded: [...bytesByPath.values()].reduce((sum, value) => sum + value, 0) });
        },
        onPhase: () => progress.update({ phase: `Indexing ${group.year} case rows` }),
      });
      bytesByPath.set(source.path, result.bytesLoaded);
      shardsLoaded += 1;
      recordsLoaded += result.rows.length;
      results.push(...result.rows);
      progress.update({
        bytesLoaded: [...bytesByPath.values()].reduce((sum, value) => sum + value, 0),
        shardsLoaded,
        recordsLoaded,
      });
    }
    const unique = new Map();
    for (const row of results) {
      if (!rowMatchesGroup(row, group)) continue;
      const rowKey = normalizeCaseKey(row.case_number);
      if (rowKey) unique.set(rowKey, row);
    }
    if (unique.size !== group.rows) {
      throw new Error(`case group expected ${nf.format(group.rows)} rows but found ${nf.format(unique.size)}`);
    }
    return sortCaseRows(rememberCases([...unique.values()]), 'filed_desc');
  })();
  state.directoryHydratedRows.set(key, promise);
  try {
    const rows = await promise;
    state.directoryHydratedRows.set(key, rows);
    if (details.isConnected) {
      body.innerHTML = `<ul class="cs-results">${rows.map(renderCaseRow).join('')}</ul>`;
      body.dataset.hydrated = '1';
    }
  } catch (error) {
    state.directoryHydratedRows.delete(key);
    if (details.isConnected) {
      body.innerHTML = `<div class="cs-error">${escapeHtml(error.message || String(error))} <button type="button" class="hbtn" data-directory-retry="${escapeHtml(key)}">Retry</button></div>`;
    }
  } finally {
    unsubscribe();
  }
}

function searchNamespaceFields(filters) {
  return new Set(filters.parsed.filters.map((filter) => filter.field));
}

async function prepareCaseSearch(filters) {
  const fields = searchNamespaceFields(filters);
  if (fields.has('party')) await ensureEntityData('parties');
  if (fields.has('counsel')) await ensureEntityData('counsel');
  if (fields.has('docket')) await ensureDocketData();
}

function caseSearchPrefix(filters) {
  const caseFilter = filters.parsed.filters.find((filter) => filter.field === 'case');
  const raw = text(caseFilter?.value || filters.parsed.free);
  const normalized = normalizeCaseKey(raw);
  return /^\d[A-Z0-9]{7,}$/.test(normalized) ? normalized.slice(0, 3) : '';
}

async function runCaseSearch(filters, searchSeq) {
  const current = () => searchSeq === state.searchSeq && state.scope === 'cases';
  try {
    await prepareCaseSearch(filters);
    if (!current()) return;
    const groups = directoryGroups(state.directory, {
      caseType: filters.type,
      location: filters.loc,
      from: filters.from || filters.parsed.filters.find((filter) => filter.field === 'from')?.value,
      to: filters.to || filters.parsed.filters.find((filter) => filter.field === 'to')?.value,
    });
    let batches = directorySourceBatches(groups);
    const prefix = caseSearchPrefix(filters);
    if (prefix) {
      batches = batches
        .map((batch) => ({ ...batch, sources: batch.sources.filter((source) => text(source.prefix) === prefix) }))
        .filter((batch) => batch.sources.length);
    }
    if (state.entityCaseFilter) {
      const prefixes = new Set([...state.entityCaseFilter.caseNumbers].map((value) => normalizeCaseKey(value).slice(0, 3)));
      batches = batches
        .map((batch) => ({ ...batch, sources: batch.sources.filter((source) => prefixes.has(text(source.prefix))) }))
        .filter((batch) => batch.sources.length);
    }
    const sources = batches.flatMap((batch) => batch.sources);

    const progress = createLoadProgress({
      phase: 'Searching compact case index',
      bytesTotal: sources.reduce((sum, source) => sum + num(source.size_bytes), 0),
      shardsTotal: sources.length,
      recordsTotal: sources.reduce((sum, source) => sum + num(source.rows), 0),
    });
    const unsubscribe = mountLoadProgress($('cs-body'), progress, { ariaLabel: 'Case search progress' });
    const bytesByPath = new Map();
    const matches = new Map();
    const errors = [];
    let attemptedSources = 0;
    let shardsLoaded = 0;
    let recordsLoaded = 0;
    const canStopEarly = filters.sort === 'filed_desc';
    async function loadBatch(batch) {
      let nextInBatch = 0;
      async function worker() {
        while (current() && nextInBatch < batch.sources.length) {
          const source = batch.sources[nextInBatch++];
          attemptedSources += 1;
          try {
            const result = await state.directoryClient.loadSource(source, {
              onProgress: ({ loaded }) => {
                bytesByPath.set(source.path, loaded);
                progress.update({ bytesLoaded: [...bytesByPath.values()].reduce((sum, value) => sum + value, 0) });
              },
              onPhase: () => progress.update({ phase: `Filtering ${batch.year} compact case rows` }),
            });
            if (!current()) return;
            bytesByPath.set(source.path, result.bytesLoaded);
            shardsLoaded += 1;
            recordsLoaded += result.rows.length;
            for (const row of rememberCases(result.rows)) {
              const key = normalizeCaseKey(row.case_number);
              if (!key || matches.has(key)) continue;
              if (state.entityCaseFilter && !state.entityCaseFilter.caseNumbers.has(key)) continue;
              if (caseMatchesFilters(row, filters, true)) matches.set(key, row);
            }
            progress.update({
              bytesLoaded: [...bytesByPath.values()].reduce((sum, value) => sum + value, 0),
              shardsLoaded,
              recordsLoaded,
            });
          } catch (error) {
            errors.push(`${source.path}: ${error.message || error}`);
          }
        }
      }
      await Promise.all(Array.from({
        length: Math.min(CASE_SEARCH_CONCURRENCY, Math.max(1, batch.sources.length)),
      }, worker));
    }
    for (const batch of batches) {
      if (!current()) break;
      await loadBatch(batch);
      if (canStopEarly && matches.size > CASE_SEARCH_RESULT_LIMIT) break;
    }
    unsubscribe();
    if (!current()) return;
    if (errors.length) throw new Error(`Case search was incomplete. ${errors[0]}`);
    const sorted = sortCaseRows([...matches.values()], filters.sort);
    const capped = sorted.length > CASE_SEARCH_RESULT_LIMIT || attemptedSources < sources.length;
    renderCaseResults(sorted.slice(0, CASE_SEARCH_RESULT_LIMIT), {
      capped,
      scanned: recordsLoaded,
    });
  } catch (error) {
    if (!current()) return;
    setStatus('search error');
    showBodyError(error.message || String(error), 'search');
  }
}

function renderResults() {
  if (!state.directory && !state.cases.length) return;
  clearTimeout(state.searchTimer);
  state.caseOpenSeq += 1;
  const searchSeq = ++state.searchSeq;
  state.selectedCase = null;
  $('cs-tabstrip').hidden = true;
  applyScopeUi(state.scope);
  if (state.scope === 'parties' || state.scope === 'counsel') {
    renderEntityResults(state.scope);
    return;
  }
  $('cs-kicker').textContent = 'Cases';
  $('cs-entity-title').textContent = 'King County Superior Court';
  $('cs-entity-meta').textContent = archiveReadyText();
  const filters = currentFilters();
  if (directoryBrowseEligible(filters)) {
    renderDirectoryBrowse(filters);
    return;
  }
  if (state.directory) {
    runCaseSearch(filters, searchSeq);
    return;
  }
  renderCaseResults(filteredCases(), { scanned: state.cases.length });
}

function renderCaseResults(rows, options = {}) {
  $('cs-kicker').textContent = 'Cases';
  $('cs-entity-title').textContent = 'King County Superior Court';
  $('cs-entity-meta').textContent = archiveReadyText();
  setStatus('loaded', `${nf.format(rows.length)} search results`);
  const count = resultCountHtml(rows.length, state.directory?.case_count || state.cases.length, {
    capped: options.capped,
    note: options.scanned ? `${nf.format(options.scanned)} compact rows scanned` : '',
  });
  const body = rows.length ? renderCaseGroups(rows) : '<div class="cs-empty">No matching cases.</div>';
  $('cs-body').innerHTML = `${count}${body}`;
}

function renderEntityResults(kind) {
  const matches = filteredEntities(kind);
  const rows = matches.slice(0, CASE_SEARCH_RESULT_LIMIT);
  const total = kind === 'parties' ? state.partyEntities.length : state.counselEntities.length;
  const rawRows = kind === 'parties' ? state.partyRows.length : state.attorneyRows.length;
  const label = scopeLabel(kind);
  const noun = kind === 'parties' ? 'parties' : 'counsel';
  const chips = activeChips();
  const chipHtml = chips.map((chip) => `<span class="cs-badge cs-src">${escapeHtml(chip)}</span>`).join('');
  $('cs-kicker').textContent = label;
  $('cs-entity-title').textContent = 'King County Superior Court';
  $('cs-entity-meta').textContent = `${nf.format(total)} ${noun} | ${nf.format(rawRows)} normalized rows`;
  const count = `<p class="cs-count"><strong>${nf.format(rows.length)}${matches.length > rows.length ? '+' : ''} ${noun}</strong><span>${nf.format(total)} loaded</span>${chipHtml}</p>`;
  const body = rows.length ? renderEntityGroups(kind, rows) : `<div class="cs-empty">No matching ${noun}.</div>`;
  $('cs-body').innerHTML = `${count}${body}`;
}

function grouped(rows, getter) {
  const map = new Map();
  for (const row of rows) {
    const key = text(getter(row)) || 'Unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function sortedEntries(map, mode = 'alpha') {
  const entries = [...map.entries()];
  if (mode === 'year_desc') {
    return entries.sort((a, b) => {
      const ay = /^\d+$/.test(a[0]) ? Number(a[0]) : -1;
      const by = /^\d+$/.test(b[0]) ? Number(b[0]) : -1;
      return by - ay || a[0].localeCompare(b[0]);
    });
  }
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

function matterLabel(count) {
  return `${nf.format(count)} matter${count === 1 ? '' : 's'}`;
}

function entityMatterCount(entity) {
  return entity.visibleCaseNumbers?.length || entity.caseNumbers?.length || entity.visibleCases?.length || 0;
}

function entityBand(rows) {
  const thresholds = [1000, 500, 250, 100, 50, 25, 10, 5, 2, 1];
  const groups = new Map();
  for (const row of rows) {
    const count = entityMatterCount(row);
    const low = thresholds.find((n) => count >= n) || 1;
    const label = low === 1 ? '1 matter' : `${nf.format(low)}+ matters`;
    if (!groups.has(label)) groups.set(label, { low, rows: [] });
    groups.get(label).rows.push(row);
  }
  return [...groups.values()].sort((a, b) => b.low - a.low);
}

function renderEntityGroups(kind, rows) {
  const noun = kind === 'parties' ? 'parties' : 'counsel';
  return entityBand(rows).map((group) => {
    const totalMatters = group.rows.reduce((sum, row) => sum + entityMatterCount(row), 0);
    return `<details class="cs-prefix-group" open>
      <summary class="cs-prefix-head"><span class="cs-prefix-code">${escapeHtml(entityMatterCount(group.rows[0]) === 1 ? '1' : `${group.low}+`)}</span><span class="cs-prefix-count">${nf.format(group.rows.length)} ${noun} | ${matterLabel(totalMatters)}</span></summary>
      <ul class="cs-results">${group.rows.map((row) => renderEntityRow(kind, row)).join('')}</ul>
    </details>`;
  }).join('');
}

function quotedQueryValue(value) {
  return text(value).replace(/"/g, ' ');
}

function renderEntityRow(kind, entity) {
  const isParty = kind === 'parties';
  const query = `${isParty ? 'party' : 'counsel'}:"${quotedQueryValue(entity.displayName)}"`;
  const right = isParty
    ? [
      entity.roles.slice(0, 2).join(', '),
      entity.attorneys.length ? `counsel ${entity.attorneys.slice(0, 2).join(', ')}` : '',
      `${nf.format(entity.rowCount)} rows`,
    ]
    : [
      entity.barNumbers.length ? `bar ${entity.barNumbers.slice(0, 2).join(', ')}` : '',
      entity.represented.length ? `represents ${entity.represented.slice(0, 2).join(', ')}` : '',
      `${nf.format(entity.rowCount)} rows`,
    ];
  return `<li>
    <a class="cs-case-row-link" href="#cases" data-entity-search="${escapeHtml(query)}" data-entity-kind="${escapeHtml(kind)}" data-entity-key="${escapeHtml(entity.key)}" title="Show matching cases">
      <span class="cs-case-state"><span class="${isParty ? 'cs-case-state-ring' : 'cs-case-state-check'}"></span></span>
      <span class="cs-r-title">${escapeHtml(matterLabel(entityMatterCount(entity)))}</span>
      <span class="cs-r-title-name">${escapeHtml(entity.displayName || '(unnamed)')}</span>
      <span class="cs-r-meta">${escapeHtml(right.map(text).filter(Boolean).join(' | '))}</span>
    </a>
  </li>`;
}

function renderCaseGroups(rows) {
  state.caseGroupRows = new Map();
  let groupSeq = 0;
  const byType = grouped(rows, (row) => row.case_type || 'unknown');
  const openTypes = rows.length <= 15000 || byType.size <= 5;
  return sortedEntries(byType).map(([type, typeRows]) => {
    const byLocation = grouped(typeRows, (row) => row.location_code || 'No location');
    const openLocations = rows.length <= 5000 || typeRows.length <= 1200;
    const locations = sortedEntries(byLocation).map(([location, locRows]) => {
      const byYear = grouped(locRows, (row) => yearFromDate(row.filed_date || row.filing_date));
      const openYears = locRows.length <= 250;
      const years = sortedEntries(byYear, 'year_desc').map(([year, yearRows]) => {
        const groupKey = `g${groupSeq++}`;
        const renderNow = openLocations && openYears;
        state.caseGroupRows.set(groupKey, yearRows);
        return `<details class="cs-year-group"${renderNow ? ' open' : ''}>
          <summary class="cs-year-head"><span class="cs-year-tag">${escapeHtml(year)}</span><span class="cs-year-count">${nf.format(yearRows.length)} cases</span></summary>
          <ul class="cs-results" data-case-group-key="${escapeHtml(groupKey)}"${renderNow ? ' data-hydrated="1"' : ''}>${renderNow ? yearRows.map(renderCaseRow).join('') : ''}</ul>
        </details>`;
      }).join('');
      return `<details class="cs-prefix-group"${openLocations ? ' open' : ''}>
        <summary class="cs-prefix-head"><span class="cs-prefix-code">${escapeHtml(location)}</span><span class="cs-prefix-count">${nf.format(locRows.length)} cases</span></summary>
        ${years}
      </details>`;
    }).join('');
    return `<details class="cs-type-group"${openTypes ? ' open' : ''}>
      <summary class="cs-type-head"><span class="cs-type-tag">${escapeHtml(type.toUpperCase())}</span><span class="cs-type-count">${nf.format(typeRows.length)} cases</span></summary>
      ${locations}
    </details>`;
  }).join('');
}

function rowStateClass(row) {
  const hasActions = num(row.docket_entry_count) || num(row.calendar_count);
  const hasPeople = num(row.party_count) || num(row.attorney_count);
  if (hasActions && hasPeople) return 'cs-case-state-check';
  if (hasActions) return 'cs-case-state-ring';
  if (hasPeople) return 'cs-case-state-partial';
  return 'cs-case-state-dot';
}

function caseField(label, value) {
  const v = text(value);
  if (!v) return '';
  return `<span class="cs-case-field"><span>${escapeHtml(label)}</span><b>${escapeHtml(v)}</b></span>`;
}

function renderCaseMetaFields(row) {
  const hearing = row.next_hearing;
  const filed = displayDate(row.filed_date || row.filing_date);
  return [
    caseField('Filed', filed),
    caseField('Nature', row.cause_of_action),
    caseField('Status', row.status_group || statusGroup(row.status)),
    caseField('Type', row.case_type),
    caseField('Loc', row.location_code),
    caseField('ROA', num(row.docket_entry_count) ? nf.format(num(row.docket_entry_count)) : ''),
    caseField('Party', num(row.party_count) ? nf.format(num(row.party_count)) : ''),
    caseField('Atty', num(row.attorney_count) ? nf.format(num(row.attorney_count)) : ''),
    caseField('Next', hearing ? compactDateTime(hearing.court_date, hearing.hearing_time) : ''),
  ].filter(Boolean).join('');
}

function renderCaseRow(row) {
  const caseNumber = text(row.case_number);
  const displayNumber = text(row.display_case_number || row.case_number);
  const selected = caseNumber === state.selectedCaseNumber ? ' is-selected' : '';
  return `<li class="${selected.trim()}">
    <a class="cs-case-row-link" href="#case=${encodeURIComponent(caseNumber)}" data-case-open="${escapeHtml(caseNumber)}">
      <span class="cs-case-state"><span class="${rowStateClass(row)}"></span></span>
      <span class="cs-r-title">${escapeHtml(displayNumber)}</span>
      <span class="cs-r-title-name">${escapeHtml(row.case_title || '(untitled)')}</span>
      <span class="cs-r-meta cs-case-fields">${renderCaseMetaFields(row)}</span>
    </a>
  </li>`;
}

function hydrateCaseYearGroup(details) {
  if (!details?.classList?.contains('cs-year-group') || !details.open) return;
  const list = details.querySelector('.cs-results[data-case-group-key]');
  if (!list || list.dataset.hydrated) return;
  const rows = state.caseGroupRows.get(list.dataset.caseGroupKey) || [];
  list.innerHTML = rows.map(renderCaseRow).join('');
  list.dataset.hydrated = '1';
}

function findCase(caseNumber) {
  return caseRowFor(caseNumber);
}

async function loadCase(caseNumber, progress = null) {
  const row = findCase(caseNumber);
  const canonical = normalizeCaseKey(row?.case_number || caseNumber);
  if (!canonical) throw new Error('Invalid case number');
  if (state.detailCache.has(canonical)) return await state.detailCache.get(canonical);
  const path = `archive/cases/${encodeURIComponent(canonical)}.json`;
  const promise = (async () => {
    const result = await fetchJsonWithProgress(dataUrl(path), { cache: 'no-cache' }, {
      fetchImpl: (input, init) => fetchWithTimeout(input, init),
      onProgress: ({ loaded, total }) => progress?.update({ bytesLoaded: loaded, bytesTotal: total }),
      onPhase: () => progress?.update({ phase: 'Opening case profile' }),
    });
    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
      throw new Error(`Invalid case profile at ${path}`);
    }
    progress?.update({
      phase: 'Case profile ready',
      shardsLoaded: 1,
      recordsLoaded: 1,
    });
    return result.data;
  })();
  state.detailCache.set(canonical, promise);
  try {
    const record = await promise;
    state.detailCache.set(canonical, record);
    return record;
  } catch (error) {
    state.detailCache.delete(canonical);
    throw error;
  }
}

async function openCase(caseNumber, options = {}) {
  const { push = true } = options;
  clearTimeout(state.searchTimer);
  state.searchSeq += 1;
  const openSeq = ++state.caseOpenSeq;
  const row = findCase(caseNumber);
  const canonical = normalizeCaseKey(row?.case_number || caseNumber);
  if (!canonical) return;
  state.selectedCaseNumber = canonical;
  state.selectedTab = text(options.tab) || requestedTabFromLocation() || 'summary';
  $('cs-tabstrip').hidden = true;
  $('cs-kicker').textContent = 'Case';
  $('cs-entity-title').textContent = text(row?.display_case_number || canonical);
  $('cs-entity-meta').textContent = text(row?.case_title || 'loading case');
  const progress = createLoadProgress({
    phase: 'Loading case profile',
    shardsTotal: 1,
    recordsTotal: 1,
  });
  const unsubscribe = mountLoadProgress($('cs-body'), progress, { ariaLabel: 'Case profile loaded' });
  if (push) pushCaseHash(canonical, state.selectedTab);

  try {
    const record = await loadCase(canonical, progress);
    if (openSeq !== state.caseOpenSeq) return;
    state.selectedCase = record;
    const availableTabs = new Set(tabsForCase(record).map(([key]) => key));
    if (!availableTabs.has(state.selectedTab)) state.selectedTab = 'summary';
    if (push) pushCaseHash(canonical, state.selectedTab, { replace: true });
    renderDetail();
  } catch (err) {
    if (openSeq !== state.caseOpenSeq) return;
    showBodyError(err.message || String(err), 'case');
    setStatus('case load error');
  } finally {
    unsubscribe();
  }
}

function tabsForCase(record) {
  const kcsc = record.kcsc || {};
  const tabs = [
    ['summary', 'Summary'],
    ['docket', `Docket ${record.docket_entries?.length || 0}`],
    ['hearings', `Hearings ${record.calendar?.length || 0}`],
    ['parties', `Parties ${record.parties?.length || 0}`],
    ['counsel', `Counsel ${record.attorneys?.length || 0}`],
  ];
  if ((kcsc.charge_rows || []).length) tabs.push(['charges', `Charges ${kcsc.charge_rows.length}`]);
  if ((kcsc.judgment_rows || []).length) tabs.push(['judgments', `Judgments ${kcsc.judgment_rows.length}`]);
  if ((kcsc.document_rows_deferred || []).length) tabs.push(['documents', `Documents ${kcsc.document_rows_deferred.length}`]);
  tabs.push(['provenance', 'Provenance']);
  tabs.push(['raw', 'Raw']);
  return tabs;
}

function renderTabs(record) {
  const tabs = tabsForCase(record);
  $('cs-tabstrip').hidden = false;
  $('cs-tabstrip').innerHTML = tabs.map(([key, label]) => (
    `<button type="button" class="cs-tab${state.selectedTab === key ? ' active' : ''}" data-cs-tab="${escapeHtml(key)}" role="tab" aria-selected="${state.selectedTab === key ? 'true' : 'false'}">${escapeHtml(label)}</button>`
  )).join('');
}

function renderDetail() {
  const record = state.selectedCase;
  if (!record) return;
  renderTabs(record);
  $('cs-kicker').textContent = 'Case';
  $('cs-entity-title').textContent = text(record.display_case_number || record.case_number);
  $('cs-entity-meta').textContent = text(record.case_title || 'untitled');
  setStatus('case loaded');

  const kcsc = record.kcsc || {};
  const headerMeta = [
    record.case_type,
    caseLocation(record),
    record.status,
    record.filed_date ? `filed ${displayDate(record.filed_date)}` : '',
    kcsc.portal_node_id ? `node ${kcsc.portal_node_id}` : '',
    kcsc.portal_case_id ? `portal ${kcsc.portal_case_id}` : '',
  ].map(text).filter(Boolean).join(' | ');

  const sourceHref = safeHttpHref(record.source_url);
  const sourceLink = sourceHref
    ? `<a class="hbtn" href="${escapeHtml(sourceHref)}" target="_blank" rel="noopener noreferrer">Official docket &#8599;</a>`
    : '';

  $('cs-body').innerHTML = `<article class="cs-case-detail">
    <header class="cs-detail-head">
      <div class="cs-casenum">${escapeHtml(record.display_case_number || record.case_number || '')}</div>
      <div class="cs-title-line">
        <div class="cs-casetitle">${escapeHtml(record.case_title || '(untitled)')}</div>
      </div>
      <div class="cs-headmeta">${escapeHtml(headerMeta)}</div>
      <div class="cs-action-row">
        <button class="hbtn" type="button" data-results-back>Back to results</button>
        ${sourceLink}
      </div>
    </header>
    ${renderTabContent(record)}
  </article>`;
}

function renderTabContent(record) {
  const renderers = {
    summary: renderSummary,
    docket: () => renderDocket(record.docket_entries || []),
    hearings: () => renderHearings(record.calendar || []),
    parties: () => renderParties(record.parties || []),
    counsel: () => renderCounsel(record.attorneys || []),
    charges: () => renderSourceRows(record.kcsc?.charge_rows || [], 'No charge rows.'),
    judgments: () => renderSourceRows(record.kcsc?.judgment_rows || [], 'No judgment rows.'),
    documents: () => renderDocuments(record.kcsc?.document_rows_deferred || []),
    provenance: () => renderProvenance(record.kcsc?.raw_tab_summaries || [], record),
    raw: () => renderRaw(record),
  };
  return (renderers[state.selectedTab] || renderers.summary)(record);
}

function valueOrEmpty(value) {
  const raw = text(value);
  return raw ? escapeHtml(raw) : '<span class="cs-badge cs-na">none</span>';
}

function renderLedger(items) {
  return `<div class="cs-dossier-ledger">${items.map((item) => (
    `<span>${escapeHtml(item.label)}<b>${valueOrEmpty(item.value)}</b></span>`
  )).join('')}</div>`;
}

function renderKv(items) {
  return `<dl class="cs-kv-grid">${items.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${valueOrEmpty(value)}</dd>`).join('')}</dl>`;
}

function renderSection(title, rows) {
  return `<section class="cs-section">
    <h3>${escapeHtml(title)}</h3>
    ${rows.map((row) => `<div class="cs-row"><div class="cs-field">${row}</div></div>`).join('')}
  </section>`;
}

function renderSummary(record) {
  const kcsc = record.kcsc || {};
  const next = record.calendar?.[0] || null;
  const ledger = renderLedger([
    { label: 'Type', value: record.case_type },
    { label: 'Location', value: caseLocation(record) },
    { label: 'Status', value: record.status },
    { label: 'Filed', value: displayDate(record.filed_date || record.filing_date) },
    { label: 'Docket', value: `${record.docket_entries?.length || 0} rows` },
    { label: 'Parties', value: `${record.parties?.length || 0} parties` },
    { label: 'Counsel', value: `${record.attorneys?.length || 0} attorneys` },
  ]);

  const summaryRows = [
    `<span class="cs-field-lead">Cause:</span> ${valueOrEmpty(record.cause_of_action)}`,
    `<span class="cs-field-lead">Next hearing:</span> ${next ? escapeHtml(`${compactDateTime(next.court_date, next.hearing_time)} ${text(next.hearing_type)}`) : '<span class="cs-badge cs-na">none indexed</span>'}`,
  ];

  const portalRows = renderKv([
    ['Portal case ID', kcsc.portal_case_id],
    ['Portal node', kcsc.portal_node_id],
    ['Portal case type', kcsc.case_type_text || kcsc.case_type_key],
    ['Captured', record.captured_at],
    ['Updated', record.updated_at],
  ]);

  return `<div class="cs-overview-grid">
    <div class="cs-pane">
      <section class="cs-section">
        <h3>Case Dossier</h3>
        <div class="cs-dossier">
          ${ledger}
          <div>${escapeHtml(record.case_title || '(untitled)')}</div>
        </div>
      </section>
      ${renderSection('Case overview', summaryRows)}
    </div>
    <div class="cs-pane">
      <section class="cs-section">
        <h3>Portal and provenance</h3>
        ${portalRows}
      </section>
      ${renderSourceRows(kcsc.raw_tab_summaries || [], 'No raw tab summaries.', { compact: true })}
    </div>
  </div>`;
}

function renderDocket(rows) {
  if (!rows.length) return '<div class="cs-empty">No docket rows.</div>';
  return `<section class="cs-section">
    <h3>Register of Actions</h3>
    <div class="cs-record-table-wrap">
      <table class="cs-record-table">
        <thead><tr><th>Date</th><th>Seq</th><th>Description</th><th>Document</th><th>Source</th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td class="cs-mono">${escapeHtml(displayDate(row.date_filed))}</td>
          <td class="cs-mono">${escapeHtml(row.entry_seq || '')}</td>
          <td>${escapeHtml(row.description || '(no description)')}${row.fee ? ` <span class="cs-badge">${escapeHtml(row.fee)}</span>` : ''}</td>
          <td class="cs-mono">${row.has_document ? '<span class="cs-badge cs-warn">portal document</span>' : '<span class="cs-badge cs-na">none</span>'}</td>
          <td class="cs-mono">${escapeHtml(row.source || '')}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

function renderHearings(rows) {
  if (!rows.length) return '<div class="cs-empty">No hearing rows.</div>';
  return `<section class="cs-section">
    <h3>Hearings</h3>
    <div class="cs-record-table-wrap">
      <table class="cs-record-table">
        <thead><tr><th>Date</th><th>Type</th><th>Matters</th><th>Department</th><th>Location</th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td class="cs-mono">${escapeHtml(compactDateTime(row.court_date, row.hearing_time))}</td>
          <td>${escapeHtml(row.hearing_type || '(hearing)')}</td>
          <td>${escapeHtml(row.matters || row.judge || '')}</td>
          <td class="cs-mono">${escapeHtml(row.department || row.judge || '')}</td>
          <td class="cs-mono">${escapeHtml(row.location || '')}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

function arrayText(value, key = '') {
  const parsed = safeJson(value);
  if (Array.isArray(parsed)) {
    return parsed.map((item) => {
      if (typeof item === 'string') return item;
      return key ? item?.[key] : Object.values(item || {}).map(text).filter(Boolean).join(' ');
    }).map(text).filter(Boolean).join('; ');
  }
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : (key ? item?.[key] : Object.values(item || {}).join(' ')))).map(text).filter(Boolean).join('; ');
  }
  return text(value);
}

function renderParties(rows) {
  if (!rows.length) return '<div class="cs-empty">No party rows.</div>';
  return `<section class="cs-section">
    <h3>Parties</h3>
    <div class="cs-record-table-wrap">
      <table class="cs-record-table">
        <thead><tr><th>Type</th><th>Name</th><th>Represented by</th><th>Source</th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td class="cs-mono">${escapeHtml(row.party_type || '')}</td>
          <td>${escapeHtml(row.name || '(unnamed party)')}</td>
          <td>${escapeHtml(arrayText(row.attorneys))}</td>
          <td class="cs-mono">${escapeHtml(row.source || '')}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

function renderCounsel(rows) {
  if (!rows.length) return '<div class="cs-empty">No counsel rows.</div>';
  return `<section class="cs-section">
    <h3>Counsel</h3>
    <div class="cs-record-table-wrap">
      <table class="cs-record-table">
        <thead><tr><th>Name</th><th>Bar</th><th>Represents</th><th>Source</th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td>${escapeHtml(row.name || '(unnamed counsel)')}</td>
          <td class="cs-mono">${escapeHtml(row.bar_number || '')}</td>
          <td>${escapeHtml(arrayText(row.parties_represented, 'name'))}</td>
          <td class="cs-mono">${escapeHtml(row.source || '')}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

function sourceRowTitle(row) {
  return text(row.chargeInformation
    || row.documentName
    || row.description
    || row.status
    || row.name
    || row.label
    || row.section
    || row.type
    || row.rawLine
    || 'Source row');
}

function sourceRowSub(row) {
  return text(row.additionalInformation
    || row.chargeDescription
    || row.rawLine
    || row.url
    || row.pageTextSha256
    || '');
}

function renderSourceRows(rows, emptyText, options = {}) {
  if (!rows.length) return `<div class="cs-empty">${escapeHtml(emptyText)}</div>`;
  const title = options.compact ? 'Raw tab summaries' : 'Source rows';
  return `<section class="cs-section">
    <h3>${escapeHtml(title)}</h3>
    <div class="cs-line-list">${rows.map((row, index) => {
      const href = safeHttpHref(row.url);
      return `<div class="cs-row">
      <small>${escapeHtml([row.section, row.tabKey, row.rowIndex ? `row ${row.rowIndex}` : `row ${index + 1}`].filter(Boolean).join(' | '))}</small>
      <div class="cs-field"><span class="cs-field-lead">${escapeHtml(sourceRowTitle(row))}</span></div>
      ${sourceRowSub(row) ? `<div class="cs-field">${escapeHtml(sourceRowSub(row))}</div>` : ''}
      ${href ? `<div class="cs-field"><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a></div>` : ''}
    </div>`;
    }).join('')}</div>
  </section>`;
}

function rawLineColumns(row) {
  const headers = Array.isArray(row.rawHeaders) ? row.rawHeaders.map(text) : [];
  const rawLine = row.rawLine == null ? '' : String(row.rawLine);
  if (!headers.length || !rawLine) return null;
  const cells = rawLine.split('\t').map(text);
  while (cells.length && !cells[0]) cells.shift();
  while (cells.length > headers.length && !cells[cells.length - 1]) cells.pop();
  if (cells.length < 3) return null;
  const out = {};
  headers.forEach((header, index) => {
    const key = header.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const value = cells[index] || '';
    if (key === 'subnumber') out.subNumber = value;
    else if (key === 'datefiled') out.dateFiled = value;
    else if (key === 'documentname') out.documentName = value;
    else if (key === 'additionalinformation') out.additionalInformation = value;
    else if (key === 'filedby') out.filedBy = value;
    else if (key === 'page' || key === 'pagenumber') out.pageCount = value;
    else if (key === 'seal') out.seal = value;
  });
  return out;
}

function looksPageCount(value) {
  return /^\d{1,4}$/.test(text(value));
}

function looksFilingParty(value) {
  return /^(?:petitioner|respondent|plaintiff|defendant|state|clerk|prosecutor|guardian|minor|appellant|appellee|executor|administrator|personal representative)\b/i.test(text(value));
}

function documentDisplayRow(row) {
  const parsed = rawLineColumns(row);
  let additional = parsed ? text(parsed.additionalInformation) : text(row.additionalInformation);
  let filedBy = parsed ? text(parsed.filedBy) : text(row.filedBy);
  let pageCount = parsed ? text(parsed.pageCount) : text(row.pageCount || row.pageNumber || row.pages);

  if (!parsed && looksPageCount(filedBy)) {
    if (!pageCount) pageCount = filedBy;
    filedBy = '';
    if (looksFilingParty(additional)) {
      filedBy = additional;
      additional = '';
    }
  }
  if (!parsed && !pageCount && looksPageCount(additional)) {
    pageCount = additional;
    additional = '';
  }

  return {
    subNumber: text(parsed?.subNumber || row.subNumber),
    dateFiled: text(parsed?.dateFiled || row.dateFiled),
    documentName: text(parsed?.documentName || row.documentName || '(document row)'),
    additionalInformation: additional,
    filedBy,
    pageCount,
    seal: text(parsed?.seal || row.seal),
  };
}

function renderDocuments(rows) {
  if (!rows.length) return '<div class="cs-empty">No document index rows.</div>';
  return `<section class="cs-section">
    <h3>Document index</h3>
    <div class="cs-record-table-wrap">
      <table class="cs-record-table cs-document-table">
        <thead><tr><th>Sub</th><th>Date</th><th>Document</th><th>Additional</th><th>Filed by</th><th>Pages</th></tr></thead>
        <tbody>${rows.map((row) => {
          const doc = documentDisplayRow(row);
          return `<tr>
          <td class="cs-mono">${escapeHtml(doc.subNumber)}</td>
          <td class="cs-mono">${escapeHtml(displayDate(doc.dateFiled))}</td>
          <td>${escapeHtml(doc.documentName)}</td>
          <td>${escapeHtml(doc.additionalInformation)}</td>
          <td>${escapeHtml(doc.filedBy)}</td>
          <td class="cs-mono">${escapeHtml(doc.pageCount)}</td>
        </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

function documentIndexRows(record = {}) {
  return record.kcsc?.document_rows_deferred || [];
}

function documentByteStatus(record = {}, rows = []) {
  const rawStatus = text(record.document_unavailable_reason || record.kcsc?.document_byte_capture);
  if (!rows.length && !record.documents_deferred && !rawStatus) return '';
  if (!rawStatus || /deferred/i.test(rawStatus)) return 'not captured; index rows only';
  return rawStatus;
}

function renderProvenance(rows, record = {}) {
  const documentRows = documentIndexRows(record);
  const documentCapture = documentByteStatus(record, documentRows);
  const sourceHref = safeHttpHref(record.source_url);
  const overview = renderKv([
    ['Canonical', 'KCSC normalized JSON'],
    ['Data source', provenanceDataSource()],
    ['Generated', state.manifest?.generated_at],
    ['Source', record.source],
    ['Source URL', sourceHref],
    ['Captured', record.captured_at],
    ['Updated', record.updated_at],
    ['Document byte capture', documentCapture],
    ['Document index rows', documentRows.length ? `${documentRows.length} rows` : ''],
  ]);
  const tabRows = rows.length ? `<section class="cs-section">
    <h3>KCSC tab captures</h3>
    <div class="cs-record-table-wrap">
      <table class="cs-record-table">
        <thead><tr><th>Label</th><th>Tab</th><th>Tables</th><th>Text</th><th>SHA-256</th><th>URL</th></tr></thead>
        <tbody>${rows.map((row) => {
          const href = safeHttpHref(row.url);
          return `<tr>
          <td>${escapeHtml(row.label || row.section || '')}</td>
          <td class="cs-mono">${escapeHtml(row.tabKey || '')}</td>
          <td class="cs-mono">${escapeHtml(row.tableCount ?? '')}</td>
          <td class="cs-mono">${escapeHtml(row.pageTextLength ?? '')}</td>
          <td class="cs-mono">${escapeHtml(row.pageTextSha256 || '')}</td>
          <td>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}</td>
        </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
  </section>` : '<div class="cs-empty">No provenance rows.</div>';
  return `<div class="cs-overview-grid">
    <div class="cs-pane">
      <section class="cs-section">
        <h3>Provenance</h3>
        ${overview}
      </section>
    </div>
    <div class="cs-pane">${tabRows}</div>
  </div>`;
}

function renderRaw(record) {
  return `<pre class="cs-raw">${escapeHtml(JSON.stringify(record, null, 2))}</pre>`;
}

loadData().catch((err) => {
  console.error(err);
  setStatus('error', 'data load failed');
  showBodyError(err.message || String(err), 'reload');
});
