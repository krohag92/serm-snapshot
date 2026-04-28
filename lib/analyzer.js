// lib/analyzer.js — aggregation logic and Reputation Score.
// Pure deterministic functions; no model calls.

const SENTIMENT_WEIGHTS = {
  positive: 1.0,
  neutral: 0.5,
  mixed: 0.25,
  negative: 0.0,
};

const OWNED_BONUS = 0.2;

const NON_ORGANIC_POSITION_WEIGHT = {
  'ai-overview': 1.0,
  'knowledge-panel': 1.0,
  'featured-snippet': 0.9,
  'people-also-ask': 0.6,
};
const NON_ORGANIC_DEFAULT = 0.8;

function organicPositionWeight(pos) {
  if (pos >= 1 && pos <= 3) return 1.0;
  if (pos >= 4 && pos <= 6) return 0.7;
  if (pos >= 7 && pos <= 10) return 0.5;
  return 0.5;
}

export function positionWeight(block) {
  if (block.blockType === 'organic') return organicPositionWeight(block.position);
  return NON_ORGANIC_POSITION_WEIGHT[block.blockType] ?? NON_ORGANIC_DEFAULT;
}

// Normalize a domain or social handle for comparison.
function normalizeDomain(s) {
  if (!s) return '';
  return String(s).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

function normalizeHandle(s) {
  if (!s) return '';
  return String(s).trim().toLowerCase().replace(/^@+/, '');
}

export function isOwnedBlock(block, brandContext) {
  const domains = (brandContext.officialDomains || []).map(normalizeDomain).filter(Boolean);
  const handles = (brandContext.socialHandles || []).map(normalizeHandle).filter(Boolean);

  const sourceDomain = normalizeDomain(block.sourceDomain);
  const sourceUrl = (block.sourceUrl || '').toLowerCase();

  for (const d of domains) {
    if (!d) continue;
    if (sourceDomain === d) return true;
    if (sourceDomain.endsWith('.' + d)) return true;
    if (sourceUrl.includes('//' + d) || sourceUrl.includes('//www.' + d)) return true;
  }

  for (const h of handles) {
    if (!h) continue;
    if (sourceUrl.includes(h)) return true;
    if (block.author && normalizeHandle(block.author) === h) return true;
  }

  return false;
}

export function deriveOwnership(block, analysis, brandContext) {
  if (isOwnedBlock(block, brandContext)) return 'owned';
  if (analysis?.sentiment === 'positive') return 'earned';
  return 'third-party';
}

// Per-block enrichment merging extractor data + model analysis + deterministic ownership.
export function enrichBlock(block, analysis, brandContext) {
  const safeAnalysis = analysis || {
    sentiment: 'neutral',
    brandVisibility: 'none',
    relevance: 'on-topic',
    risk: { flag: false, reasons: [] },
    ownership: 'third-party',
    oneLineSummary: '(analysis failed)',
  };
  const ownership = deriveOwnership(block, analysis, brandContext);

  return {
    blockType: block.blockType,
    position: block.position,
    sourceDomain: block.sourceDomain,
    sourceUrl: block.sourceUrl,
    sourceTitle: block.sourceTitle,
    text: block.text,
    sentiment: safeAnalysis.sentiment,
    brandVisibility: safeAnalysis.brandVisibility,
    relevance: safeAnalysis.relevance,
    risk: safeAnalysis.risk,
    ownership,
    oneLineSummary: safeAnalysis.oneLineSummary,
    analysisFailed: !analysis,
  };
}

export function computeBlockScore(enriched) {
  const w = SENTIMENT_WEIGHTS[enriched.sentiment] ?? SENTIMENT_WEIGHTS.neutral;
  const bonus = enriched.ownership === 'owned' ? OWNED_BONUS : 0;
  return Math.min(1.0, w + bonus);
}

export function computeReputationScore(enrichedBlocks) {
  const usable = enrichedBlocks.filter((b) => !b.analysisFailed && b.relevance !== 'off-topic');
  if (!usable.length) return 0;

  let weighted = 0;
  let totalWeight = 0;
  for (const b of usable) {
    const pw = positionWeight(b);
    weighted += computeBlockScore(b) * pw;
    totalWeight += pw;
  }
  if (totalWeight === 0) return 0;
  return Math.round((weighted / totalWeight) * 100);
}

export function sentimentBreakdown(enrichedBlocks) {
  const counts = { positive: 0, neutral: 0, mixed: 0, negative: 0 };
  for (const b of enrichedBlocks) {
    if (b.relevance === 'off-topic') continue;
    if (b.analysisFailed) continue;
    if (counts[b.sentiment] !== undefined) counts[b.sentiment] += 1;
  }
  const total = counts.positive + counts.neutral + counts.mixed + counts.negative;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return {
    counts,
    percentages: {
      positive: pct(counts.positive),
      neutral: pct(counts.neutral),
      mixed: pct(counts.mixed),
      negative: pct(counts.negative),
    },
    total,
  };
}

export function topRisks(enrichedBlocks, limit = 3) {
  return enrichedBlocks
    .filter((b) => b.risk?.flag)
    .sort((a, b) => a.position - b.position)
    .slice(0, limit);
}

export function brandControlBreakdown(enrichedBlocks) {
  const buckets = {
    owned: 0,
    earnedPositive: 0,
    thirdPartyNeutral: 0,
    thirdPartyNegative: 0,
  };
  for (const b of enrichedBlocks) {
    if (b.relevance === 'off-topic' || b.analysisFailed) continue;
    if (b.ownership === 'owned') {
      buckets.owned += 1;
    } else if (b.ownership === 'earned') {
      buckets.earnedPositive += 1;
    } else if (b.sentiment === 'negative' || b.sentiment === 'mixed') {
      buckets.thirdPartyNegative += 1;
    } else {
      buckets.thirdPartyNeutral += 1;
    }
  }
  return buckets;
}

/**
 * Build the full report.
 * @param {Object} args
 * @param {Object} args.extraction - { url, query, extractedAt, summary, blocks }
 * @param {Array} args.analyses - parallel array of model analyses (or null)
 * @param {Object} args.brandContext
 * @param {Array<{index:number, reason:string}>} [args.failures]
 */
export function buildReport({ extraction, analyses, brandContext, failures = [] }) {
  const enriched = extraction.blocks.map((b, i) => enrichBlock(b, analyses[i], brandContext));
  const score = computeReputationScore(enriched);
  const sentiment = sentimentBreakdown(enriched);
  const risks = topRisks(enriched, 3);
  const control = brandControlBreakdown(enriched);

  const analyzedCount = enriched.filter((b) => !b.analysisFailed).length;
  const skippedCount = enriched.length - analyzedCount;

  return {
    id: cryptoRandomId(),
    query: extraction.query,
    url: extraction.url,
    timestamp: extraction.extractedAt || Date.now(),
    brandContext,
    score,
    sentiment,
    risks,
    control,
    blocks: enriched,
    summary: extraction.summary,
    counts: {
      total: enriched.length,
      analyzed: analyzedCount,
      skipped: skippedCount,
    },
    failures,
  };
}

function cryptoRandomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
}
