import { fetchTextWithProgress } from './load-progress.js';

export const KCSC_DIRECTORY_FORMAT = 'kcsc-case-directory-v1';
export const DIRECTORY_CHUNK_BYTES = 1024 * 1024;

function clean(value) {
  return value == null ? '' : String(value).replace(/\u00a0/g, ' ').trim();
}

export function filingYear(value) {
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(clean(value));
  return match ? match[1] : 'unknown';
}

export function statusGroup(value) {
  return clean(value).replace(/\s+\d{2}\/\d{2}\/\d{4}$/, '').trim();
}

export function safeDirectoryPath(value) {
  const path = clean(value).replace(/\\/g, '/');
  if (!path || path.startsWith('/') || path.includes('..') || path.includes('//')) return '';
  return path;
}

export function parseNdjsonRows(value) {
  const rows = [];
  String(value || '').split(/\r?\n/).forEach((line, index) => {
    const raw = line.trim();
    if (!raw) return;
    let row;
    try {
      row = JSON.parse(raw);
    } catch (error) {
      throw new Error(`invalid NDJSON at line ${index + 1}: ${error.message || error}`);
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`invalid NDJSON object at line ${index + 1}`);
    }
    rows.push(row);
  });
  return rows;
}

function strictCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
  return value;
}

export function validateDirectoryManifest(manifest, expectedCases = null) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('invalid KCSC case directory manifest');
  }
  if (manifest.format !== KCSC_DIRECTORY_FORMAT) {
    throw new Error(`unsupported KCSC case directory format: ${clean(manifest.format) || 'missing'}`);
  }
  const caseCount = strictCount(manifest.case_count, 'case_count');
  if (expectedCases != null && caseCount !== expectedCases) {
    throw new Error(`case directory count ${caseCount} does not match manifest count ${expectedCases}`);
  }
  if (!Array.isArray(manifest.case_types)) throw new Error('case_types must be an array');

  let counted = 0;
  const seenGroups = new Set();
  const sourceMetadata = new Map();
  for (const typeEntry of manifest.case_types) {
    const caseType = clean(typeEntry?.case_type).toLowerCase();
    if (!caseType || !Array.isArray(typeEntry?.locations)) throw new Error('invalid case type entry');
    const typeRows = strictCount(typeEntry.rows, `${caseType}.rows`);
    let countedType = 0;
    for (const locationEntry of typeEntry.locations) {
      const location = clean(locationEntry?.location_code).toUpperCase();
      if (!location || !Array.isArray(locationEntry?.years)) throw new Error(`invalid ${caseType} location entry`);
      const locationRows = strictCount(locationEntry.rows, `${caseType}.${location}.rows`);
      let countedLocation = 0;
      for (const yearEntry of locationEntry.years) {
        const year = clean(yearEntry?.year);
        const key = `${caseType}\0${location}\0${year}`;
        if (!year || seenGroups.has(key) || !Array.isArray(yearEntry?.sources) || !yearEntry.sources.length) {
          throw new Error(`invalid or duplicate directory group ${caseType}/${location}/${year || '(missing)'}`);
        }
        seenGroups.add(key);
        const rows = strictCount(yearEntry.rows, `${caseType}.${location}.${year}.rows`);
        const seenSources = new Set();
        yearEntry.sources.forEach((source) => {
          const path = safeDirectoryPath(source?.path);
          if (!path || seenSources.has(path)) throw new Error(`invalid or duplicate directory source path for ${key}`);
          seenSources.add(path);
          const rows = strictCount(source.rows, `${path}.rows`);
          const sizeBytes = strictCount(source.size_bytes, `${path}.size_bytes`);
          const prior = sourceMetadata.get(path);
          if (prior && (prior.rows !== rows || prior.sizeBytes !== sizeBytes)) {
            throw new Error(`conflicting directory source metadata for ${path}`);
          }
          sourceMetadata.set(path, { rows, sizeBytes });
        });
        countedLocation += rows;
      }
      if (countedLocation !== locationRows) throw new Error(`location count mismatch for ${caseType}/${location}`);
      countedType += locationRows;
    }
    if (countedType !== typeRows) throw new Error(`case type count mismatch for ${caseType}`);
    counted += typeRows;
  }
  if (counted !== caseCount) throw new Error(`directory group count ${counted} does not match case_count ${caseCount}`);
  if (manifest.source_index_format != null && manifest.source_index_format !== 'ndjson-prefix-shards-v1') {
    throw new Error(`unsupported source index format: ${clean(manifest.source_index_format)}`);
  }
  if (manifest.source_index_parts != null
    && strictCount(manifest.source_index_parts, 'source_index_parts') !== sourceMetadata.size) {
    throw new Error('source index part count does not match referenced directory sources');
  }
  if (manifest.source_index_rows != null) {
    const sourceRows = strictCount(manifest.source_index_rows, 'source_index_rows');
    const referencedRows = [...sourceMetadata.values()].reduce((sum, source) => sum + source.rows, 0);
    if (sourceRows !== caseCount || referencedRows !== sourceRows) {
      throw new Error('source index row count does not match directory coverage');
    }
  }
  return manifest;
}

