// sidepanel/sidepanel.js — UI logic + Prompt API orchestration.

import { MSG } from '../lib/messages.js';
import { checkAvailability, analyzeBlocks } from '../lib/prompt-runner.js';
import { buildReport } from '../lib/analyzer.js';
import { toMarkdown, toJSON, toCSV, filenameFor, EMOJI } from '../lib/exporters.js';
import { runBulk } from '../lib/bulk-runner.js';

const HISTORY_LIMIT = 20;
const SERP_HOST = 'google.com';
const STORAGE_KEYS = {
  brand: `brandContext:${SERP_HOST}`,
  history: 'history',
  preferences: 'preferences',
};

const state = {
  mode: 'single',           // 'single' | 'bulk'
  tabId: null,
  serpUrl: '',
  query: '',
  brandContext: null,
  modelAvailability: 'unknown',
  report: null,
  analyzing: false,
  bulk: {
    running: false,
    queries: [],
    results: [],             // reports, indexed by query order
    failures: [],            // { queryIndex, query, reason }
    controller: null,        // AbortController
    completedCount: 0,
  },
};

// ---- DOM helpers ----------------------------------------------------------

const $ = (id) => document.getElementById(id);

const els = {};
function cacheEls() {
  const ids = [
    'queryLine',
    'state-no-serp',
    'state-unavailable',
    'state-downloadable',
    'state-downloading',
    'state-ready',
    'state-analyzing',
    'state-error',
    'btnDownload',
    'btnAnalyze',
    'btnReanalyze',
    'btnExport',
    'btnDismissError',
    'exportMenu',
    'downloadBar',
    'downloadPercent',
    'progressLine',
    'errorWhat',
    'errorHint',
    'brandForm',
    'brandFormTitle',
    'brandName',
    'brandDescription',
    'officialDomains',
    'socialHandles',
    'brandSave',
    'brandCancel',
    'brandSummary',
    'summaryBrandName',
    'summaryBrandDescription',
    'brandEdit',
    'results',
    'scoreNumber',
    'sentimentRow',
    'analyzedLine',
    'risksList',
    'riskCount',
    'controlList',
    'blocksList',
    // bulk
    'btnToggleMode',
    'single-view',
    'bulk-view',
    'bulkBrandSummary',
    'bulkSummaryBrandName',
    'bulkSummaryBrandDescription',
    'bulkBrandEdit',
    'bulkForm',
    'bulkQueries',
    'btnRunBulk',
    'bulkRunning',
    'bulkBar',
    'bulkProgressLine',
    'bulkList',
    'btnCancelBulk',
    'bulkDone',
    'bulkDoneSummary',
    'bulkDoneList',
    'btnExportBulkJson',
    'btnExportBulkCsv',
    'btnNewBulk',
  ];
  for (const id of ids) els[id] = $(id);
}

function show(el) { el?.classList.remove('hidden'); }
function hide(el) { el?.classList.add('hidden'); }

function showStateOnly(idToShow) {
  const stateIds = [
    'state-no-serp',
    'state-unavailable',
    'state-downloadable',
    'state-downloading',
    'state-ready',
    'state-analyzing',
    'state-error',
  ];
  for (const id of stateIds) {
    if (id === idToShow) show(els[id]); else hide(els[id]);
  }
}

function setText(el, text) {
  if (!el) return;
  el.textContent = text;
}

// ---- Storage --------------------------------------------------------------

async function loadBrandContext() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.brand]);
  return data[STORAGE_KEYS.brand] || null;
}

async function saveBrandContext(ctx) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.brand]: { ...ctx, updatedAt: Date.now() },
  });
}

async function pushHistory(report) {
  const data = await chrome.storage.local.get([STORAGE_KEYS.history]);
  const history = Array.isArray(data[STORAGE_KEYS.history]) ? data[STORAGE_KEYS.history] : [];
  const entry = {
    id: report.id,
    query: report.query,
    timestamp: report.timestamp,
    score: report.score,
    sentimentCounts: report.sentiment.counts,
    report,
  };
  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  await chrome.storage.local.set({ [STORAGE_KEYS.history]: history });
}

// ---- Tab detection --------------------------------------------------------

