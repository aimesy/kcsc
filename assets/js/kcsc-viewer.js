const DUCKDB_ESM_URL = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev45.0/+esm';
const REMOTE_DATA_BASE = 'https://raw.githubusercontent.com/aimesy/kcsc-data/master/';
const MAX_RESULTS = 250;

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US');

const state = {
  manifest: null,
  dataBase: '',
  duckdb: null,
  db: null,
  conn: null,
  cases: [],
  nextHearings: new Map(),
  selectedCaseNumber: '',
  selectedCase: null,
  selectedTab: 'summary',
  detailCache: new Map(),
};

function text(value) {
  return value == null ? '' : String(value).trim();
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

function caseLocation(row) {
  const num = text(row.case_number || row.display_case_number);
  const match = num.match(/(SEA|KNT)$/i);
  return match ? match[1].toUpperCase() : '';
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

function setStatus(label, detail = '') {
  $('load-state').textContent = label;
  if (detail) $('data-source').textContent = detail;
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
  const candidates = [
    requested,
    './',
    REMOTE_DATA_BASE,
  ].filter(Boolean);

  const errors = [];
  for (const base of candidates) {
    try {
      const got = await fetchJsonFrom(base, 'data/manifest.json');
      state.dataBase = normalizeBase(base);
      state.manifest = got.json;
      $('data-source').textContent = state.dataBase === REMOTE_DATA_BASE ? 'aimesy/kcsc-data@master' : state.dataBase;
      $('generated-at').textContent = state.manifest.generated_at ? `Generated ${state.manifest.generated_at}` : '';
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

async function loadData() {
  setStatus('Loading', 'Reading manifest');
  await resolveDataBase();
  setStatus('Loading');
  await ensureDuckDB();
  setStatus('Loading');
  const tables = state.manifest.tables || {};
  await registerParquet('cases', tables.cases?.path || 'data/cases.parquet');
  await registerParquet('calendar', tables.calendar?.path || 'data/calendar.parquet');
  const caseRows = rowsFromArrow(await state.conn.query('SELECT * FROM cases ORDER BY filed_date DESC NULLS LAST, case_number'));
  const hearingRows = rowsFromArrow(await state.conn.query(`
    SELECT case_number, court_date, hearing_time, hearing_type, matters, judge, location
    FROM calendar
    WHERE court_date IS NOT NULL AND court_date <> ''
    ORDER BY court_date ASC, hearing_time ASC NULLS LAST
  `));

  state.nextHearings.clear();
  for (const row of hearingRows) {
    const key = text(row.case_number);
    if (!key || state.nextHearings.has(key)) continue;
    state.nextHearings.set(key, row);
  }
  state.cases = caseRows.map((row) => ({
    ...row,
    location_code: caseLocation(row),
    next_hearing: state.nextHearings.get(text(row.case_number)) || null,
  }));
  renderMetrics();
  populateFilters();
  bindEvents();
  renderResults();
  setStatus('Loaded');
}

function tableRowsCount(name) {
  return nf.format(num(state.manifest?.tables?.[name]?.rows));
}

function renderMetrics() {
  $('metric-cases').textContent = tableRowsCount('cases');
  $('metric-docket').textContent = tableRowsCount('docket_entries');
  $('metric-parties').textContent = tableRowsCount('parties');
  $('metric-attorneys').textContent = tableRowsCount('attorneys');
  $('metric-hearings').textContent = tableRowsCount('calendar');
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
}

function bindEvents() {
  ['q', 'type-filter', 'location-filter', 'status-filter', 'from-date', 'to-date', 'sort-filter']
    .forEach((id) => $(id).addEventListener(id === 'q' ? 'input' : 'change', renderResults));
  $('reset-btn').addEventListener('click', () => {
    ['q', 'type-filter', 'location-filter', 'status-filter', 'from-date', 'to-date'].forEach((id) => { $(id).value = ''; });
    $('sort-filter').value = 'filed_desc';
    renderResults();
  });
}

function searchableText(row) {
  return [
    row.case_number,
    row.display_case_number,
    row.case_title,
    row.case_type,
    row.status,
    row.cause_of_action,
    row.location_code,
    row.raw,
  ].map(text).join(' ').toLowerCase();
}

function filteredCases() {
  const q = text($('q').value).toLowerCase();
  const type = text($('type-filter').value);
  const loc = text($('location-filter').value);
  const status = text($('status-filter').value);
  const from = text($('from-date').value);
  const to = text($('to-date').value);
  const sort = text($('sort-filter').value);

  let rows = state.cases.filter((row) => {
    const filed = text(row.filed_date || row.filing_date);
    if (q && !searchableText(row).includes(q)) return false;
    if (type && text(row.case_type) !== type) return false;
    if (loc && text(row.location_code) !== loc) return false;
    if (status && text(row.status) !== status) return false;
    if (from && filed && filed < from) return false;
    if (to && filed && filed > to) return false;
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

function renderActiveChips(rows) {
  const chips = [];
  const type = text($('type-filter').value);
  const loc = text($('location-filter').value);
  const status = text($('status-filter').value);
  if (type) chips.push(type);
  if (loc) chips.push(loc);
  if (status) chips.push(status);
  if ($('from-date').value || $('to-date').value) chips.push(`${$('from-date').value || 'start'} to ${$('to-date').value || 'end'}`);
  $('active-chips').innerHTML = chips.map((chip) => `<span class="pill green">${escapeHtml(chip)}</span>`).join('');
  $('result-count').textContent = `${nf.format(rows.length)} case${rows.length === 1 ? '' : 's'}`;
}

function rowPills(row) {
  const pills = [];
  if (num(row.docket_entry_count)) pills.push(`<span class="pill">${nf.format(num(row.docket_entry_count))} docket</span>`);
  if (num(row.party_count)) pills.push(`<span class="pill">${nf.format(num(row.party_count))} parties</span>`);
  if (num(row.attorney_count)) pills.push(`<span class="pill">${nf.format(num(row.attorney_count))} counsel</span>`);
  if (num(row.calendar_count)) pills.push(`<span class="pill green">${nf.format(num(row.calendar_count))} hearings</span>`);
  if (!num(row.document_count)) pills.push('<span class="pill warn">docs deferred</span>');
  return pills.join('');
}

function renderResults() {
  const rows = filteredCases();
  renderActiveChips(rows);
  const shown = rows.slice(0, MAX_RESULTS);
  const body = $('case-results');
  if (!shown.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">No matching cases.</td></tr>';
    return;
  }
  body.innerHTML = shown.map((row) => {
    const hearing = row.next_hearing;
    const selected = text(row.case_number) === state.selectedCaseNumber ? ' class="selected"' : '';
    return `<tr data-case="${escapeHtml(row.case_number)}"${selected}>
      <td><span class="case-no">${escapeHtml(row.display_case_number || row.case_number)}</span></td>
      <td class="title-cell">
        <div>${escapeHtml(row.case_title || '(untitled)')}</div>
        <div class="muted">${escapeHtml(row.cause_of_action || '')}</div>
      </td>
      <td>${escapeHtml(displayDate(row.filed_date || row.filing_date))}</td>
      <td>${escapeHtml(row.case_type || '')}</td>
      <td>${escapeHtml(row.location_code || '')}</td>
      <td><div class="pill-row">${rowPills(row)}</div></td>
      <td>${hearing ? escapeHtml(compactDateTime(hearing.court_date, hearing.hearing_time)) : '<span class="muted">none</span>'}</td>
    </tr>`;
  }).join('');
  body.querySelectorAll('tr[data-case]').forEach((tr) => {
    tr.addEventListener('click', () => openCase(tr.dataset.case));
  });
}

async function loadCase(caseNumber) {
  if (state.detailCache.has(caseNumber)) return state.detailCache.get(caseNumber);
  const path = `archive/cases/${encodeURIComponent(caseNumber)}.json`;
  const res = await fetch(dataUrl(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${path}`);
  const record = await res.json();
  state.detailCache.set(caseNumber, record);
  return record;
}

async function openCase(caseNumber) {
  state.selectedCaseNumber = caseNumber;
  state.selectedTab = 'summary';
  renderResults();
  $('detail-case-number').textContent = caseNumber;
  $('case-detail').innerHTML = '<div class="loading">Loading case.</div>';
  $('detail-source').hidden = true;
  try {
    state.selectedCase = await loadCase(caseNumber);
    renderDetail();
  } catch (err) {
    $('case-detail').innerHTML = `<div class="error">${escapeHtml(err.message || String(err))}</div>`;
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
  tabs.push(['raw', 'Raw']);
  return tabs;
}

function renderDetail() {
  const record = state.selectedCase;
  if (!record) return;
  const source = $('detail-source');
  source.hidden = !record.source_url;
  if (record.source_url) source.href = record.source_url;
  $('detail-case-number').textContent = record.display_case_number || record.case_number;
  const tabs = tabsForCase(record);
  $('detail-tabs').hidden = false;
  $('detail-tabs').innerHTML = tabs.map(([key, label]) => (
    `<button type="button" class="tab${state.selectedTab === key ? ' active' : ''}" data-tab="${escapeHtml(key)}">${escapeHtml(label)}</button>`
  )).join('');
  $('detail-tabs').querySelectorAll('button[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedTab = button.dataset.tab;
      renderDetail();
    });
  });
  const renderers = {
    summary: renderSummary,
    docket: () => renderDocket(record.docket_entries || []),
    hearings: () => renderHearings(record.calendar || []),
    parties: () => renderParties(record.parties || []),
    counsel: () => renderCounsel(record.attorneys || []),
    charges: () => renderRawRows(record.kcsc?.charge_rows || [], 'No charge rows.'),
    judgments: () => renderRawRows(record.kcsc?.judgment_rows || [], 'No judgment rows.'),
    documents: () => renderRawRows(record.kcsc?.document_rows_deferred || [], 'No deferred document rows.'),
    raw: () => renderRaw(record),
  };
  $('case-detail').innerHTML = (renderers[state.selectedTab] || renderers.summary)(record);
}

function renderSummary(record) {
  const kcsc = record.kcsc || {};
  return `<div>
    <h3 class="detail-title">${escapeHtml(record.case_title || '(untitled)')}</h3>
    <p class="detail-sub">${escapeHtml(record.case_number || '')}</p>
  </div>
  <dl class="kv">
    <dt>Display</dt><dd>${escapeHtml(record.display_case_number || '')}</dd>
    <dt>Type</dt><dd>${escapeHtml(record.case_type || '')}</dd>
    <dt>Status</dt><dd>${escapeHtml(record.status || '')}</dd>
    <dt>Filed</dt><dd>${escapeHtml(displayDate(record.filed_date || record.filing_date))}</dd>
    <dt>Location</dt><dd>${escapeHtml(caseLocation(record) || '')}</dd>
    <dt>Cause</dt><dd>${escapeHtml(record.cause_of_action || '')}</dd>
    <dt>Portal ID</dt><dd>${escapeHtml(kcsc.portal_case_id || '')}</dd>
    <dt>Portal node</dt><dd>${escapeHtml(kcsc.portal_node_id || '')}</dd>
    <dt>Captured</dt><dd>${escapeHtml(record.captured_at || '')}</dd>
    <dt>Documents</dt><dd>${record.documents_deferred ? '<span class="pill warn">list rows deferred</span>' : escapeHtml(String(record.document_count || 0))}</dd>
  </dl>`;
}

function renderDocket(rows) {
  if (!rows.length) return '<div class="empty">No docket rows.</div>';
  return `<div class="list">${rows.map((row) => `<div class="row-card">
    <small>${escapeHtml(displayDate(row.date_filed))} · ${escapeHtml(row.entry_seq || '')}</small>
    <b>${escapeHtml(row.description || '(no description)')}</b>
    ${row.has_document ? '<span class="pill warn">document link present in portal</span>' : ''}
  </div>`).join('')}</div>`;
}

function renderHearings(rows) {
  if (!rows.length) return '<div class="empty">No hearing rows.</div>';
  return `<div class="list">${rows.map((row) => `<div class="row-card">
    <small>${escapeHtml(compactDateTime(row.court_date, row.hearing_time))}</small>
    <b>${escapeHtml(row.hearing_type || '(hearing)')}</b>
    <div>${escapeHtml(row.matters || row.judge || '')}</div>
    <div class="muted">${escapeHtml([row.department, row.location].filter(Boolean).join(' · '))}</div>
  </div>`).join('')}</div>`;
}

function renderParties(rows) {
  if (!rows.length) return '<div class="empty">No party rows.</div>';
  return `<div class="list">${rows.map((row) => `<div class="row-card">
    <small>${escapeHtml(row.party_type || '')}</small>
    <b>${escapeHtml(row.name || '(unnamed party)')}</b>
    ${(row.attorneys || []).length ? `<div class="muted">${escapeHtml((row.attorneys || []).join('; '))}</div>` : ''}
  </div>`).join('')}</div>`;
}

function renderCounsel(rows) {
  if (!rows.length) return '<div class="empty">No counsel rows.</div>';
  return `<div class="list">${rows.map((row) => `<div class="row-card">
    <small>${escapeHtml(row.attorney_id || '')}</small>
    <b>${escapeHtml(row.name || '(unnamed counsel)')}</b>
    ${(row.parties_represented || []).length ? `<div class="muted">${escapeHtml((row.parties_represented || []).map((p) => p.name).join('; '))}</div>` : ''}
  </div>`).join('')}</div>`;
}

function renderRawRows(rows, emptyText) {
  if (!rows.length) return `<div class="empty">${escapeHtml(emptyText)}</div>`;
  return `<div class="list">${rows.map((row, index) => `<div class="row-card">
    <small>Row ${index + 1}</small>
    <b>${escapeHtml(row.type || row.description || row.status || row.name || row.rawLine || 'Source row')}</b>
    <div class="muted">${escapeHtml(row.rawLine || row.additionalInfo || row.chargeDescription || '')}</div>
  </div>`).join('')}</div>`;
}

function renderRaw(record) {
  return `<pre class="row-card" style="overflow:auto; max-height: 520px; white-space: pre-wrap;">${escapeHtml(JSON.stringify(record.kcsc || record.raw || {}, null, 2))}</pre>`;
}

loadData().catch((err) => {
  console.error(err);
  setStatus('Error', 'Data load failed');
  $('case-results').innerHTML = `<tr><td colspan="7" class="error">${escapeHtml(err.message || String(err))}</td></tr>`;
  $('case-detail').innerHTML = `<div class="error">${escapeHtml(err.message || String(err))}</div>`;
});
