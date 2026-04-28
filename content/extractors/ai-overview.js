// content/extractors/ai-overview.js
import {
  safeText,
  truncate,
  domainFromUrl,
  absUrl,
  pickFirst,
  positionOf,
  getOrderedResultContainers,
  runExtractor,
} from '../utils.js';

export const blockType = 'ai-overview';

const SELECTORS = [
  '[data-attrid*="GenerativeAI"]',
  'div[jsname][data-rl]',
  'div[data-subtree="aio"]',
  'div[aria-label*="AI Overview" i]',
];

export function extract(doc = document) {
  return runExtractor(blockType, () => {
    const ordered = getOrderedResultContainers();

    let container = pickFirst(doc, SELECTORS);

    // Heuristic fallback: find a top-of-results block whose text contains
    // multiple inline citation markers ("[1]", "[2]") and reads like a synthesis.
    if (!container) {
      const candidates = doc.querySelectorAll('#search div[data-hveid]');
      for (const c of candidates) {
        const t = safeText(c);
        if (t.length > 200 && /\[\s*\d+\s*\]/.test(t) && /\[\s*\d+\s*\].*\[\s*\d+\s*\]/.test(t)) {
          container = c;
          break;
        }
      }
    }

    if (!container) return { found: false, data: [] };

    const text = safeText(container);
    if (!text) return { found: false, data: [] };

    const linkEls = Array.from(container.querySelectorAll('a[href]'));
    const citedUrls = [];
    const citedDomains = [];
    const seenDomains = new Set();
    for (const a of linkEls) {
      const href = absUrl(a.getAttribute('href'));
      if (!href || href.startsWith('javascript:')) continue;
      if (href.includes('google.com/search')) continue;
      citedUrls.push(href);
      const d = domainFromUrl(href);
      if (d && !seenDomains.has(d)) {
        seenDomains.add(d);
        citedDomains.push(d);
      }
    }

    const position = positionOf(container, ordered) || 1;

    return {
      found: true,
      data: [
        {
          blockType,
          position,
          text: truncate(text),
          citedUrls,
          citedDomains,
          _yPos: container.getBoundingClientRect?.().top ?? 0,
        },
      ],
    };
  });
}