async function getActiveSerpTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return null;
  if (!tab.url) return null;
  try {
    const u = new URL(tab.url);
    if (u.hostname.endsWith('google.com') && u.pathname === '/search') {
      return tab;
    }
  } catch { /* not a URL */ }
  return null;
}

function deriveQueryFromUrl(url) {
  try {
    return new URL(url).searchParams.get('q') || '';
  } catch {
    return '';
  }
}

// ---- Messaging ------------------------------------------------------------

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(response);
    });
  });
}

async function ensureContentScript(tabId) {
  // Try a ping first; if no listener, inject the content script manually.
  try {
    const r = await sendToTab(tabId, { type: MSG.PING });
    if (r && r.ok) return true;
  } catch {
    // fall through
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js'],
    });
    return true;
  } catch (err) {
    console.error('[serm-snapshot] failed to inject content script', err);
    return false;
  }
}

// ---- Brand form -----------------------------------------------------------

function fillBrandForm(ctx) {
  els.brandName.value = ctx?.brandName || '';
  els.brandDescription.value = ctx?.brandDescription || '';
  els.officialDomains.value = (ctx?.officialDomains || []).join('\n');
  els.socialHandles.value = (ctx?.socialHandles || []).join('\n');
}

function readBrandForm() {
  const split = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  return {
    brandName: els.brandName.value.trim(),
    brandDescription: els.brandDescription.value.trim(),
    officialDomains: split(els.officialDomains.value),
    socialHandles: split(els.socialHandles.value),
  };
}

function showBrandForm({ editing }) {
  fillBrandForm(editing ? state.brandContext : null);
  els.brandFormTitle.textContent = editing ? 'Edit brand context' : 'Tell me about this brand';
  if (editing) show(els.brandCancel); else hide(els.brandCancel);
  show(els.brandForm);
  hide(els.brandSummary);
  hide(els['state-ready']);
}

function showBrandSummary() {
  if (!state.brandContext) return;
  setText(els.summaryBrandName, state.brandContext.brandName);
  setText(els.summaryBrandDescription, state.brandContext.brandDescription || '');
  show(els.brandSummary);
  hide(els.brandForm);
}

// ---- Availability flow ----------------------------------------------------

async function refreshAvailability() {
  const av = await checkAvailability();
  state.modelAvailability = av;
  if (av === 'unavailable') {
    showStateOnly('state-unavailable');
    return;
  }
  if (av === 'downloadable') {
    showStateOnly('state-downloadable');
    return;
  }
  if (av === 'downloading') {
    showStateOnly('state-downloading');
    return;
  }
  if (av === 'available') {
    if (state.brandContext) {
      showStateOnly('state-ready');
    } else {
      // Brand context form already controls visibility; just hide state cards.
      showStateOnly('');
    }
  }
}

async function triggerDownload() {
  showStateOnly('state-downloading');
  els.downloadBar.style.width = '0%';
  setText(els.downloadPercent, '0%');
  try {
    // Creating a session triggers download; we destroy it immediately.
    const session = await self.LanguageModel.create({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
      monitor: (m) => {
        m.addEventListener('downloadprogress', (e) => {
          const pct = Math.round((e.loaded || 0) * 100);
          els.downloadBar.style.width = `${pct}%`;
          setText(els.downloadPercent, `${pct}%`);
        });
      },
    });
    try { session.destroy?.(); } catch {}
    await refreshAvailability();
  } catch (err) {
    console.error('[serm-snapshot] download failed', err);
    showError('Model download failed', err.message || 'Unknown error.');
  }
}

// ---- Render report --------------------------------------------------------

