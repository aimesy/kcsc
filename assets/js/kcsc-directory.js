import { fetchTextWithProgress } from './load-progress.js';

export const KCSC_DIRECTORY_FORMAT = 'kcsc-case-directory-v1';

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
        yearEntry.sources.forEach((source) => {
          if (!safeDirectoryPath(source?.path)) throw new Error(`invalid directory source path for ${key}`);
          strictCount(source.rows, `${source.path}.rows`);
          strictCount(source.size_bytes, `${source.path}.size_bytes`);
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

  return {
    loadSource,
    sourceUrl,
    clear(path = '') {
      if (path) cache.delete(safeDirectoryPath(path));
      else cache.clear();
    },
  };
}
