// lib/bulk-runner.js — runs a list of queries sequentially:
// open background tab → wait for load → extract → analyze → build report → close tab.
//
// Sequential by design: Gemini Nano cannot parallelize without competing for
// the same GPU/CPU resources. Cancellation supported via AbortController.

import { MSG } from './messages.js';
import { analyzeBlocks } from './prompt-runner.js';
import { buildReport } from './analyzer.js';

const TAB_LOAD_TIMEOUT_MS = 30000;
const POST_LOAD_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function checkAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
}

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
  try {
    const r = await sendToTab(tabId, { type: MSG.PING });
    if (r && r.ok) return true;
  } catch {
    // fall through
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    return true;
  } catch (err) {
    console.error('[serm-snapshot] failed to inject content script', err);
    return false;
  }
}

function waitForTabComplete(tabId, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));

    let settled = false;
    const cleanup = () => {
      settled = true;
      chrome.tabs.onUpdated.removeListener(updateListener);
      chrome.tabs.onRemoved.removeListener(removeListener);
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abortListener);
    };

    const updateListener = (id, changeInfo) => {
      if (settled || id !== tabId) return;
      if (changeInfo.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    const removeListener = (id) => {
      if (settled || id !== tabId) return;
      cleanup();
      reject(new Error('tab closed before load'));
    };
    const abortListener = () => {
      if (settled) return;
      cleanup();
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('tab load timeout'));
    }, TAB_LOAD_TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(updateListener);
    chrome.tabs.onRemoved.addListener(removeListener);
    signal?.addEventListener?.('abort', abortListener);
  });
}

function toModelBlock(b) {
  return {
    blockType: b.blockType,
    position: b.position,
    text: b.text,
    ...(b.sourceDomain ? { sourceDomain: b.sourceDomain } : {}),
    ...(b.sourceUrl ? { sourceUrl: b.sourceUrl } : {}),
    ...(b.sourceTitle ? { sourceTitle: b.sourceTitle } : {}),
  };
}

async function runOneQuery({ query, brandContext, signal, onProgress }) {
  const url = makeSearchUrl(query);
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    checkAborted(signal);

    onProgress?.({ stage: 'loading-tab' });
    await waitForTabComplete(tab.id, signal);
    checkAborted(signal);

    onProgress?.({ stage: 'rendering' });
    await sleep(POST_LOAD_DELAY_MS);
    checkAborted(signal);

    const ok = await ensureContentScript(tab.id);
    if (!ok) throw new Error('content script failed to load');
    checkAborted(signal);

    onProgress?.({ stage: 'extracting' });
    const resp = await sendToTab(tab.id, { type: MSG.RUN_EXTRACTION });
    if (!resp || !resp.ok) {
      throw new Error(resp?.error || 'extraction failed');
    }
    const extraction = resp.payload;
    if (!extraction.blocks?.length) throw new Error('no blocks extracted');

    onProgress?.({ stage: 'analyzing', totalBlocks: extraction.blocks.length });
    const modelBlocks = extraction.blocks.map(toModelBlock);

    const { analyses, failures } = await analyzeBlocks({
      blocks: modelBlocks,
      brandContext,
      onProgress: (info) => {
        if (info.stage === 'prompting') {
          onProgress?.({
            stage: 'analyzing',
            totalBlocks: extraction.blocks.length,
            batchIndex: info.batchIndex,
            totalBatches: info.totalBatches,
          });
        } else if (info.stage === 'creating-session' || info.stage === 'rotating-session') {
          onProgress?.({ stage: info.stage });
        }
      },
    });
    checkAborted(signal);

    return buildReport({ extraction, analyses, brandContext, failures });
  } finally {
    if (tab?.id != null) {
      try { await chrome.tabs.remove(tab.id); } catch { /* ignore */ }
    }
  }
}

/**
 * Run bulk analysis sequentially.
 * @param {Object} args
 * @param {string[]} args.queries - one query per item
 * @param {Object} args.brandContext
 * @param {AbortSignal} [args.signal]
 * @param {(info:{stage:string, queryIndex:number, totalQueries:number, query:string,
 *            batchIndex?:number, totalBatches?:number, totalBlocks?:number}) => void} [args.onProgress]
 * @param {(info:{queryIndex:number, query:string, report?:Object, error?:string}) => void} [args.onResult]
 * @returns {Promise<{ results: Object[], failures: { queryIndex:number, query:string, reason:string }[] }>}
 */
export async function runBulk({ queries, brandContext, signal, onProgress, onResult }) {
  const results = [];
  const failures = [];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    if (signal?.aborted) break;

    onProgress?.({ stage: 'starting-query', queryIndex: i, totalQueries: queries.length, query });

    try {
      const report = await runOneQuery({
        query,
        brandContext,
        signal,
        onProgress: (info) =>
          onProgress?.({ ...info, queryIndex: i, totalQueries: queries.length, query }),
      });
      results.push(report);
      onResult?.({ queryIndex: i, query, report });
    } catch (err) {
      if (err?.name === 'AbortError' || /aborted/i.test(err?.message || '')) {
        // Mark as aborted but stop the loop.
        failures.push({ queryIndex: i, query, reason: 'aborted' });
        onResult?.({ queryIndex: i, query, error: 'aborted' });
        break;
      }
      const reason = err?.message || String(err);
      console.warn('[serm-snapshot] bulk query failed', query, reason);
      failures.push({ queryIndex: i, query, reason });
      onResult?.({ queryIndex: i, query, error: reason });
      // Continue to the next query — one failure shouldn't kill the run.
    }
  }

  return { results, failures };
}
