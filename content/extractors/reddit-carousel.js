// content/extractors/reddit-carousel.js
//
// Detects ONLY the explicit "Discussions and forums" carousel, not regular
// Reddit organic results that happen to have multiple sublinks. The previous
// "≥2 forum links in a hveid block" fallback caused false positives on any
// Reddit organic result with sitelinks.

import {
  safeText,
  truncate,
  domainFromUrl,
  absUrl,
  runExtractor,
} from '../utils.js';

export const blockType = 'reddit-carousel';

const FORUM_RE = /(?:^|\.)((?:reddit\.com|quora\.com|.*\.stackexchange\.com|stackoverflow\.com|news\.ycombinator\.com))$/i;

function isDiscussionsHeading(text) {
  return /discussions?\s*(and|&)?\s*forums?/i.test(text || '');
}

export function extract(doc = document) {
  return runExtractor(blockType, () => {
    // Find a top-level section whose header literally says "Discussions and forums".
    const sections = doc.querySelectorAll(
      '#search g-section-with-header, #search div[aria-label*="discussions" i], #search div[role="heading"]'
    );

    let container = null;
    for (const s of sections) {
      const headingText =
        safeText(s.querySelector('h2, h3, [role="heading"]')) ||
        s.getAttribute?.('aria-label') ||
        safeText(s);
      if (isDiscussionsHeading(headingText)) {
        // If we matched a heading element, climb to its section.
        container = s.closest('g-section-with-header, div[data-hveid]') || s;
        break;
      }
    }

    if (!container) return { found: false, data: [] };

    // Collect distinct forum threads inside the carousel, skipping
    // text-fragment URLs (#:~:text=...) which are duplicates of the parent.
    const links = Array.from(container.querySelectorAll('a[href]')).filter((a) => {
      const url = absUrl(a.getAttribute('href'));
      if (!url) return false;
      if (url.includes('#:~:text=')) return false;
      return FORUM_RE.test(domainFromUrl(url));
    });

    const baseY = container.getBoundingClientRect?.().top ?? 0;

    const seen = new Set();
    const data = [];
    for (const a of links) {
      const url = absUrl(a.getAttribute('href'));
      const canonical = url.split('#')[0];
      if (seen.has(canonical)) continue;
      seen.add(canonical);

      const card = a.closest('g-inner-card') || a.closest('[data-hveid]') || a.closest('div');
      const title = safeText(
        card?.querySelector('h3, [role="heading"], div[style*="webkit-line-clamp"]')
      );
      const text = safeText(card) || title;

      const domain = domainFromUrl(url);
      let forum = '';
      if (domain.includes('reddit.com')) {
        const m = url.match(/reddit\.com\/r\/([^/]+)/i);
        if (m) forum = `r/${m[1]}`;
      } else {
        forum = domain;
      }

      data.push({
        blockType,
        position: 1,
        text: truncate(text),
        title: title || undefined,
        forum: forum || undefined,
        sourceUrl: url,
        sourceDomain: domain,
        sourceTitle: title || undefined,
        _yPos: baseY,
      });
    }

    if (!data.length) return { found: false, data: [] };
    return { found: true, data };
  });
}
