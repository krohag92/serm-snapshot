// content/extractors/twitter-carousel.js
import {
  safeText,
  truncate,
  domainFromUrl,
  absUrl,
  positionOf,
  getOrderedResultContainers,
  runExtractor,
} from '../utils.js';

export const blockType = 'twitter-carousel';

const TWITTER_RE = /(?:^|\.)((?:twitter|x)\.com)$/i;

export function extract(doc = document) {
  return runExtractor(blockType, () => {
    const ordered = getOrderedResultContainers();

    // Find a top-of-page container that is dominated by twitter/x links.
    const candidates = doc.querySelectorAll('#search g-section-with-header, #search div[data-hveid]');
    let container = null;
    let containerLinks = [];
    for (const c of candidates) {
      const links = Array.from(c.querySelectorAll('a[href]'));
      const tw = links.filter((a) => TWITTER_RE.test(domainFromUrl(absUrl(a.getAttribute('href')))));
      if (tw.length >= 2) {
        container = c;
        containerLinks = tw;
        break;
      }
    }
    if (!container) return { found: false, data: [] };

    const position = positionOf(container, ordered) || 1;
    const baseY = container.getBoundingClientRect?.().top ?? 0;

    const seen = new Set();
    const data = [];
    for (const a of containerLinks) {
      const url = absUrl(a.getAttribute('href'));
      if (!url || seen.has(url)) continue;
      seen.add(url);

      const card = a.closest('g-inner-card') || a.closest('[role="link"]') || a.closest('div');
      const text = safeText(card);
      if (!text) continue;

      const m = url.match(/(?:twitter|x)\.com\/([^/]+)/i);
      const author = m ? `@${m[1]}` : undefined;

      data.push({
        blockType,
        position,
        text: truncate(text),
        author,
        sourceUrl: url,
        sourceDomain: domainFromUrl(url),
        _yPos: baseY,
      });
    }

    if (!data.length) return { found: false, data: [] };
    return { found: true, data };
  });
}