function renderReport(report) {
  state.report = report;

  setText(els.scoreNumber, String(report.score));

  const s = report.sentiment.counts;
  const p = report.sentiment.percentages;
  els.sentimentRow.innerHTML = '';
  const pairs = [
    ['positive', s.positive, p.positive],
    ['neutral', s.neutral, p.neutral],
    ['negative', s.negative, p.negative],
    ['mixed', s.mixed, p.mixed],
  ];
  for (const [key, count, pct] of pairs) {
    const span = document.createElement('span');
    span.textContent = `${EMOJI[key]} ${count} (${pct}%)`;
    els.sentimentRow.appendChild(span);
  }

  const failed = report.counts.skipped;
  setText(
    els.analyzedLine,
    `Analyzed ${report.counts.analyzed} of ${report.counts.total} blocks${failed ? ` (${failed} skipped)` : ''}.`
  );

  els.risksList.innerHTML = '';
  setText(els.riskCount, report.risks.length ? `(${report.risks.length})` : '');
  if (!report.risks.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No flagged risks.';
    els.risksList.appendChild(li);
  } else {
    for (const r of report.risks) {
      const li = document.createElement('li');
      const label = r.blockType === 'organic'
        ? `Position #${r.position}`
        : labelForBlockType(r.blockType);
      const main = document.createElement('div');
      main.innerHTML = `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(r.oneLineSummary)}`;
      li.appendChild(main);
      const reasons = (r.risk?.reasons || []).join('; ');
      if (reasons) {
        const sub = document.createElement('span');
        sub.className = 'muted small';
        sub.textContent = reasons;
        li.appendChild(sub);
      }
      els.risksList.appendChild(li);
    }
  }

  els.controlList.innerHTML = '';
  const ctrl = report.control;
  for (const [k, label] of [
    ['owned', 'Owned'],
    ['earnedPositive', 'Earned (positive third-party)'],
    ['thirdPartyNeutral', 'Third-party (neutral)'],
    ['thirdPartyNegative', 'Third-party (negative/mixed)'],
  ]) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.textContent = label;
    const b = document.createElement('span');
    b.textContent = String(ctrl[k] || 0);
    li.appendChild(a);
    li.appendChild(b);
    els.controlList.appendChild(li);
  }

  els.blocksList.innerHTML = '';
  for (const b of report.blocks) {
    const li = document.createElement('li');
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    const headLabel = b.blockType === 'organic'
      ? `#${b.position} ${b.sourceDomain || 'unknown'}`
      : labelForBlockType(b.blockType);
    sum.textContent = `${EMOJI[b.sentiment] || ''} ${headLabel} — ${b.sentiment}, ${b.ownership}`;
    det.appendChild(sum);

    const body = document.createElement('div');
    body.className = 'body';
    if (b.sourceTitle) {
      const t = document.createElement('p');
      t.innerHTML = `<strong>${escapeHtml(b.sourceTitle)}</strong>`;
      body.appendChild(t);
    }
    if (b.sourceUrl) {
      const u = document.createElement('p');
      u.className = 'src';
      u.textContent = b.sourceUrl;
      body.appendChild(u);
    }
    if (b.oneLineSummary) {
      const p2 = document.createElement('p');
      p2.textContent = b.oneLineSummary;
      body.appendChild(p2);
    }
    if (b.risk?.flag && b.risk.reasons?.length) {
      const r = document.createElement('p');
      r.className = 'risk';
      r.textContent = `Risk: ${b.risk.reasons.join('; ')}`;
      body.appendChild(r);
    }
    if (b.analysisFailed) {
      const f = document.createElement('p');
      f.className = 'muted small';
      f.textContent = 'Analysis failed for this block.';
      body.appendChild(f);
    }

    det.appendChild(body);
    li.appendChild(det);
    els.blocksList.appendChild(li);
  }

  show(els.results);
  showStateOnly('');
}

