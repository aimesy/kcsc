#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const viewerUrl = process.argv[2];
if (!viewerUrl) throw new Error('usage: smoke_statistics_browser.mjs <viewer-url>');

const parsedViewerUrl = new URL(viewerUrl);
const casesViewerUrl = new URL(parsedViewerUrl);
casesViewerUrl.searchParams.delete('scope');
const dataBase = new URL(parsedViewerUrl.searchParams.get('dataBase') || './', parsedViewerUrl);
const manifest = await fetch(new URL('data/manifest.json', dataBase)).then((response) => {
  if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
  return response.json();
});
const selectedType = manifest.statistics.filters.case_types.includes('criminal')
  ? 'criminal'
  : manifest.statistics.filters.case_types[0];
const selectedLocation = manifest.statistics.filters.locations[0];
const selectedId = `type:${selectedType}|location:${selectedLocation}`;
const selectedSegment = manifest.statistics.segments.find((segment) => segment.id === selectedId);
if (!selectedSegment) throw new Error(`missing browser smoke segment ${selectedId}`);

const port = 9300 + (process.pid % 300);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcsc-statistics-browser-'));
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1440,1000',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function devtoolsTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Chrome has not opened the debugging endpoint yet.
    }
    await delay(100);
  }
  throw new Error('Chrome DevTools endpoint did not become ready');
}

let socket;
let nextId = 0;
const pending = new Map();
const runtimeErrors = [];

function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await command('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'browser evaluation failed');
  return response.result?.value;
}

async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`${label} did not become ready`);
}

