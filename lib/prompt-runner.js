// lib/prompt-runner.js — wraps Chrome's Built-in Prompt API (LanguageModel).
//
// Responsibilities:
//   - availability check
//   - session creation (with optional download monitor)
//   - per-batch prompt() with responseConstraint
//   - context-window awareness (recreate session past 75%)
//   - QuotaExceededError → split-and-retry
//   - structured-response validation

import { buildSystemPrompt, buildBatchPrompt } from '../prompts/system.js';
import { batchAnalysisSchema, validateBatchResponse } from '../prompts/schemas.js';

const EXPECTED_INPUTS = [{ type: 'text', languages: ['en'] }];
const EXPECTED_OUTPUTS = [{ type: 'text', languages: ['en'] }];

const DEFAULT_BATCH_SIZE = 4;
const CONTEXT_USAGE_LIMIT = 0.75;

export async function checkAvailability() {
  if (typeof self === 'undefined' || typeof self.LanguageModel === 'undefined') {
    return 'unavailable';
  }
  try {
    return await self.LanguageModel.availability({
      expectedInputs: EXPECTED_INPUTS,
      expectedOutputs: EXPECTED_OUTPUTS,
    });
  } catch (err) {
    console.error('[serm-snapshot] availability check failed', err);
    return 'unavailable';
  }
}

async function createSession(brandContext, onDownloadProgress) {
  const opts = {
    initialPrompts: [
      { role: 'system', content: buildSystemPrompt(brandContext) },
    ],
    expectedInputs: EXPECTED_INPUTS,
    expectedOutputs: EXPECTED_OUTPUTS,
  };

  // Per Chrome docs: if exposed in this environment, prefer deterministic settings.
  try {
    const params = await self.LanguageModel.params?.();
    if (params && typeof params === 'object') {
      opts.temperature = 0.3;
      opts.topK = 1;
    }
  } catch {
    // params() may not exist or may throw — silently ignore.
  }

  if (typeof onDownloadProgress === 'function') {
    opts.monitor = (m) => {
      m.addEventListener('downloadprogress', (e) => {
        try {
          onDownloadProgress(e.loaded);
        } catch (err) {
          console.warn('[serm-snapshot] downloadprogress handler threw', err);
        }
      });
    };
  }

  const session = await self.LanguageModel.create(opts);

  session.addEventListener?.('contextoverflow', () => {
    console.warn('[serm-snapshot] contextoverflow event fired');
  });

  return session;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function estimateTokens(str) {
  return Math.ceil((str?.length || 0) / 4);
}

// Try to parse the model's output as JSON; if a `responseConstraint` was honored
// the output should already be valid JSON, but be defensive.
function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    // Find the first '[' or '{' and the matching last ']'/'}'.
    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket >= 0 && lastBracket > firstBracket) {
      try {
        return JSON.parse(text.slice(firstBracket, lastBracket + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function promptBatch(session, batch) {
  const userPrompt = buildBatchPrompt(batch);
  const text = await session.prompt(userPrompt, {
    responseConstraint: batchAnalysisSchema,
  });
  const parsed = parseJsonLoose(text);
  if (!validateBatchResponse(parsed, batch.length)) {
    throw new Error('Model returned invalid or malformed batch response');
  }
  return parsed;
}

// Run a single batch with quota-aware split-and-retry.
async function runBatchWithRetry(session, batch) {
  try {
    return await promptBatch(session, batch);
  } catch (err) {
    const name = err?.name || '';
    if (name === 'QuotaExceededError' && batch.length > 1) {
      console.warn('[serm-snapshot] QuotaExceededError, splitting batch', batch.length);
      const mid = Math.floor(batch.length / 2);
      const left = await runBatchWithRetry(session, batch.slice(0, mid));
      const right = await runBatchWithRetry(session, batch.slice(mid));
      return left.concat(right);
    }
    throw err;
  }
}

/**
 * Analyze blocks in batches.
 * @param {Object} args
 * @param {Array} args.blocks - model-shape blocks
 * @param {Object} args.brandContext - { brandName, brandDescription, officialDomains, socialHandles }
 * @param {number} [args.batchSize]
 * @param {(info:{stage:string,batchIndex?:number,totalBatches?:number,detail?:string}) => void} [args.onProgress]
 * @param {(loaded:number) => void} [args.onDownloadProgress]
 * @returns {Promise<{ analyses: (Object|null)[], failures: { index:number, reason:string }[] }>}
 *   analyses[i] is the analysis for blocks[i], or null on failure.
 */
export async function analyzeBlocks({
  blocks,
  brandContext,
  batchSize = DEFAULT_BATCH_SIZE,
  onProgress,
  onDownloadProgress,
}) {
  const analyses = new Array(blocks.length).fill(null);
  const failures = [];

  if (!blocks.length) return { analyses, failures };

  onProgress?.({ stage: 'creating-session' });
  let session = await createSession(brandContext, onDownloadProgress);

  const batches = chunk(blocks, batchSize);
  let cursor = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    onProgress?.({ stage: 'prompting', batchIndex: i + 1, totalBatches: batches.length });

    // Token-aware pre-split: if estimated input is more than 50% of context window, split.
    const estIn = estimateTokens(buildBatchPrompt(batch));
    const ctxWindow = session.contextWindow ?? Infinity;
    if (Number.isFinite(ctxWindow) && estIn > ctxWindow * 0.5 && batch.length > 1) {
      const mid = Math.floor(batch.length / 2);
      batches.splice(i, 1, batch.slice(0, mid), batch.slice(mid));
      i--; // re-process this index with the smaller batch
      continue;
    }

    try {
      const result = await runBatchWithRetry(session, batch);
      for (let j = 0; j < batch.length; j++) {
        analyses[cursor + j] = result[j] || null;
        if (!result[j]) {
          failures.push({ index: cursor + j, reason: 'missing-from-response' });
        }
      }
    } catch (err) {
      console.error('[serm-snapshot] batch failed', err);
      const reason = err?.name === 'NotSupportedError'
        ? 'not-supported'
        : (err?.message || 'unknown-error');
      for (let j = 0; j < batch.length; j++) {
        failures.push({ index: cursor + j, reason });
      }
    }

    cursor += batch.length;

    // Recreate session if context usage is past the limit.
    try {
      const used = session.contextUsage ?? 0;
      const window = session.contextWindow ?? 0;
      if (window > 0) {
        const usage = used / window;
        console.debug(`[serm-snapshot] context usage ${used}/${window} (${(usage * 100).toFixed(1)}%)`);
        if (usage > CONTEXT_USAGE_LIMIT && i < batches.length - 1) {
          onProgress?.({ stage: 'rotating-session' });
          try { session.destroy?.(); } catch {}
          session = await createSession(brandContext, onDownloadProgress);
        }
      }
    } catch {
      // contextUsage / contextWindow may not be present in all builds.
    }
  }

  try { session.destroy?.(); } catch {}

  return { analyses, failures };
}
