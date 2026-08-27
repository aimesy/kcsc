import {
  fetchJsonWithProgress,
  fetchTextWithProgress,
  responseContentLength,
} from './load-progress.js';
import {
  validateKcscAttorneyRankings,
  validateKcscJudgmentRankings,
  validateKcscStatistics,
} from './kcsc-statistics.js';

export const KCSC_DATA_CLIENT_FORMAT = 'kcsc-viewer-data-client-v1';
export const KCSC_DATA_MANIFEST_FORMAT = 'kcsc-data-manifest-v1';

const REQUIRED_TABLES = [
  'cases',
  'docket_entries',
  'parties',
  'attorneys',
  'representation',
  'calendar',
  'payments',
];

const LEGACY_INDEX_FIELDS = [
  'attorney_count',
  'calendar_count',
  'docket_entry_count',
  'party_count',
  'has_document_index_rows',
];

function clean(value) {
  return value == null ? '' : String(value).replace(/\u00a0/g, ' ').trim();
}

function strictCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value;
}

export function safeDataPath(value) {
  const path = clean(value).replace(/\\/g, '/');
  if (!path
    || path.startsWith('/')
    || path.includes('//')
    || path.includes(':')
    || path.includes('?')
    || path.includes('#')
    || /%(?:2e|2f|5c)/i.test(path)
    || path.split('/').some((part) => part === '..' || part === '.')) return '';
  return path;
}

export function normalizeDataBase(value, locationHref = 'https://example.invalid/') {
  const raw = clean(value);
  if (!raw) return '';
  const url = new URL(raw, locationHref);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error('KCSC data base must be an HTTP(S) directory URL without credentials, query, or fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

function validateTable(manifest, name) {
  const table = manifest.tables?.[name];
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error(`KCSC manifest table ${name} is missing`);
  }
  if (!safeDataPath(table.path)) throw new Error(`KCSC manifest table ${name} has an invalid path`);
  strictCount(table.rows, `tables.${name}.rows`);
  strictCount(table.size_bytes, `tables.${name}.size_bytes`);
}

function validateFeatureDescriptors(manifest) {
  if (manifest.features == null) return;
  if (typeof manifest.features !== 'object' || Array.isArray(manifest.features)) {
    throw new Error('KCSC manifest features must be an object');
  }
  for (const [name, feature] of Object.entries(manifest.features)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)
      || !feature
      || typeof feature !== 'object'
      || Array.isArray(feature)) throw new Error(`invalid KCSC feature descriptor: ${name}`);
    strictCount(feature.rows, `features.${name}.rows`);
    if (feature.case_index_field != null
      && !/^[a-z][a-z0-9_]*$/.test(clean(feature.case_index_field))) {
      throw new Error(`features.${name}.case_index_field is invalid`);
    }
    if (feature.detail_path != null
      && !/^[a-z][a-z0-9_.]*$/.test(clean(feature.detail_path))) {
      throw new Error(`features.${name}.detail_path is invalid`);
    }
  }
}