try {
  const target = await devtoolsTarget();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result || {});
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(message.params.exceptionDetails?.text || 'uncaught browser exception');
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      runtimeErrors.push(message.params.entry.text);
    }
  });

  await command('Page.enable');
  await command('Runtime.enable');
  await command('Log.enable');
  await command('Page.navigate', { url: casesViewerUrl.href });
  await waitFor(
    "document.getElementById('cs-scope-label')?.textContent === 'Cases' && document.getElementById('cs-sync')?.textContent === 'loaded'",
    'case viewer',
  );
  const visibleNavigation = await evaluate(`(() => {
    const button = document.getElementById('cs-statistics-btn');
    return button && getComputedStyle(button).display !== 'none';
  })()`);
  await evaluate("document.getElementById('cs-statistics-btn').click()");
  await waitFor("document.querySelectorAll('.cs-stat-metric').length === 6", 'statistics dashboard');

  const desktop = await evaluate(`(() => ({
    scope: document.getElementById('cs-scope-label')?.textContent,
    cases: document.querySelector('.cs-stat-metric strong')?.textContent.trim(),
    metrics: document.querySelectorAll('.cs-stat-metric').length,
    cards: document.querySelectorAll('.cs-stat-card').length,
    coverage: document.querySelectorAll('.cs-stat-coverage li').length,
    years: document.querySelectorAll('.cs-stat-trend li').length,
    modes: [...document.querySelectorAll('.cs-stat-mode-tab')].map((tab) => tab.textContent.trim()),
    selectedMode: document.querySelector('.cs-stat-mode-tab[aria-selected="true"]')?.textContent.trim(),
    visibleNavigation: ${JSON.stringify(visibleNavigation)},
    navigationActive: document.getElementById('cs-statistics-btn')?.classList.contains('active'),
    shareableScope: new URL(location.href).searchParams.get('scope'),
    controlsHidden: getComputedStyle(document.getElementById('cs-filter-btn')).display === 'none'
      && getComputedStyle(document.getElementById('cs-reset-btn')).display === 'none'
      && getComputedStyle(document.getElementById('cs-search')).display === 'none',
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }))()`);

  await evaluate(`(() => {
    const type = document.getElementById('cs-stat-type');
    type.value = ${JSON.stringify(selectedType)};
    type.dispatchEvent(new Event('change', { bubbles: true }));
    const location = document.getElementById('cs-stat-location');
    location.value = ${JSON.stringify(selectedLocation)};
    location.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(
    `document.querySelector('.cs-stat-metric strong')?.textContent.trim() === ${JSON.stringify(new Intl.NumberFormat('en-US').format(selectedSegment.cases))}`,
    'filtered statistics segment',
  );
  const filtered = await evaluate(`(() => ({
    type: document.getElementById('cs-stat-type')?.value,
    location: document.getElementById('cs-stat-location')?.value,
    cases: document.querySelector('.cs-stat-metric strong')?.textContent.trim(),
    meta: document.getElementById('cs-entity-meta')?.textContent,
  }))()`);

  let parity = null;
  if (manifest.statistics.ranking_sources?.attorney_rankings
      && manifest.statistics.ranking_sources?.judgment_rankings) {
    await evaluate("document.querySelector('[data-statistics-mode=aggregates]').click()");
    await waitFor("document.querySelectorAll('.cs-stat-table tbody tr').length > 0", 'aggregate table');
    const aggregateRows = await evaluate("document.querySelectorAll('.cs-stat-table tbody tr').length");
    await evaluate("document.querySelector('[data-statistics-mode=rankings]').click()");
    await waitFor("document.querySelectorAll('.cs-stat-table tbody tr').length > 0", 'attorney rankings');
    const attorneyRows = await evaluate("document.querySelectorAll('.cs-stat-table tbody tr').length");
    const allJurisdictionsPracticeShare = await evaluate(`(() => ({
      measure: [...document.querySelector('[data-statistics-control=measure]').options]
        .some((option) => option.value === 'practice_share_percent'),
      column: [...document.querySelectorAll('.cs-stat-table th')]
        .some((heading) => heading.textContent.trim() === 'Practice share'),
    }))()`);
    await evaluate(`(() => {
      const category = document.querySelector('[data-statistics-control=category]');
      category.value = category.options[1].value;
      category.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(
      "[...document.querySelectorAll('.cs-stat-table th')].some((heading) => heading.textContent.trim() === 'Practice share')",
      'category-specific practice share',
    );
    const narrowedPracticeShare = await evaluate(`(() => ({
      measure: [...document.querySelector('[data-statistics-control=measure]').options]
        .some((option) => option.value === 'practice_share_percent'),
      column: [...document.querySelectorAll('.cs-stat-table th')]
        .some((heading) => heading.textContent.trim() === 'Practice share'),
    }))()`);
    await evaluate("document.querySelector('[data-statistics-mode=judgments]').click()");
    await waitFor("document.querySelectorAll('.cs-stat-table tbody tr').length > 0", 'judgment rankings');
    const judgmentRows = await evaluate("document.querySelectorAll('.cs-stat-table tbody tr').length");
    parity = await evaluate(`(() => ({
      aggregateRows: ${JSON.stringify(aggregateRows)},
      attorneyRows: ${JSON.stringify(attorneyRows)},
      allJurisdictionsPracticeShare: ${JSON.stringify(allJurisdictionsPracticeShare)},
      narrowedPracticeShare: ${JSON.stringify(narrowedPracticeShare)},
      judgmentRows: ${JSON.stringify(judgmentRows)},
      controls: document.querySelectorAll('.cs-stat-controls select, .cs-stat-controls input').length,
      matterTypeOptions: document.querySelector('[data-statistics-control=judgmentMatterType]')?.options.length || 0,
      matterCategoryOptions: document.querySelector('[data-statistics-control=judgmentMatterCategory]')?.options.length || 0,
      csv: Boolean(document.querySelector('[data-statistics-export]')),
    }))()`);
    await evaluate("document.querySelector('[data-statistics-mode=dashboard]').click()");
    await waitFor("document.querySelectorAll('.cs-stat-metric').length === 6", 'restored dashboard');
  }

  const desktopShot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/kcsc-statistics-desktop.png', Buffer.from(desktopShot.data, 'base64'));
  await evaluate("document.getElementById('cs-body').scrollTop = document.getElementById('cs-body').scrollHeight");
  await delay(150);
  const desktopBottomShot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/kcsc-statistics-desktop-bottom.png', Buffer.from(desktopBottomShot.data, 'base64'));
  await evaluate("document.getElementById('cs-body').scrollTop = 0");

  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await delay(250);
  const mobile = await evaluate(`(() => ({
    width: window.innerWidth,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    metricColumns: getComputedStyle(document.querySelector('.cs-stat-metrics')).gridTemplateColumns.split(' ').length,
    gridColumns: getComputedStyle(document.querySelector('.cs-stat-grid')).gridTemplateColumns.split(' ').length,
  }))()`);
  const mobileShot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/kcsc-statistics-mobile.png', Buffer.from(mobileShot.data, 'base64'));

  if (desktop.scope !== 'Statistics' || desktop.cases !== new Intl.NumberFormat('en-US').format(manifest.archive.cases)
    || !desktop.visibleNavigation || !desktop.navigationActive || desktop.shareableScope !== 'statistics') {
    throw new Error(`unexpected desktop statistics state: ${JSON.stringify(desktop)}`);
  }
  if (desktop.modes.join('|') !== 'Dashboard|Case types|Attorney rankings|Judgment rankings'
    || desktop.selectedMode !== 'Dashboard') {
    throw new Error(`statistics mode parity failed: ${JSON.stringify(desktop)}`);
  }
  if (parity && (parity.aggregateRows < 1 || parity.attorneyRows < 1 || parity.judgmentRows < 1
    || parity.controls < 7 || parity.matterTypeOptions < 2 || parity.matterCategoryOptions < 2
    || parity.allJurisdictionsPracticeShare.measure || parity.allJurisdictionsPracticeShare.column
    || !parity.narrowedPracticeShare.measure || !parity.narrowedPracticeShare.column || !parity.csv)) {
    throw new Error(`ranking browser parity failed: ${JSON.stringify(parity)}`);
  }
  if (desktop.metrics !== 6 || desktop.cards !== 6 || desktop.coverage !== 9 || desktop.years < 8
    || !desktop.controlsHidden || desktop.overflow) {
    throw new Error(`desktop statistics layout failed: ${JSON.stringify(desktop)}`);
  }
  if (filtered.type !== selectedType || filtered.location !== selectedLocation
    || filtered.cases !== new Intl.NumberFormat('en-US').format(selectedSegment.cases)) {
    throw new Error(`statistics filters failed: ${JSON.stringify(filtered)}`);
  }
  if (mobile.width !== 390 || mobile.overflow || mobile.metricColumns !== 2 || mobile.gridColumns !== 1) {
    throw new Error(`mobile statistics layout failed: ${JSON.stringify(mobile)}`);
  }
  if (runtimeErrors.length) throw new Error(`browser errors: ${runtimeErrors.join(' | ')}`);

  console.log(JSON.stringify({ desktop, filtered, parity, mobile, runtimeErrors }));
} finally {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('browser smoke ended'));
  }
  pending.clear();
  socket?.close();
  chrome.kill('SIGTERM');
  await new Promise((resolve) => chrome.once('exit', resolve));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' || attempt === 19) throw error;
      await delay(50);
    }
  }
}