function labelForBlockType(type) {
  return type
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showError(what, hint) {
  setText(els.errorWhat, what);
  setText(els.errorHint, hint || '');
  showStateOnly('state-error');
}

// ---- Analysis flow --------------------------------------------------------

async function runAnalysis() {
  if (!state.tabId) {
    showStateOnly('state-no-serp');
    return;
  }
  if (!state.brandContext) {
    showBrandForm({ editing: false });
    return;
  }
  if (state.analyzing) {
    return; // already running — ignore double-click
  }

  // Pin the tabId for this run so the user switching tabs can't redirect
  // extraction to the wrong page.
  const tabId = state.tabId;
  state.analyzing = true;
  hide(els.results);
  showStateOnly('state-analyzing');
  setText(els.progressLine, 'Extracting blocks…');

  try {
    // 1. Run extraction in the pinned tab.
    let extraction;
    try {
      const ok = await ensureContentScript(tabId);
      if (!ok) {
        showError('Could not load content script', 'Reload the SERP page and try again.');
        return;
      }
      const resp = await sendToTab(tabId, { type: MSG.RUN_EXTRACTION });
      if (!resp || !resp.ok) {
        showError('Extraction failed', resp?.error || 'No response from page.');
        return;
      }
      extraction = resp.payload;
    } catch (err) {
      console.error('[serm-snapshot] extraction error', err);
      showError('Extraction failed', err.message || String(err));
      return;
    }

    state.query = extraction.query || state.query;
    setText(els.queryLine, `Query: "${state.query || '(unknown)'}"`);

    if (!extraction.blocks.length) {
      showError('No blocks found', 'Could not extract any blocks from this SERP. The DOM selectors may be out of date.');
      return;
    }

    setText(els.progressLine, `Found ${extraction.blocks.length} blocks. Analyzing…`);

    // 2. Build minimal model-shape blocks (already truncated by extractors).
    const modelBlocks = extraction.blocks.map((b) => ({
      blockType: b.blockType,
      position: b.position,
      text: b.text,
      ...(b.sourceDomain ? { sourceDomain: b.sourceDomain } : {}),
      ...(b.sourceUrl ? { sourceUrl: b.sourceUrl } : {}),
      ...(b.sourceTitle ? { sourceTitle: b.sourceTitle } : {}),
    }));

    // 3. Analyze in batches.
    let analyses, failures;
    try {
      const result = await analyzeBlocks({
        blocks: modelBlocks,
        brandContext: state.brandContext,
        onProgress: (info) => {
          if (info.stage === 'creating-session') {
            setText(els.progressLine, 'Loading local model…');
          } else if (info.stage === 'rotating-session') {
            setText(els.progressLine, 'Refreshing model session…');
          } else if (info.stage === 'prompting') {
            setText(
              els.progressLine,
              `Extracted ${extraction.blocks.length} blocks · Analyzing batch ${info.batchIndex} of ${info.totalBatches}`
            );
          }
        },
      });
      analyses = result.analyses;
      failures = result.failures;
    } catch (err) {
      console.error('[serm-snapshot] analysis error', err);
      showError('Analysis failed', err.message || String(err));
      return;
    }

    // 4. Build report and render.
    const report = buildReport({
      extraction,
      analyses,
      brandContext: state.brandContext,
      failures,
    });
    renderReport(report);
    pushHistory(report).catch((err) => console.warn('[serm-snapshot] history save failed', err));
  } finally {
    state.analyzing = false;
  }
}

// ---- Export ---------------------------------------------------------------

function downloadBlob(content, mime, filename) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportReport(format) {
  if (!state.report) return;
  if (format === 'markdown') {
    downloadBlob(toMarkdown(state.report), 'text/markdown;charset=utf-8', filenameFor(state.report, 'md'));
  } else if (format === 'json') {
    downloadBlob(toJSON(state.report), 'application/json;charset=utf-8', filenameFor(state.report, 'json'));
  } else if (format === 'csv') {
    downloadBlob(toCSV(state.report), 'text/csv;charset=utf-8', filenameFor(state.report, 'csv'));
  }
}

// ---- Bulk mode ------------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  if (mode === 'bulk') {
    hide(els['single-view']);
    show(els['bulk-view']);
    setText(els.btnToggleMode, '← Single mode');
    refreshBulkBrandSummary();
    if (!state.bulk.running) {
      // Form is the default state when entering bulk mode.
      hide(els.bulkRunning);
      hide(els.bulkDone);
      show(els.bulkForm);
    }
  } else {
    hide(els['bulk-view']);
    show(els['single-view']);
    setText(els.btnToggleMode, 'Bulk mode →');
  }
}

function refreshBulkBrandSummary() {
  if (!state.brandContext) {
    hide(els.bulkBrandSummary);
    return;
  }
  setText(els.bulkSummaryBrandName, state.brandContext.brandName);
  setText(els.bulkSummaryBrandDescription, state.brandContext.brandDescription || '');
  show(els.bulkBrandSummary);
}

function readBulkQueries() {
  return els.bulkQueries.value
    .split('\n')
    .map((q) => q.trim())
    .filter(Boolean);
}

function bulkMarker(status) {
  if (status === 'ok') return { text: '✓', cls: 'ok' };
  if (status === 'fail') return { text: '✗', cls: 'fail' };
  return { text: '…', cls: 'run' };
}

