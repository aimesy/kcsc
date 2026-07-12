const DUCKDB_ESM_URL = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev45.0/+esm';
const REMOTE_DATA_BASE = 'https://raw.githubusercontent.com/aimesy/kcsc-data/master/';

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US');

const state = {
  manifest: null,
  dataBase: '',
  duckdb: null,
  db: null,
  conn: null,
  bound: false,
  cases: [],
  docketRows: [],
  partyRows: [],
  attorneyRows: [],
  calendarRows: [],
  nextHearings: new Map(),
  docketIndex: new Map(),
  partyIndex: new Map(),
  counselIndex: new Map(),
  selectedCaseNumber: '',
  selectedCase: null,
  selectedTab: 'summary',
  detailCache: new Map(),
  scope: 'cases',
};

function text(value) {
  return value == null ? '' : String(value).replace(/\u00a0/g, ' ').trim();
}

function norm(value) {
  return text(value).toLowerCase();
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

function tableRowsCountText(name) {
  return nf.format(tableRowsCount(name));
}

function caseLocation(row) {
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
  return text(rowKcsc(row).portal_node_id || safeJson(row.raw)?.raw?.case?.portalNodeId);
}

function casePortalId(row) {
  return text(rowKcsc(row).portal_case_id || safeJson(row.raw)?.raw?.case?.portalCaseId);
}

function caseHasDeferredDocuments(row) {
  const kcsc = rowKcsc(row);
  return Array.isArray(kcsc.document_rows_deferred) && kcsc.document_rows_deferred.length > 0;
}

function setStatus(label, detail = '') {
  $('cs-sync').textContent = label;
  if (detail) $('cs-entity-meta').textContent = detail;
}

async function fetchJsonFrom(base, path) {
  const url = new URL(path, new URL(base, location.href)).href;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { json: await res.json(), url };
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
      const sourceLabel = state.dataBase === REMOTE_DATA_BASE ? 'aimesy/kcsc-data@master' : state.dataBase;
      const generated = state.manifest.generated_at ? `generated ${state.manifest.generated_at}` : 'manifest loaded';
      $('cs-entity-meta').textContent = `${sourceLabel} | ${generated}`;
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

async function fetchBuffer(path) {
  const res = await fetch(dataUrl(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${path}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function registerParquet(tableName, path) {
  const fname = `${tableName}.parquet`;
  const buf = await fetchBuffer(path);
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
    has_deferred_documents: caseHasDeferredDocuments(row),
    next_hearing: state.nextHearings.get(text(row.case_number)) || null,
  }));
}

async function loadData() {
  setStatus('loading data', 'reading manifest');
  await resolveDataBase();
  setStatus('loading tables');
  await ensureDuckDB();

  const tables = state.manifest.tables || {};
  const specs = [
    ['cases', tables.cases?.path || 'data/cases.parquet'],
    ['calendar', tables.calendar?.path || 'data/calendar.parquet'],
    ['docket_entries', tables.docket_entries?.path || 'data/docket_entries.parquet'],
    ['parties', tables.parties?.path || 'data/parties.parquet'],
    ['attorneys', tables.attorneys?.path || 'data/attorneys.parquet'],
  ];

  for (const [tableName, path] of specs) {
    setStatus(`loading ${tableName}`);
    await registerParquet(tableName, path);
  }

  setStatus('indexing rows');
  const caseRows = await loadTableRows('cases', 'SELECT * FROM cases ORDER BY filed_date DESC NULLS LAST, case_number');
  state.calendarRows = await loadTableRows('calendar', `
    SELECT * FROM calendar
    WHERE court_date IS NOT NULL AND court_date <> ''
    ORDER BY court_date ASC, hearing_time ASC NULLS LAST
  `);
  state.docketRows = await loadTableRows('docket_entries', 'SELECT * FROM docket_entries ORDER BY case_number, date_filed, entry_seq');
  state.partyRows = await loadTableRows('parties', 'SELECT * FROM parties ORDER BY case_number, party_seq');
  state.attorneyRows = await loadTableRows('attorneys', 'SELECT * FROM attorneys ORDER BY case_number, name');

  buildSearchIndexes();
  state.cases = enrichCases(caseRows);
  populateFilters();
  bindEvents();

  const initialCase = requestedCaseFromLocation();
  if (initialCase) {
    await openCase(initialCase, { push: false });
  } else {
    renderResults();
  }
  setStatus('loaded', sourceSummary());
}

function sourceSummary() {
  const sourceLabel = state.dataBase === REMOTE_DATA_BASE ? 'aimesy/kcsc-data@master' : state.dataBase;
  const generated = state.manifest?.generated_at ? `generated ${state.manifest.generated_at}` : 'manifest loaded';
  return `${sourceLabel} | ${generated}`;
}

function optionList(values, allLabel) {
  const opts = [`<option value="">${escapeHtml(allLabel)}</option>`];
  [...new Set(values.map(text).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .forEach((v) => opts.push(`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`));
  return opts.join('');
}

function populateFilters() {
  $('type-filter').innerHTML = optionList(state.cases.map((r) => r.case_type), 'All types');
  $('location-filter').innerHTML = optionList(state.cases.map((r) => r.location_code), 'All locations');
  $('status-filter').innerHTML = optionList(state.cases.map((r) => r.status), 'All statuses');
  $('node-filter').innerHTML = optionList(state.cases.map((r) => r.portal_node_id), 'All nodes');
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
    clearCaseHash();
    renderResults();
  });

  $('cs-search').addEventListener('input', renderResults);
  ['type-filter', 'location-filter', 'status-filter', 'from-date', 'to-date', 'sort-filter', 'node-filter', 'content-filter']
    .forEach((id) => $(id).addEventListener('change', renderResults));

  $('cs-scope-btn').addEventListener('click', () => {
    const menu = $('cs-scope-menu');
    menu.classList.toggle('open');
    $('cs-scope-btn').setAttribute('aria-expanded', menu.classList.contains('open') ? 'true' : 'false');
  });

  document.querySelectorAll('input[name="cs-scope"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      state.scope = radio.value;
      $('cs-scope-label').textContent = {
        cases: 'Cases',
        docket: 'Dockets',
        parties: 'Parties',
        counsel: 'Counsel',
      }[state.scope] || 'Cases';
      $('cs-scope-menu').classList.remove('open');
      $('cs-scope-btn').setAttribute('aria-expanded', 'false');
      renderResults();
    });
  });

  document.addEventListener('click', (event) => {
    const scopeWrap = event.target.closest('.cs-scope-wrap');
    if (!scopeWrap) {
      $('cs-scope-menu').classList.remove('open');
      $('cs-scope-btn').setAttribute('aria-expanded', 'false');
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
      renderDetail();
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

function pushCaseHash(caseNumber) {
  const url = new URL(location.href);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  hashParams.set('case', caseNumber);
  url.hash = hashParams.toString();
  history.pushState(null, '', url);
}

function clearCaseHash() {
  const url = new URL(location.href);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  hashParams.delete('case');
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
    row.cause_of_action,
    row.location_code,
    row.portal_node_id,
    row.portal_case_id,
  ].map(text).join(' ');
}

function scopedSearchText(row) {
  const key = text(row.case_number);
  if (state.scope === 'docket') return state.docketIndex.get(key) || '';
  if (state.scope === 'parties') return state.partyIndex.get(key) || '';
  if (state.scope === 'counsel') return state.counselIndex.get(key) || '';
  return caseSearchText(row);
}

function namespaceText(row, field) {
  const key = text(row.case_number);
  if (field === 'case') return [row.case_number, row.display_case_number].map(text).join(' ');
  if (field === 'title') return row.case_title;
  if (field === 'party') return state.partyIndex.get(key) || '';
  if (field === 'counsel') return state.counselIndex.get(key) || '';
  if (field === 'docket') return state.docketIndex.get(key) || '';
  if (field === 'cause') return row.cause_of_action;
  if (field === 'status') return row.status;
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

function filteredCases() {
  const parsed = parseQuery($('cs-search').value);
  const type = text($('type-filter').value);
  const loc = text($('location-filter').value);
  const status = text($('status-filter').value);
  const from = text($('from-date').value);
  const to = text($('to-date').value);
  const node = text($('node-filter').value);
  const content = text($('content-filter').value);
  const sort = text($('sort-filter').value);

  let rows = state.cases.filter((row) => {
    const filed = text(row.filed_date || row.filing_date);
    if (parsed.free && !norm(scopedSearchText(row)).includes(parsed.free)) return false;
    if (parsed.filters.some((filter) => !matchesNamespace(row, filter))) return false;
    if (type && text(row.case_type) !== type) return false;
    if (loc && text(row.location_code) !== loc) return false;
    if (status && text(row.status) !== status) return false;
    if (node && text(row.portal_node_id) !== node) return false;
    if (from && (!filed || filed < from)) return false;
    if (to && (!filed || filed > to)) return false;
    if (content === 'docket' && !num(row.docket_entry_count)) return false;
    if (content === 'hearing' && !num(row.calendar_count)) return false;
    if (content === 'party' && !num(row.party_count)) return false;
    if (content === 'counsel' && !num(row.attorney_count)) return false;
    if (content === 'document' && !row.has_deferred_documents) return false;
    return true;
  });

  rows = rows.slice().sort((a, b) => {
    if (sort === 'filed_asc') return text(a.filed_date).localeCompare(text(b.filed_date)) || text(a.case_number).localeCompare(text(b.case_number));
    if (sort === 'case_number') return text(a.case_number).localeCompare(text(b.case_number));
    if (sort === 'docket_count') return num(b.docket_entry_count) - num(a.docket_entry_count) || text(a.case_number).localeCompare(text(b.case_number));
    if (sort === 'hearing_date') return text(a.next_hearing?.court_date || '9999-99-99').localeCompare(text(b.next_hearing?.court_date || '9999-99-99'));
    return text(b.filed_date).localeCompare(text(a.filed_date)) || text(a.case_number).localeCompare(text(b.case_number));
  });
  return rows;
}

function activeChips() {
  const chips = [];
  const q = text($('cs-search').value);
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

function renderMetricsHtml() {
  return `<div class="cs-metrics" aria-label="Corpus totals">
    <div class="cs-metric"><b>${tableRowsCountText('cases')}</b><span>Cases</span></div>
    <div class="cs-metric"><b>${tableRowsCountText('docket_entries')}</b><span>Docket rows</span></div>
    <div class="cs-metric"><b>${tableRowsCountText('parties')}</b><span>Parties</span></div>
    <div class="cs-metric"><b>${tableRowsCountText('attorneys')}</b><span>Counsel</span></div>
    <div class="cs-metric"><b>${tableRowsCountText('calendar')}</b><span>Hearings</span></div>
    <div class="cs-metric"><b>${nf.format(state.cases.filter((row) => row.has_deferred_documents).length)}</b><span>Deferred docs</span></div>
  </div>`;
}

function renderResults() {
  if (!state.cases.length) return;
  state.selectedCase = null;
  $('cs-tabstrip').hidden = true;
  $('cs-kicker').textContent = 'Cases';
  $('cs-entity-title').textContent = 'King County Superior Court';
  $('cs-entity-meta').textContent = sourceSummary();

  const rows = filteredCases();
  const chips = activeChips();
  const chipHtml = chips.map((chip) => `<span class="cs-badge cs-src">${escapeHtml(chip)}</span>`).join('');
  const count = `<p class="cs-count"><strong>${nf.format(rows.length)} case${rows.length === 1 ? '' : 's'}</strong><span>${nf.format(state.cases.length)} loaded</span>${chipHtml}</p>`;
  const body = rows.length ? renderCaseGroups(rows) : '<div class="cs-empty">No matching cases.</div>';
  $('cs-body').innerHTML = `${count}${renderMetricsHtml()}${body}`;
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

function renderCaseGroups(rows) {
  const byType = grouped(rows, (row) => row.case_type || 'unknown');
  return sortedEntries(byType).map(([type, typeRows]) => {
    const byLocation = grouped(typeRows, (row) => row.location_code || 'No location');
    const locations = sortedEntries(byLocation).map(([location, locRows]) => {
      const byYear = grouped(locRows, (row) => yearFromDate(row.filed_date || row.filing_date));
      const years = sortedEntries(byYear, 'year_desc').map(([year, yearRows]) => (
        `<details class="cs-year-group" open>
          <summary class="cs-year-head"><span class="cs-year-tag">${escapeHtml(year)}</span><span class="cs-year-count">${nf.format(yearRows.length)} cases</span></summary>
          <ul class="cs-results">${yearRows.map(renderCaseRow).join('')}</ul>
        </details>`
      )).join('');
      return `<details class="cs-prefix-group" open>
        <summary class="cs-prefix-head"><span class="cs-prefix-code">${escapeHtml(location)}</span><span class="cs-prefix-count">${nf.format(locRows.length)} cases</span></summary>
        ${years}
      </details>`;
    }).join('');
    return `<details class="cs-type-group" open>
      <summary class="cs-type-head"><span class="cs-type-tag">${escapeHtml(type.toUpperCase())}</span><span class="cs-type-count">${nf.format(typeRows.length)} cases</span></summary>
      ${locations}
    </details>`;
  }).join('');
}

function rowStateClass(row) {
  if (num(row.docket_entry_count) && num(row.party_count) && row.has_deferred_documents) return 'cs-case-state-check';
  if (row.has_deferred_documents) return 'cs-case-state-partial';
  if (num(row.docket_entry_count) || num(row.calendar_count)) return 'cs-case-state-ring';
  return 'cs-case-state-dot';
}

function renderCaseRow(row) {
  const caseNumber = text(row.case_number);
  const displayNumber = text(row.display_case_number || row.case_number);
  const hearing = row.next_hearing;
  const snippetParts = [
    row.cause_of_action,
    row.status,
    num(row.docket_entry_count) ? `${nf.format(num(row.docket_entry_count))} docket` : '',
    num(row.party_count) ? `${nf.format(num(row.party_count))} parties` : '',
    row.has_deferred_documents ? 'document rows deferred' : '',
  ].map(text).filter(Boolean);
  const metaParts = [
    displayDate(row.filed_date || row.filing_date) ? `filed ${displayDate(row.filed_date || row.filing_date)}` : '',
    row.portal_node_id ? `node ${row.portal_node_id}` : '',
    hearing ? `next ${compactDateTime(hearing.court_date, hearing.hearing_time)}` : '',
  ].filter(Boolean);
  const selected = caseNumber === state.selectedCaseNumber ? ' is-selected' : '';
  return `<li class="${selected.trim()}">
    <a class="cs-case-row-link" href="#case=${encodeURIComponent(caseNumber)}" data-case-open="${escapeHtml(caseNumber)}">
      <span class="cs-case-state"><span class="${rowStateClass(row)}"></span></span>
      <span>
        <span class="cs-r-title">${escapeHtml(displayNumber)}</span>
        <span class="cs-r-title-name">${escapeHtml([row.case_type, row.location_code].filter(Boolean).join(' / '))}</span>
      </span>
      <span>
        <span class="cs-r-sub">${escapeHtml(row.case_title || '(untitled)')}</span>
        <span class="cs-r-snippet">${escapeHtml(snippetParts.join(' | '))}</span>
      </span>
      <span class="cs-r-meta">${escapeHtml(metaParts.join(' | '))}</span>
    </a>
  </li>`;
}

function findCase(caseNumber) {
  const wanted = norm(caseNumber);
  return state.cases.find((row) => norm(row.case_number) === wanted || norm(row.display_case_number) === wanted) || null;
}

async function loadCase(caseNumber) {
  const row = findCase(caseNumber);
  const canonical = text(row?.case_number || caseNumber);
  if (state.detailCache.has(canonical)) return state.detailCache.get(canonical);
  const path = `archive/cases/${encodeURIComponent(canonical)}.json`;
  const res = await fetch(dataUrl(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${path}`);
  const record = await res.json();
  state.detailCache.set(canonical, record);
  return record;
}

async function openCase(caseNumber, options = {}) {
  const { push = true } = options;
  const row = findCase(caseNumber);
  const canonical = text(row?.case_number || caseNumber);
  state.selectedCaseNumber = canonical;
  state.selectedTab = 'summary';
  $('cs-tabstrip').hidden = true;
  $('cs-kicker').textContent = 'Case';
  $('cs-entity-title').textContent = text(row?.display_case_number || canonical);
  $('cs-entity-meta').textContent = text(row?.case_title || 'loading case');
  $('cs-body').innerHTML = '<div class="cs-loading">Loading case profile.</div>';
  if (push) pushCaseHash(canonical);

  try {
    state.selectedCase = await loadCase(canonical);
    renderDetail();
  } catch (err) {
    $('cs-body').innerHTML = `<div class="cs-error">${escapeHtml(err.message || String(err))}</div>`;
    setStatus('case load error');
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

  const sourceLink = record.source_url
    ? `<a class="hbtn" href="${escapeHtml(record.source_url)}" target="_blank" rel="noopener noreferrer">Official docket &#8599;</a>`
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
        <span class="cs-badge cs-src">KCSC normalized JSON</span>
        ${record.documents_deferred ? '<span class="cs-badge cs-warn">document bytes deferred</span>' : ''}
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
    provenance: () => renderProvenance(record.kcsc?.raw_tab_summaries || []),
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
    { label: 'Documents', value: record.documents_deferred ? `${kcsc.document_rows_deferred?.length || 0} deferred` : `${record.documents?.length || 0}` },
  ]);

  const summaryRows = [
    `<span class="cs-field-lead">Cause:</span> ${valueOrEmpty(record.cause_of_action)}`,
    `<span class="cs-field-lead">Next hearing:</span> ${next ? escapeHtml(`${compactDateTime(next.court_date, next.hearing_time)} ${text(next.hearing_type)}`) : '<span class="cs-badge cs-na">none indexed</span>'}`,
    `<span class="cs-field-lead">Document capture:</span> ${escapeHtml(record.document_unavailable_reason || kcsc.document_byte_capture || 'not specified')}`,
  ];

  const portalRows = renderKv([
    ['Portal case ID', kcsc.portal_case_id],
    ['Portal node', kcsc.portal_node_id],
    ['Portal case type', kcsc.case_type_text || kcsc.case_type_key],
    ['Captured', record.captured_at],
    ['Updated', record.updated_at],
    ['Source', record.source],
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
      ${renderSection('KCSC posture', summaryRows)}
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
    <div class="cs-line-list">${rows.map((row, index) => `<div class="cs-row">
      <small>${escapeHtml([row.section, row.tabKey, row.rowIndex ? `row ${row.rowIndex}` : `row ${index + 1}`].filter(Boolean).join(' | '))}</small>
      <div class="cs-field"><span class="cs-field-lead">${escapeHtml(sourceRowTitle(row))}</span></div>
      ${sourceRowSub(row) ? `<div class="cs-field">${escapeHtml(sourceRowSub(row))}</div>` : ''}
      ${row.url ? `<div class="cs-field"><a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.url)}</a></div>` : ''}
    </div>`).join('')}</div>
  </section>`;
}

function renderDocuments(rows) {
  if (!rows.length) return '<div class="cs-empty">No deferred document rows.</div>';
  return `<section class="cs-section">
    <h3>Deferred document rows</h3>
    <div class="cs-record-table-wrap">
      <table class="cs-record-table">
        <thead><tr><th>Sub</th><th>Date</th><th>Document</th><th>Additional</th><th>Filed by</th><th>Pages</th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td class="cs-mono">${escapeHtml(row.subNumber || '')}</td>
          <td class="cs-mono">${escapeHtml(displayDate(row.dateFiled))}</td>
          <td>${escapeHtml(row.documentName || '(document row)')} <span class="cs-badge cs-warn">bytes deferred</span></td>
          <td>${escapeHtml(row.additionalInformation || '')}</td>
          <td class="cs-mono">${escapeHtml(row.filedBy || '')}</td>
          <td class="cs-mono">${escapeHtml(row.pageNumber || row.pages || '')}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

function renderProvenance(rows) {
  if (!rows.length) return '<div class="cs-empty">No provenance rows.</div>';
  return `<section class="cs-section">
    <h3>KCSC tab captures</h3>
    <div class="cs-record-table-wrap">
      <table class="cs-record-table">
        <thead><tr><th>Label</th><th>Tab</th><th>Tables</th><th>Text</th><th>SHA-256</th><th>URL</th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td>${escapeHtml(row.label || row.section || '')}</td>
          <td class="cs-mono">${escapeHtml(row.tabKey || '')}</td>
          <td class="cs-mono">${escapeHtml(row.tableCount ?? '')}</td>
          <td class="cs-mono">${escapeHtml(row.pageTextLength ?? '')}</td>
          <td class="cs-mono">${escapeHtml(row.pageTextSha256 || '')}</td>
          <td>${row.url ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

function renderRaw(record) {
  return `<pre class="cs-raw">${escapeHtml(JSON.stringify(record, null, 2))}</pre>`;
}

loadData().catch((err) => {
  console.error(err);
  setStatus('error', 'data load failed');
  $('cs-body').innerHTML = `<div class="cs-error">${escapeHtml(err.message || String(err))}</div>`;
});
