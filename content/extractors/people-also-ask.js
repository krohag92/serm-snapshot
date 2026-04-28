// content/extractors/people-also-ask.js
//
// Captures PAA questions only. Per spec, expanded answers may not be in the DOM
// until clicked — capturing the question alone is enough. We deliberately avoid
// pulling answer text or source links from outside the PAA item's own region,
// because nearby featured-snippet content otherwise leaks in.

import {
  safeText,
  truncate,
  domainFromUrl,
  absUrl,
  runExtractor,
} from '../utils.js';

export const blockType = 'people-also-ask';

const ITEM_SELECTORS = [
  'div[jsname="N760b"]',
  '.related-question-pair',
  '[data-initq]',
  'div[jsname="Cpkphb"]',
  'div[jsname="yEVEwb"]',
];

function getQueryFromLocation() {
  try {
    return (new URLSearchParams(location.search).get('q') || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function isPlausibleQuestion(q, searchQuery) {
  if (!q) return false;
  const t = q.trim();
  if (t.length < 8) return false;              // too short to be a real question
  if (t.length > 200) return false;
  if (!/\s/.test(t)) return false;             // single token — almost always a query echo
  if (searchQuery && t.toLowerCase() === searchQuery) return false;
  return true;
}

function readQuestion(item) {
  const fromAttr = item.getAttribute?.('data-q') || item.getAttribute?.('data-initq');
  if (fromAttr) return fromAttr.trim();
  const heading = safeText(item.querySelector('[role="heading"]'));
  if (heading) return heading;
  return safeText(item.querySelector('span'));
}

export function extract(doc = document) {
  return runExtractor(blockType, () => {
    // Prefer the explicit PAA wholepage scope; fall back to the whole document
    // if Google has restructured it.
    const scope = doc.querySelector('#paa-wholepage') || doc;

    const seenItems = new Set();
    const items = [];
    for (const sel of ITEM_SELECTORS) {
      let nodes;
      try { nodes = scope.querySelectorAll(sel); } catch { continue; }
      for (const n of nodes) {
        if (seenItems.has(n)) continue;
        seenItems.add(n);
        items.push(n);
      }
    }
    if (!items.length) return { found: false, data: [] };

    const searchQuery = getQueryFromLocation();
    const seenQuestions = new Set();
    const data = [];

    items.forEach((item, idx) => {
      const question = readQuestion(item);
      if (!isPlausibleQuestion(question, searchQuery)) return;
      const key = question.toLowerCase();
      if (seenQuestions.has(key)) return;
      seenQuestions.add(key);

      // Source link: ONLY inside this item's expanded region, never from the
      // surrounding DOM (otherwise we leak in featured-snippet links).
      const region = item.querySelector('[role="region"], div[jsname="Q5gqzc"]');
      const linkEl = region?.querySelector(
        'a[href^="http"]:not([href*="google.com/search"])'
      ) || null;

      const sourceUrl = absUrl(linkEl?.getAttribute('href'));
      const sourceTitle = safeText(linkEl?.querySelector('h3') || linkEl);

      // Expanded answer: only the region's own text, never a sibling/parent fallback.
      const expandedAnswer = region ? safeText(region) : '';
      const text = expandedAnswer
        ? `Q: ${question}\nA: ${expandedAnswer}`
        : `Q: ${question}`;

      data.push({
        blockType,
        position: idx + 1,
        text: truncate(text),
        question,
        expandedAnswer: expandedAnswer || undefined,
        sourceUrl: sourceUrl || undefined,
        sourceTitle: sourceTitle || undefined,
        sourceDomain: sourceUrl ? domainFromUrl(sourceUrl) : undefined,
        _yPos: item.getBoundingClientRect?.().top ?? 0,
      });
    });

    if (!data.length) return { found: false, data: [] };
    return { found: true, data };
  });
}