export function validateKcscManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('invalid KCSC data manifest');
  }
  if (manifest.format != null && manifest.format !== KCSC_DATA_MANIFEST_FORMAT) {
    throw new Error(`unsupported KCSC data manifest format: ${clean(manifest.format) || 'missing'}`);
  }
  if (clean(manifest.court_id).toLowerCase() !== 'kcsc') {
    throw new Error(`unexpected court_id: ${clean(manifest.court_id) || 'missing'}`);
  }
  if (!manifest.archive || typeof manifest.archive !== 'object' || Array.isArray(manifest.archive)) {
    throw new Error('KCSC manifest archive contract is missing');
  }
  const archiveCases = strictCount(manifest.archive.cases, 'archive.cases');
  if (!safeDataPath(manifest.archive.cases_dir)) throw new Error('archive.cases_dir is invalid');
  if (manifest.archive.case_directory != null && !safeDataPath(manifest.archive.case_directory)) {
    throw new Error('archive.case_directory is invalid');
  }
  if (manifest.archive.cases_index != null && !safeDataPath(manifest.archive.cases_index)) {
    throw new Error('archive.cases_index is invalid');
  }
  if (!manifest.archive.case_directory && !manifest.archive.cases_index) {
    throw new Error('KCSC manifest has no case directory or case index');
  }
  if (manifest.archive.case_index_fields != null) {
    if (!Array.isArray(manifest.archive.case_index_fields)
      || manifest.archive.case_index_fields.some((field) => !/^[a-z][a-z0-9_]*$/.test(clean(field)))) {
      throw new Error('archive.case_index_fields is invalid');
    }
  }
  for (const part of manifest.archive.cases_index_parts || []) {
    if (!part || typeof part !== 'object' || Array.isArray(part) || !safeDataPath(part.path)) {
      throw new Error('invalid KCSC case index part');
    }
    strictCount(part.rows, `${part.path}.rows`);
    strictCount(part.size_bytes, `${part.path}.size_bytes`);
  }
  for (const name of REQUIRED_TABLES) validateTable(manifest, name);
  if (manifest.tables.cases.rows !== archiveCases) {
    throw new Error(`cases table count ${manifest.tables.cases.rows} does not match archive count ${archiveCases}`);
  }
  if (!manifest.documents || typeof manifest.documents.byte_capture !== 'boolean') {
    throw new Error('KCSC document-byte capability is missing');
  }
  if (manifest.documents.table != null && !safeDataPath(manifest.documents.table)) {
    throw new Error('KCSC document table path is invalid');
  }
  validateFeatureDescriptors(manifest);
  if (manifest.statistics != null) {
    validateKcscStatistics(manifest.statistics, {
      expectedCases: archiveCases,
      features: manifest.features,
      generatedAt: manifest.generated_at,
    });
  }
  return manifest;
}

export function caseIndexFields(manifest) {
  const configured = manifest?.archive?.case_index_fields;
  return new Set(Array.isArray(configured) ? configured.map(clean) : LEGACY_INDEX_FIELDS);
}

export function featureAvailableInIndex(manifest, featureName) {
  const descriptor = manifest?.features?.[featureName];
  if (!descriptor || !strictCount(descriptor.rows, `features.${featureName}.rows`)) return false;
  return caseIndexFields(manifest).has(clean(descriptor.case_index_field));
}

export function representationRows(record = {}) {
  if (Array.isArray(record.representation)) return record.representation;
  const rows = [];
  for (const attorney of record.attorneys || []) {
    for (const party of attorney.parties_represented || []) {
      rows.push({
        attorney_id: attorney.attorney_id,
        attorney_name: attorney.name,
        case_number: record.case_number,
        party_id: party.party_id,
        party_name: party.name,
        party_seq: party.party_seq,
        source: attorney.source,
      });
    }
  }
  return rows;
}

export function canonicalFeatureCounts(record = {}) {
  const kcsc = record.kcsc || {};
  return {
    docket: (record.docket_entries || []).length,
    hearings: (record.calendar || []).length,
    parties: (record.parties || []).length,
    counsel: (record.attorneys || []).length,
    representation: representationRows(record).length,
    payments: (record.payments || []).length,
    charges: (kcsc.charge_rows || []).length,
    judgments: (kcsc.judgment_rows || []).length,
    documents: (kcsc.document_rows_deferred || []).length,
  };
}

export function describeKcscDataClient() {
  return {
    format: KCSC_DATA_CLIENT_FORMAT,
    manifestFormat: KCSC_DATA_MANIFEST_FORMAT,
    operations: [
      'manifest', 'statistics', 'attorney-rankings', 'judgment-rankings',
      'directory', 'index', 'parquet', 'case',
    ],
    detailFeatures: [
      'summary',
      'docket',
      'hearings',
      'parties',
      'counsel',
      'representation',
      'payments',
      'charges',
      'judgments',
      'documents',
      'provenance',
      'raw',
    ],
    documentByteCapture: false,
  };
}