function renderBulkRow(listEl, query, { status, score, reason }) {
  const li = document.createElement('li');
  const m = bulkMarker(status);
  const marker = document.createElement('span');
  marker.className = `marker ${m.cls}`;
  marker.textContent = m.text;
  li.appendChild(marker);

  const q = document.createElement('span');
  q.className = 'q';
  q.textContent = query;
  q.title = query;
  li.appendChild(q);

  const sc = document.createElement('span');
  sc.className = 'score';
  if (status === 'ok') sc.textContent = `${score}/100`;
  else if (status === 'fail') sc.textContent = reason || 'failed';
  else sc.textContent = '';
  li.appendChild(sc);

  return li;
}

function rerenderBulkList(listEl) {
  listEl.innerHTML = '';
  const queries = state.bulk.queries;
  const resultByQ = new Map();
  for (const r of state.bulk.results) {
    resultByQ.set(`${r._bulkIndex}`, { status: 'ok', score: r.score });
  }
  for (const f of state.bulk.failures) {
    resultByQ.set(`${f.queryIndex}`, { status: 'fail', reason: f.reason });
  }
  for (let i = 0; i < queries.length; i++) {
    const data = resultByQ.get(`${i}`);
    let status = 'pending';
    if (data) status = data.status;
    else if (state.bulk.running && i === state.bulk.completedCount) status = 'running';
    listEl.appendChild(
      renderBulkRow(listEl, queries[i], {
        status,
        score: data?.score,
        reason: data?.reason,
      })
    );
  }
}

function setBulkProgress(text, fraction) {
  setText(els.bulkProgressLine, text);
  if (Number.isFinite(fraction)) {
    els.bulkBar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }
}

async function startBulk() {
  if (state.bulk.running) return;
  if (!state.brandContext) {
    alert('Set brand context in single mode first, then return to bulk.');
    return;
  }
  const queries = readBulkQueries();
  if (!queries.length) {
    alert('Paste at least one query (one per line).');
    return;
  }
  if (queries.length > 50) {
    if (!confirm(`That's ${queries.length} queries — could take ${Math.ceil(queries.length / 2)}–${queries.length} minutes. Continue?`)) {
      return;
    }
  }
  if (state.modelAvailability !== 'available') {
    alert('Local model is not available. Open single mode to download or check requirements.');
    return;
  }

  state.bulk.running = true;
  state.bulk.queries = queries;
  state.bulk.results = [];
  state.bulk.failures = [];
  state.bulk.completedCount = 0;
  state.bulk.controller = new AbortController();

  hide(els.bulkForm);
  hide(els.bulkDone);
  show(els.bulkRunning);
  setBulkProgress(`Starting query 1 of ${queries.length}…`, 0);
  rerenderBulkList(els.bulkList);

  const onProgress = (info) => {
    const total = info.totalQueries || queries.length;
    const i = info.queryIndex ?? 0;
    const frac = (i + (info.batchIndex && info.totalBatches ? info.batchIndex / info.totalBatches : 0)) / total;
    let line = `Query ${i + 1} of ${total}: "${info.query || ''}"`;
    if (info.stage === 'loading-tab') line += ' — opening tab';
    else if (info.stage === 'rendering') line += ' — rendering page';
    else if (info.stage === 'extracting') line += ' — extracting blocks';
    else if (info.stage === 'creating-session') line += ' — loading model';
    else if (info.stage === 'rotating-session') line += ' — refreshing model session';
    else if (info.stage === 'analyzing') {
      if (info.batchIndex && info.totalBatches) {
        line += ` — analyzing batch ${info.batchIndex}/${info.totalBatches}`;
      } else {
        line += ' — analyzing';
      }
    }
    setBulkProgress(line, frac);
  };

  const onResult = ({ queryIndex, query, report, error }) => {
    state.bulk.completedCount = queryIndex + 1;
    if (report) {
      report._bulkIndex = queryIndex;
      state.bulk.results.push(report);
      pushHistory(report).catch((err) => console.warn('[serm-snapshot] history save failed', err));
    } else {
      state.bulk.failures.push({ queryIndex, query, reason: error || 'unknown' });
    }
    rerenderBulkList(els.bulkList);
  };

  try {
    const { results, failures } = await runBulk({
      queries,
      brandContext: state.brandContext,
      signal: state.bulk.controller.signal,
      onProgress,
      onResult,
    });
    // results/failures from runBulk are also accumulated via onResult — prefer
    // those callbacks for ordering. The return value is a final consistency check.
    if (state.bulk.results.length === 0 && results.length) {
      // Defensive: in case onResult was missed.
      state.bulk.results = results.map((r, i) => ({ ...r, _bulkIndex: i }));
      state.bulk.failures = failures;
    }
  } catch (err) {
    console.error('[serm-snapshot] bulk failed', err);
  } finally {
    state.bulk.running = false;
    finishBulk();
  }
}