export function directoryGroups(manifest, filters = {}) {
  const typeFilter = clean(filters.caseType).toLowerCase();
  const locationFilter = clean(filters.location).toUpperCase();
  const fromYear = /^\d{4}/.exec(clean(filters.from))?.[0] || '';
  const toYear = /^\d{4}/.exec(clean(filters.to))?.[0] || '';
  const groups = [];
  for (const typeEntry of manifest?.case_types || []) {
    const caseType = clean(typeEntry.case_type).toLowerCase();
    if (typeFilter && caseType !== typeFilter) continue;
    for (const locationEntry of typeEntry.locations || []) {
      const location = clean(locationEntry.location_code).toUpperCase();
      if (locationFilter && location !== locationFilter) continue;
      for (const yearEntry of locationEntry.years || []) {
        const year = clean(yearEntry.year);
        if (fromYear && (year === 'unknown' || year < fromYear)) continue;
        if (toYear && (year === 'unknown' || year > toYear)) continue;
        groups.push({
          caseType,
          location,
          year,
          rows: yearEntry.rows,
          sources: yearEntry.sources,
        });
      }
    }
  }
  return groups.sort((a, b) => (
    (b.year === 'unknown' ? '' : b.year).localeCompare(a.year === 'unknown' ? '' : a.year)
    || a.caseType.localeCompare(b.caseType)
    || a.location.localeCompare(b.location)
  ));
}

export function uniqueDirectorySources(groups) {
  const sources = new Map();
  for (const group of groups || []) {
    for (const source of group.sources || []) {
      const path = safeDirectoryPath(source.path);
      if (path && !sources.has(path)) sources.set(path, { ...source, path });
    }
  }
  return [...sources.values()];
}

export function directorySourceBatches(groups) {
  const batches = [];
  const sourceYears = new Map();
  for (const group of groups || []) {
    for (const source of group.sources || []) {
      const path = safeDirectoryPath(source.path);
      if (!path || sourceYears.has(path)) continue;
      sourceYears.set(path, group.year);
    }
  }
  const byYear = new Map();
  for (const source of uniqueDirectorySources(groups)) {
    const year = sourceYears.get(source.path) || 'unknown';
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(source);
  }
  for (const year of [...byYear.keys()].sort((a, b) => (
    (b === 'unknown' ? '' : b).localeCompare(a === 'unknown' ? '' : a)
  ))) {
    batches.push({ year, sources: byYear.get(year) });
  }
  return batches;
}

export function rowMatchesGroup(row, group) {
  return clean(row?.case_type).toLowerCase() === group.caseType
    && clean(row?.location_code).toUpperCase() === group.location
    && filingYear(row?.filed_date || row?.filing_date) === group.year;
}

export function createDirectoryClient(options = {}) {
  const base = new URL(options.base || './', options.locationHref || globalThis.location?.href || 'https://example.invalid/');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cache = new Map();

  function sourceUrl(path) {
    const safePath = safeDirectoryPath(path);
    if (!safePath) throw new Error(`invalid KCSC directory source path: ${clean(path)}`);
    return new URL(safePath, base).href;
  }

  async function loadSource(source, hooks = {}) {
    const path = safeDirectoryPath(source?.path);
    if (!path) throw new Error('invalid KCSC directory source');
    if (cache.has(path)) return await cache.get(path);
    const promise = (async () => {
      const fetched = await fetchTextWithProgress(sourceUrl(path), { cache: 'no-cache' }, {
        fetchImpl,
        onProgress: hooks.onProgress,
        onPhase: hooks.onPhase,
      });
      const rows = parseNdjsonRows(fetched.text);
      return {
        rows,
        bytesLoaded: fetched.bytesLoaded,
        bytesTotal: fetched.bytesTotal,
      };
    })();
    cache.set(path, promise);
    try {
      const result = await promise;
      cache.set(path, result);
      return result;
    } catch (error) {
      cache.delete(path);
      throw error;
    }
  }

  // Reads a shard newest first (the shard is in case number order) in
  // byte-range chunks, so opening a year costs one chunk, not the whole shard.
  function openTail(source, options = {}) {
    const path = safeDirectoryPath(source?.path);
    if (!path) throw new Error('invalid KCSC directory source');
    const url = sourceUrl(path);
    const chunkBytes = Math.max(1024, Number(options.chunkBytes) || DIRECTORY_CHUNK_BYTES);
    const size = Number(source.size_bytes);
    let end = Number.isSafeInteger(size) && size >= 0 ? size : null;
    let carry = new Uint8Array(0);
    let bytesLoaded = 0;
    let done = end === 0;
    const decoder = new TextDecoder();

    function finish(bytes) {
      const rows = parseNdjsonRows(decoder.decode(bytes)).reverse();
      done = true;
      carry = new Uint8Array(0);
      return rows;
    }

    async function next() {
      if (done) return [];
      if (end == null) {
        const fetched = await fetchTextWithProgress(url, { cache: 'no-cache' }, { fetchImpl });
        bytesLoaded += fetched.bytesLoaded;
        return finish(new TextEncoder().encode(fetched.text));
      }
      const start = Math.max(0, end - chunkBytes);
      const response = await fetchImpl(url, {
        cache: 'no-cache',
        headers: { Range: `bytes=${start}-${end - 1}` },
      });
      if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
      const body = new Uint8Array(await response.arrayBuffer());
      bytesLoaded += body.byteLength;
      if (response.status !== 206) return finish(body);
      if (body.byteLength !== end - start) throw new Error(`${url} returned ${body.byteLength} bytes for a ${end - start} byte range`);
      const joined = new Uint8Array(body.byteLength + carry.byteLength);
      joined.set(body, 0);
      joined.set(carry, body.byteLength);
      end = start;
      if (start === 0) return finish(joined);
      const newline = joined.indexOf(10);
      if (newline < 0) {
        carry = joined;
        return [];
      }
      carry = joined.slice(0, newline);
      return parseNdjsonRows(decoder.decode(joined.subarray(newline + 1))).reverse();
    }

    return {
      next,
      get done() { return done; },
      get bytesLoaded() { return bytesLoaded; },
      get bytesTotal() { return end == null ? null : size; },
    };
  }

  return {
    loadSource,
    openTail,
    sourceUrl,
    clear(path = '') {
      if (path) cache.delete(safeDirectoryPath(path));
      else cache.clear();
    },
  };
}