export function createKcscDataClient(options = {}) {
  const locationHref = options.locationHref || globalThis.location?.href || 'https://example.invalid/';
  const base = new URL(normalizeDataBase(options.base || './', locationHref));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000;

  function url(path) {
    const safePath = safeDataPath(path);
    if (!safePath) throw new Error(`unsafe KCSC data path: ${clean(path) || '(missing)'}`);
    return new URL(safePath, base).href;
  }

  function requestUrl(input) {
    const target = new URL(typeof input === 'string' ? input : input.url, base);
    if (target.origin !== base.origin
      || !target.pathname.startsWith(base.pathname)
      || target.username
      || target.password
      || target.hash) throw new Error(`KCSC data request escaped configured base: ${target.href}`);
    return target.href;
  }

  async function fetchRequest(input, init = {}) {
    const { kcscTimeoutMs, ...fetchInit } = init;
    const controller = new AbortController();
    const upstreamSignal = fetchInit.signal;
    const abort = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) abort();
    else upstreamSignal?.addEventListener('abort', abort, { once: true });
    const requestTimeoutMs = Number.isFinite(kcscTimeoutMs) ? kcscTimeoutMs : timeoutMs;
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await fetchImpl(requestUrl(input), { ...fetchInit, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener('abort', abort);
    }
  }

  async function json(path, init = {}, progress = {}) {
    return fetchJsonWithProgress(url(path), init, {
      ...progress,
      fetchImpl: fetchRequest,
    });
  }

  async function text(path, init = {}, progress = {}) {
    return fetchTextWithProgress(url(path), init, {
      ...progress,
      fetchImpl: fetchRequest,
    });
  }

  async function buffer(path, options = {}) {
    const response = await fetchRequest(url(path), {
      ...(options.init || {}),
      kcscTimeoutMs: options.timeoutMs,
    });
    if (!response.ok) throw new Error(`${url(path)} HTTP ${response.status}`);
    const total = responseContentLength(response);
    let loaded = 0;
    const chunks = [];
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        options.onProgress?.({ loaded, total });
      }
    } else {
      const value = new Uint8Array(await response.arrayBuffer());
      chunks.push(value);
      loaded = value.byteLength;
      options.onProgress?.({ loaded, total });
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, bytesLoaded: loaded, bytesTotal: total };
  }

  async function manifest() {
    const result = await json('data/manifest.json', { cache: 'no-cache' });
    return { ...result, data: validateKcscManifest(result.data) };
  }

  async function caseRecord(caseNumber, progress = {}) {
    const canonical = clean(caseNumber).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!canonical) throw new Error('invalid KCSC case number');
    return json(`archive/cases/${encodeURIComponent(canonical)}.json`, { cache: 'no-cache' }, progress);
  }

  async function rankingResource(manifestData, sourceName, validator, progress = {}) {
    const source = manifestData?.statistics?.ranking_sources?.[sourceName];
    if (!source?.path) throw new Error(`KCSC ${sourceName.replaceAll('_', ' ')} are unavailable`);
    const result = await json(source.path, { cache: 'no-cache' }, progress);
    return { ...result, data: validator(result.data) };
  }

  async function attorneyRankings(manifestData, progress = {}) {
    return rankingResource(
      manifestData,
      'attorney_rankings',
      validateKcscAttorneyRankings,
      progress,
    );
  }

  async function judgmentRankings(manifestData, progress = {}) {
    return rankingResource(
      manifestData,
      'judgment_rankings',
      validateKcscJudgmentRankings,
      progress,
    );
  }

  return {
    attorneyRankings,
    base: base.href,
    buffer,
    caseRecord,
    descriptor: describeKcscDataClient(),
    fetch: fetchRequest,
    json,
    judgmentRankings,
    manifest,
    text,
    url,
  };
}