function finishBulk() {
  hide(els.bulkRunning);
  show(els.bulkDone);

  const total = state.bulk.queries.length;
  const ok = state.bulk.results.length;
  const failed = state.bulk.failures.length;
  setText(
    els.bulkDoneSummary,
    `${ok} of ${total} analyzed${failed ? `, ${failed} failed` : ''}.`
  );
  rerenderBulkList(els.bulkDoneList);
  setBulkProgress('', 1);
}

function cancelBulk() {
  if (!state.bulk.running) return;
  if (!confirm('Cancel bulk run? Reports completed so far will be kept.')) return;
  state.bulk.controller?.abort();
}

function exportBulkJson() {
  if (!state.bulk.results.length) return;
  const payload = {
    brandContext: state.brandContext,
    timestamp: Date.now(),
    queries: state.bulk.queries,
    results: state.bulk.results,
    failures: state.bulk.failures,
  };
  const date = new Date().toISOString().slice(0, 10);
  const brand = (state.brandContext?.brandName || 'snapshot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  downloadBlob(
    JSON.stringify(payload, null, 2),
    'application/json;charset=utf-8',
    `serm-bulk-${brand}-${date}.json`
  );
}

function exportBulkCsv() {
  if (!state.bulk.results.length) return;
  const headers = [
    'query',
    'score',
    'position',
    'blockType',
    'domain',
    'url',
    'title',
    'sentiment',
    'brandVisibility',
    'ownership',
    'riskFlag',
    'summary',
  ];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n\r]/.test(s) ? `"${s}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of state.bulk.results) {
    for (const b of r.blocks) {
      lines.push(
        [
          cell(r.query),
          cell(r.score),
          cell(b.position),
          cell(b.blockType),
          cell(b.sourceDomain || ''),
          cell(b.sourceUrl || ''),
          cell(b.sourceTitle || ''),
          cell(b.sentiment),
          cell(b.brandVisibility),
          cell(b.ownership),
          cell(b.risk?.flag ? 'true' : 'false'),
          cell(b.oneLineSummary || ''),
        ].join(',')
      );
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const brand = (state.brandContext?.brandName || 'snapshot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  downloadBlob(lines.join('\n'), 'text/csv;charset=utf-8', `serm-bulk-${brand}-${date}.csv`);
}

function startNewBulk() {
  // Reset state (but keep brandContext).
  state.bulk.queries = [];
  state.bulk.results = [];
  state.bulk.failures = [];
  state.bulk.completedCount = 0;
  els.bulkQueries.value = '';
  hide(els.bulkDone);
  show(els.bulkForm);
}

// ---- Wiring ---------------------------------------------------------------

function wire() {
  els.btnDownload.addEventListener('click', triggerDownload);
  els.btnAnalyze.addEventListener('click', runAnalysis);
  els.btnReanalyze.addEventListener('click', runAnalysis);
  els.btnDismissError.addEventListener('click', () => {
    showStateOnly(state.brandContext ? 'state-ready' : '');
  });

  els.brandSave.addEventListener('click', async () => {
    const ctx = readBrandForm();
    if (!ctx.brandName || !ctx.brandDescription || ctx.officialDomains.length === 0) {
      alert('Brand name, description, and at least one official domain are required.');
      return;
    }
    state.brandContext = ctx;
    await saveBrandContext(ctx);
    showBrandSummary();
    refreshBulkBrandSummary();
    if (state.modelAvailability === 'available') showStateOnly('state-ready');
  });
  els.brandCancel.addEventListener('click', () => {
    if (!state.brandContext) return;
    showBrandSummary();
    if (state.modelAvailability === 'available') showStateOnly('state-ready');
  });
  els.brandEdit.addEventListener('click', () => showBrandForm({ editing: true }));

  els.btnExport.addEventListener('click', () => {
    const open = !els.exportMenu.classList.contains('hidden');
    if (open) {
      hide(els.exportMenu);
      els.btnExport.setAttribute('aria-expanded', 'false');
    } else {
      show(els.exportMenu);
      els.btnExport.setAttribute('aria-expanded', 'true');
    }
  });
  els.exportMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-format]');
    if (!btn) return;
    exportReport(btn.dataset.format);
    hide(els.exportMenu);
    els.btnExport.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', (e) => {
    if (!els.exportMenu.classList.contains('hidden') &&
        !els.exportMenu.contains(e.target) &&
        e.target !== els.btnExport) {
      hide(els.exportMenu);
      els.btnExport.setAttribute('aria-expanded', 'false');
    }
  });

  // Bulk mode wiring.
  els.btnToggleMode.addEventListener('click', () => {
    if (state.mode === 'bulk' && state.bulk.running) {
      alert('Bulk run is in progress. Cancel it first to leave bulk mode.');
      return;
    }
    setMode(state.mode === 'bulk' ? 'single' : 'bulk');
  });
  els.btnRunBulk.addEventListener('click', startBulk);
  els.btnCancelBulk.addEventListener('click', cancelBulk);
  els.btnExportBulkJson.addEventListener('click', exportBulkJson);
  els.btnExportBulkCsv.addEventListener('click', exportBulkCsv);
  els.btnNewBulk.addEventListener('click', startNewBulk);
  els.bulkBrandEdit.addEventListener('click', () => {
    // Switch back to single mode and open the edit form there — the brand
    // context UI lives in single mode and is shared across both.
    if (state.bulk.running) {
      alert('Bulk run is in progress. Cancel it first.');
      return;
    }
    setMode('single');
    showBrandForm({ editing: true });
  });

  // React to tab changes — re-detect SERP when user switches tabs.
  chrome.tabs.onActivated.addListener(() => detectSerp());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.url) {
      detectSerp();
    }
  });
}

async function detectSerp() {
  // Bulk mode runs on its own background tabs; ignore SERP changes in the
  // foreground tab while bulk is active or while bulk view is shown.
  if (state.mode === 'bulk') return;

  const tab = await getActiveSerpTab();
  if (!tab) {
    // Don't disrupt an active analysis or visible report when the user
    // momentarily switches to a non-SERP tab. Keep the prior tabId pinned
    // until they come back, OR we explicitly start a new run.
    if (!state.analyzing) {
      state.serpUrl = '';
      state.query = '';
      setText(els.queryLine, 'No SERP in active tab');
    }
    if (state.analyzing) return;       // analysis in flight — keep UI as-is
    if (state.report) return;          // results visible — don't replace
    state.tabId = null;
    if (state.modelAvailability === 'available' || state.modelAvailability === 'unknown') {
      showStateOnly('state-no-serp');
    }
    return;
  }
  state.tabId = tab.id;
  state.serpUrl = tab.url;
  state.query = deriveQueryFromUrl(tab.url);
  setText(els.queryLine, `Query: "${state.query || '(unknown)'}"`);

  if (state.analyzing) return;         // analysis in flight — don't touch state cards
  if (state.report) return;            // results visible — leave them alone

  if (state.modelAvailability === 'available') {
    if (state.brandContext) {
      showStateOnly('state-ready');
    } else {
      showStateOnly('');
      showBrandForm({ editing: false });
    }
  }
}

async function init() {
  cacheEls();
  wire();

  state.brandContext = await loadBrandContext();
  if (state.brandContext) showBrandSummary();

  await refreshAvailability();
  await detectSerp();

  // If model is available and we have brand context, ensure brand form is hidden.
  if (state.modelAvailability === 'available' && state.brandContext) {
    hide(els.brandForm);
    showBrandSummary();
  } else if (state.modelAvailability === 'available' && !state.brandContext && state.tabId) {
    showBrandForm({ editing: false });
  }
}

init();
