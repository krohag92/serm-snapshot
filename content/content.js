// content/content.js — extraction orchestrator.
// Runs all extractors in parallel via Promise.allSettled. One broken extractor
// must never break the whole snapshot.

const EXTRACTOR_FILES = [
  'content/extractors/ai-overview.js',
  'content/extractors/knowledge-panel.js',
  'content/extractors/featured-snippet.js',
  'content/extractors/people-also-ask.js',
  'content/extractors/organic.js',
  'content/extractors/twitter-carousel.js',
  'content/extractors/reddit-carousel.js',
  'content/extractors/news-carousel.js',
  'content/extractors/video-carousel.js',
  'content/extractors/reviews-snippet.js',
];

const MSG_RUN_EXTRACTION = 'serm:runExtraction';
const MSG_PING = 'serm:ping';

let extractorsPromise = null;

function loadExtractors() {
  if (!extractorsPromise) {
    extractorsPromise = Promise.all(
      EXTRACTOR_FILES.map((path) =>
        import(chrome.runtime.getURL(path)).catch((err) => {
          console.warn(`[serm-snapshot] failed to load ${path}`, err);
          return null;
        })
      )
    );
  }
  return extractorsPromise;
}

function deriveQuery() {
  try {
    const params = new URLSearchParams(location.search);
    return params.get('q') || '';
  } catch {
    return '';
  }
}

async function runExtraction() {
  const modules = await loadExtractors();
  const settled = await Promise.allSettled(
    modules.map((m) => {
      if (!m || typeof m.extract !== 'function') {
        return Promise.resolve({ blockType: m?.blockType || 'unknown', found: false, data: [] });
      }
      try {
        return Promise.resolve(m.extract(document));
      } catch (err) {
        console.warn('[serm-snapshot] extractor threw synchronously', err);
        return Promise.resolve({ blockType: m.blockType, found: false, data: [] });
      }
    })
  );

  const results = settled.map((s, i) => {
    if (s.status === 'fulfilled' && s.value) return s.value;
    return { blockType: modules[i]?.blockType || 'unknown', found: false, data: [] };
  });

  const collected = [];
  const summary = {};
  for (const r of results) {
    summary[r.blockType] = r.found ? r.data.length : 0;
    if (r.found) {
      for (const b of r.data) {
        collected.push({ ...b, blockType: b.blockType || r.blockType });
      }
    }
  }

  // Dedup by sourceUrl. reviews-snippet is by design a sub-classification of
  // organic results (it's any organic that has a rating signal) — when the
  // same URL appears in both, keep the organic block and merge the rating
  // metadata into it. Same logic for any other accidental duplicates: prefer
  // the more specific block type, never reviews-snippet over an alternative.
  const groupsByUrl = new Map();
  const noUrl = [];
  for (const b of collected) {
    if (!b.sourceUrl) { noUrl.push(b); continue; }
    if (!groupsByUrl.has(b.sourceUrl)) groupsByUrl.set(b.sourceUrl, []);
    groupsByUrl.get(b.sourceUrl).push(b);
  }
  const allBlocks = [...noUrl];
  for (const group of groupsByUrl.values()) {
    const preferred =
      group.find((b) => b.blockType === 'organic') ||
      group.find((b) => b.blockType !== 'reviews-snippet') ||
      group[0];
    const ratingSrc = group.find((b) => b.blockType === 'reviews-snippet');
    if (ratingSrc && ratingSrc !== preferred) {
      if (ratingSrc.rating != null) preferred.rating = ratingSrc.rating;
      if (ratingSrc.reviewCount != null) preferred.reviewCount = ratingSrc.reviewCount;
      if (ratingSrc.ratingSource) preferred.ratingSource = ratingSrc.ratingSource;
    }
    allBlocks.push(preferred);
  }

  // Sort blocks by their on-screen Y position (top of page first), with
  // insertion order as a tiebreaker. `_yPos` is set by extractors from
  // getBoundingClientRect; non-zero values reflect real DOM order.
  allBlocks.forEach((b, i) => (b._order = i));
  allBlocks.sort((a, b) => {
    const ay = Number.isFinite(a._yPos) ? a._yPos : 0;
    const by = Number.isFinite(b._yPos) ? b._yPos : 0;
    if (ay !== by) return ay - by;
    return a._order - b._order;
  });
  for (const b of allBlocks) {
    delete b._order;
    delete b._yPos;
  }

  return {
    url: location.href,
    query: deriveQuery(),
    extractedAt: Date.now(),
    summary,
    blocks: allBlocks,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === MSG_PING) {
    sendResponse({ ok: true, url: location.href });
    return false;
  }

  if (msg.type === MSG_RUN_EXTRACTION) {
    runExtraction()
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((err) => {
        console.error('[serm-snapshot] extraction failed', err);
        sendResponse({ ok: false, error: String(err && err.message || err) });
      });
    return true; // async
  }

  return false;
});
